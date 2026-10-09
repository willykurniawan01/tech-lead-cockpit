import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiSelection } from '../../src/lib/ai/types.ts';
import type { Trace, TraceEvidence, TraceTurn } from '../../src/lib/trace/types.ts';
import { buildTracePrompt, parseTraceReply } from './prompt.ts';
import { repoVersions, verifyEvidence } from './verify.ts';
import { DATA_DIR } from '../paths.ts';

/**
 * Code traces under ~/.tech-lead-cockpit/traces (0700), one JSON file per trace. A question
 * runs as a background job: the AI reads the Services codebase read-only (checked for changes),
 * its JSON answer is parsed, its evidence verified against the real files, and the turn is
 * saved. Every turn is mirrored into Agent Tasks through `sink`.
 */

const ID = /^[A-Za-z0-9-]{1,64}$/;
const TIMEOUT_MS = 15 * 60_000;
const SYNC_EVERY_MS = 5_000;
export const MAX_QUESTION = 8_000;

export class TraceInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface TraceDeps {
  dir?: string;
  runAi: (
    ai: AiSelection,
    prompt: string,
    opts: { cwd: string; timeoutMs: number; readOnlyDirs: string[]; onProgress: (text: string) => void },
  ) => { done: Promise<{ reply: string; error?: string }>; cancel: () => void };
  resolveServicesRoot: (input: string) => Promise<string>;
  watchRepos?: (root: string) => Promise<() => Promise<string[]>>;
  /** Mirrors a turn into Agent Tasks; returns the agent task id it is listed under. */
  sink?: (trace: Trace, turn: TraceTurn) => Promise<string | undefined>;
  verify?: (root: string, evidence: TraceEvidence[]) => Promise<TraceEvidence[]>;
  versions?: (root: string, repos: string[]) => Promise<{ repo: string; branch: string; commit: string }[]>;
}

interface LiveJob {
  traceId: string;
  turnId: string;
  progress?: string;
  cancel?: () => void;
  cancelled?: boolean;
}

const titleOf = (question: string) => question.split('\n').find((l) => l.trim())?.trim().slice(0, 80) ?? 'Trace';

export class TraceManager {
  private readonly dir: string;
  private readonly live = new Map<string, LiveJob>();

  constructor(private readonly deps: TraceDeps) {
    this.dir = deps.dir ?? join(DATA_DIR, 'traces');
  }

  isBusy(): boolean {
    return this.live.size > 0;
  }

  private file(id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new TraceInputError('Id trace tidak valid.');
    return join(this.dir, `${id}.json`);
  }

  private async save(t: Trace): Promise<Trace> {
    t.updatedAt = new Date().toISOString();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Atomic: a reader polling while a turn finishes never sees a half-written file.
    const file = this.file(t.id);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
    await rename(tmp, file);
    return t;
  }

  private async read(id: string): Promise<Trace> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as Trace;
    } catch (e) {
      if (e instanceof TraceInputError) throw e;
      throw new TraceInputError('Trace tidak ditemukan.', 404);
    }
  }

  /** The saved trace plus live progress; a turn left running by a restart is closed as failed. */
  async get(id: string): Promise<Trace> {
    const t = await this.read(id);
    const job = this.live.get(t.id);
    let stale = false;
    for (const turn of t.turns) {
      if (turn.status !== 'running') continue;
      if (job?.turnId === turn.id) turn.progress = job.progress ?? turn.progress;
      else {
        turn.status = 'error';
        turn.error = 'Terhenti karena connector dimulai ulang. Tanyakan lagi untuk menjalankan ulang.';
        stale = true;
      }
    }
    if (stale) {
      await this.save(t);
      for (const turn of t.turns.filter((x) => x.error?.startsWith('Terhenti karena connector'))) await this.sync(t, turn);
    }
    return t;
  }

  async list(): Promise<Trace[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const all = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => this.get(n.slice(0, -5)).catch(() => null)));
    return all.filter((t): t is Trace => Boolean(t)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async remove(id: string): Promise<void> {
    if (this.live.has(id)) throw new TraceInputError('Trace masih berjalan; batalkan dulu.', 409);
    await rm(this.file(id), { force: true });
  }

  private async sync(t: Trace, turn: TraceTurn) {
    if (!this.deps.sink) return;
    const id = await this.deps.sink(t, turn).catch(() => undefined);
    if (id && id !== turn.agentTaskId) {
      turn.agentTaskId = id;
      const fresh = await this.read(t.id).catch(() => null);
      const saved = fresh?.turns.find((x) => x.id === turn.id);
      if (fresh && saved) {
        saved.agentTaskId = id;
        await this.save(fresh);
      }
    }
  }

  /** Starts a new trace, or a follow-up question in an existing one; runs in the background. */
  async ask(req: { traceId?: string; question: string; ai: AiSelection; servicesRoot?: string }): Promise<Trace> {
    const question = String(req.question ?? '').replace(/\u0000/g, '').trim();
    if (!question) throw new TraceInputError('Pertanyaan wajib diisi.');
    if (question.length > MAX_QUESTION) throw new TraceInputError(`Pertanyaan maksimal ${MAX_QUESTION} karakter.`);
    let root: string;
    try {
      root = await this.deps.resolveServicesRoot(req.servicesRoot ?? '');
    } catch (e) {
      throw new TraceInputError((e as Error).message);
    }

    const now = new Date().toISOString();
    let t: Trace;
    if (req.traceId) {
      t = await this.get(req.traceId);
      if (this.live.has(t.id)) throw new TraceInputError('Trace ini masih berjalan; tunggu atau batalkan dulu.', 409);
    } else {
      t = { id: randomUUID(), title: titleOf(question), turns: [], createdAt: now, updatedAt: now };
    }
    const history = [...t.turns];
    const turn: TraceTurn = { id: randomUUID(), question, askedAt: now, ai: req.ai, status: 'running', progress: 'Menyiapkan…' };
    t.turns.push(turn);
    await this.save(t);
    const job: LiveJob = { traceId: t.id, turnId: turn.id, progress: turn.progress };
    this.live.set(t.id, job);
    await this.sync(t, turn);
    void this.run(t.id, turn.id, question, history, req.ai, root, job);
    return this.get(t.id);
  }

  private async run(traceId: string, turnId: string, question: string, history: TraceTurn[], ai: AiSelection, root: string, job: LiveJob) {
    const cwd = await mkdtemp(join(tmpdir(), 'tlc-trace-'));
    let lastSync = 0;
    let finished = false;
    // Progress updates and the final update go through one chain, so a late progress update can
    // never land after (and overwrite) the answer.
    let chain: Promise<unknown> = Promise.resolve();
    const queue = (fn: () => Promise<unknown>) => (chain = chain.then(fn).catch(() => {}));
    const finish = (patch: Partial<TraceTurn>) => {
      finished = true;
      return queue(async () => {
        const t = await this.read(traceId).catch(() => null);
        const turn = t?.turns.find((x) => x.id === turnId);
        if (!t || !turn) return;
        Object.assign(turn, patch, { progress: undefined, answeredAt: new Date().toISOString() });
        await this.save(t);
        await this.sync(t, turn);
      });
    };
    try {
      const prompt = buildTracePrompt(question, { servicesRoot: root, history });
      await writeFile(join(cwd, 'TRACE.md'), prompt);
      const changed = this.deps.watchRepos ? await this.deps.watchRepos(root).catch(() => undefined) : undefined;
      if (job.cancelled) return await finish({ status: 'cancelled', error: 'Dibatalkan.' });
      const run = this.deps.runAi(ai, prompt, {
        cwd,
        timeoutMs: TIMEOUT_MS,
        readOnlyDirs: [root],
        onProgress: (text) => {
          job.progress = text.slice(0, 200);
          if (Date.now() - lastSync < SYNC_EVERY_MS) return;
          lastSync = Date.now();
          void queue(async () => {
            if (finished) return;
            const t = await this.read(traceId);
            const turn = t.turns.find((x) => x.id === turnId);
            if (turn?.status === 'running') await this.sync(t, { ...turn, progress: job.progress });
          });
        },
      });
      job.cancel = run.cancel;
      const outcome = await run.done;
      if (job.cancelled) return await finish({ status: 'cancelled', error: 'Dibatalkan.' });
      if (outcome.error) throw new Error(outcome.error);
      let parsed: ReturnType<typeof parseTraceReply>;
      try {
        parsed = parseTraceReply(outcome.reply, root);
      } catch (e) {
        return await finish({ status: 'error', error: (e as Error).message, rawReply: outcome.reply.slice(0, 50_000) });
      }
      const evidence = await (this.deps.verify ?? verifyEvidence)(root, parsed.evidence);
      const repos = [...parsed.services, ...evidence.map((e) => e.file.split('/')[0])];
      const versions = await (this.deps.versions ?? repoVersions)(root, repos).catch(() => []);
      const touchedRepos = changed ? await changed().catch(() => undefined) : undefined;
      const { title: _title, ...answer } = parsed;
      await finish({ ...answer, evidence, versions, touchedRepos, status: 'done', error: undefined });
    } catch (e) {
      await finish(job.cancelled ? { status: 'cancelled', error: 'Dibatalkan.' } : { status: 'error', error: (e as Error).message });
    } finally {
      this.live.delete(traceId);
      void rm(cwd, { recursive: true, force: true });
    }
  }

  async cancel(traceId: string): Promise<Trace> {
    const t = await this.get(traceId);
    const job = this.live.get(t.id);
    if (job) {
      job.cancelled = true;
      job.cancel?.();
    }
    return t;
  }
}
