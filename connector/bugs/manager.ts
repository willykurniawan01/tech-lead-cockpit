import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiSelection } from '../../src/lib/ai/types.ts';
import { bugTicketTitle, profileForRepo, type BugAnalysis, type BugAnalyzeRequest, type BugCase, type BugCaseInput, type BugJob, type BugTask, type BugTaskProposal, type BugTaskStatus, type BugTicketRequest } from '../../src/lib/bugs/types.ts';
import { buildBugPrompt, parseBugReply } from './analysis.ts';
import { logExcerpt, redactLog } from './redact.ts';
import { DATA_DIR } from '../paths.ts';

/**
 * Bug cases under ~/.tech-lead-cockpit/bugs (0700): cases/<id>.json and logs/<id>/<file>.
 * Logs are stored as given (0600) and redacted only in the copy the AI reads. Flow: the case is
 * sent to the tracing agent (a background job; the codebase is read-only and checked for
 * changes), which writes the analysis and proposes fix tasks per service. Tickets and fixes are
 * per task and only possible once the analysis exists.
 */

const ID = /^[A-Za-z0-9-]{1,64}$/;
const LOG_NAME = /^[\w.() -]{1,100}$/;
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_CASE_LOG_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 15 * 60_000;

export class BugInputError extends Error {}

export interface BugDeps {
  dir?: string;
  runAi: (
    ai: AiSelection,
    prompt: string,
    opts: { cwd: string; timeoutMs: number; readOnlyDirs: string[]; onProgress: (text: string) => void },
  ) => { done: Promise<{ reply: string; error?: string }>; cancel: () => void };
  resolveServicesRoot: (input: string) => Promise<string>;
  /** Folder names in the Services root (to validate the AI's service names). */
  listServices: (root: string) => Promise<string[]>;
  watchRepos?: (root: string) => Promise<() => Promise<string[]>>;
  jira?: () => Promise<{ createIssue(i: { projectKey: string; issueType: string; summary: string; description: string; priority?: string }): Promise<{ key: string; url: string }> } | null>;
}

const clean = (v: unknown, max: number) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);

export function validateInput(raw: Partial<BugCaseInput>): BugCaseInput {
  const title = clean(raw.title, 200);
  if (!title) throw new BugInputError('Judul bug wajib diisi.');
  return {
    title,
    description: clean(raw.description, 20_000),
    steps: clean(raw.steps, 10_000),
    expected: clean(raw.expected, 5_000),
    actual: clean(raw.actual, 5_000),
    environment: clean(raw.environment, 200),
    serviceHint: clean(raw.serviceHint, 100),
  };
}

const TASK_EDITABLE = ['title', 'repo', 'profile', 'fixPlan', 'testPlan', 'jiraSummary', 'jiraDescription'] as const;

function cleanTask(raw: Partial<BugTaskProposal>, base?: BugTaskProposal): BugTaskProposal {
  const repo = clean(raw.repo ?? base?.repo, 100);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new BugInputError('Repo task harus nama folder service.');
  const title = clean(raw.title ?? base?.title, 160);
  if (!title) throw new BugInputError('Judul task wajib diisi.');
  const p = raw.profile ?? base?.profile;
  const profile = p === 'frontend' || p === 'backend' ? p : profileForRepo(repo);
  return {
    title,
    repo,
    profile,
    fixPlan: clean(raw.fixPlan ?? base?.fixPlan, 6_000),
    testPlan: clean(raw.testPlan ?? base?.testPlan, 4_000),
    // Ticket titles follow the team's task format; the service follows the repo if it changes.
    jiraSummary: bugTicketTitle(clean(raw.jiraSummary ?? base?.jiraSummary, 250) || title, repo, profile),
    jiraDescription: clean(raw.jiraDescription ?? base?.jiraDescription, 12_000),
  };
}

const newTask = (p: BugTaskProposal): BugTask => ({ ...p, id: randomUUID(), status: 'proposed', coderRunIds: [] });

/** Proposals of an analysis made before tasks existed: one task from its overall plan. */
function legacyProposals(a: BugAnalysis): BugTaskProposal[] {
  if (a.tasks?.length) return a.tasks;
  if (!a.repo) return [];
  return [{ title: a.jiraSummary || `Perbaikan di ${a.repo}`, repo: a.repo, profile: profileForRepo(a.repo), fixPlan: a.fixPlan, testPlan: a.testPlan, jiraSummary: a.jiraSummary, jiraDescription: a.jiraDescription }];
}

/** The case status follows its tasks once the analysis exists. */
function deriveStatus(c: BugCase): BugCase['status'] {
  if (c.status === 'analyzing') return 'analyzing';
  if (!c.analysis) return 'draft';
  const st = c.tasks.map((t) => t.status);
  if (st.length && st.every((x) => x === 'fixed')) return 'fixed';
  if (st.includes('fixing')) return 'fixing';
  if (st.includes('ticketed')) return 'ticketed';
  return 'analyzed';
}

export class BugManager {
  private readonly dir: string;
  private readonly jobs = new Map<string, BugJob & { cancel?: () => void }>();

  constructor(private readonly deps: BugDeps) {
    this.dir = deps.dir ?? join(DATA_DIR, 'bugs');
  }

  isBusy(): boolean {
    return [...this.jobs.values()].some((j) => j.status === 'running');
  }

  private id(id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new BugInputError('Id bug tidak valid.');
    return id;
  }

  private caseFile = (id: string) => join(this.dir, 'cases', `${this.id(id)}.json`);
  private logDir = (id: string) => join(this.dir, 'logs', this.id(id));

  private async save(c: BugCase): Promise<BugCase> {
    c.updatedAt = new Date().toISOString();
    await mkdir(join(this.dir, 'cases'), { recursive: true, mode: 0o700 });
    await writeFile(this.caseFile(c.id), JSON.stringify(c, null, 2), { mode: 0o600 });
    return c;
  }

  async list(): Promise<BugCase[]> {
    const names = await readdir(join(this.dir, 'cases')).catch(() => [] as string[]);
    const all = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => this.get(n.slice(0, -5)).catch(() => null)));
    return all.filter((c): c is BugCase => Boolean(c)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<BugCase> {
    let c: BugCase;
    try {
      c = JSON.parse(await readFile(this.caseFile(id), 'utf8')) as BugCase;
    } catch {
      throw new BugInputError('Kasus bug tidak ditemukan.');
    }
    return this.normalize(c);
  }

  /** Older cases (one ticket per case) get tasks; a trace cut off by a restart is released. */
  private normalize(c: BugCase): BugCase {
    if (!Array.isArray(c.tasks)) {
      c.tasks = c.analysis ? legacyProposals(c.analysis).map(newTask) : [];
      const first = c.tasks[0];
      if (first && c.jira) Object.assign(first, { jira: c.jira, status: 'ticketed' as BugTaskStatus });
      if (first && c.coderRunIds?.length) Object.assign(first, { coderRunIds: [...c.coderRunIds], status: c.status === 'fixed' ? 'fixed' : 'fixing' });
    }
    c.coderRunIds ??= [];
    // Proposals made before titles followed the task format get it too (tickets already filed keep theirs).
    for (const t of c.tasks) if (!t.jira) t.jiraSummary = bugTicketTitle(t.jiraSummary || t.title, t.repo, t.profile);
    if (c.status === 'analyzing' && ![...this.jobs.values()].some((j) => j.caseId === c.id && j.status === 'running')) c.status = c.analysis ? 'analyzed' : 'draft';
    if (c.status !== 'analyzing') c.status = deriveStatus(c);
    return c;
  }

  async create(raw: Partial<BugCaseInput>): Promise<BugCase> {
    const now = new Date().toISOString();
    return this.save({ id: randomUUID(), ...validateInput(raw), logs: [], status: 'draft', tasks: [], coderRunIds: [], createdAt: now, updatedAt: now });
  }

  async update(id: string, raw: Partial<BugCaseInput>): Promise<BugCase> {
    const c = await this.get(id);
    return this.save({ ...c, ...validateInput({ ...c, ...raw }) });
  }

  async remove(id: string): Promise<void> {
    // Its tracing goes too (stopped if still running), so Agent Tasks shows no orphan.
    for (const [jobId, j] of this.jobs) {
      if (j.caseId !== id) continue;
      if (j.status === 'running') {
        j.status = 'cancelled';
        j.cancel?.();
      }
      this.jobs.delete(jobId);
    }
    await rm(this.caseFile(id), { force: true });
    await rm(this.logDir(id), { recursive: true, force: true });
  }

  // Logs -----------------------------------------------------------------------------------

  async addLog(id: string, name: string, text: string): Promise<BugCase> {
    const c = await this.get(id);
    const base = clean(name, 100).replace(/[^\w.() -]+/g, '_') || `log-${Date.now()}.log`;
    const file = LOG_NAME.test(base) && !base.startsWith('.') ? base : `log-${Date.now()}.log`;
    const body = String(text ?? '').replace(/\u0000/g, '');
    const size = Buffer.byteLength(body);
    if (!size) throw new BugInputError('Log kosong.');
    if (size > MAX_LOG_BYTES) throw new BugInputError(`Log melebihi ${MAX_LOG_BYTES / 1024 / 1024} MB; potong ke rentang waktu kejadian.`);
    const others = c.logs.filter((l) => l.name !== file);
    if (others.reduce((a, l) => a + l.size, 0) + size > MAX_CASE_LOG_BYTES) throw new BugInputError(`Total log per kasus maksimal ${MAX_CASE_LOG_BYTES / 1024 / 1024} MB.`);
    await mkdir(this.logDir(id), { recursive: true, mode: 0o700 });
    await writeFile(join(this.logDir(id), file), body, { mode: 0o600 });
    c.logs = [...others, { name: file, size, lines: body.split('\n').length, addedAt: new Date().toISOString() }];
    return this.save(c);
  }

  async removeLog(id: string, name: string): Promise<BugCase> {
    const c = await this.get(id);
    if (!LOG_NAME.test(name)) throw new BugInputError('Nama log tidak valid.');
    await rm(join(this.logDir(id), name), { force: true });
    c.logs = c.logs.filter((l) => l.name !== name);
    return this.save(c);
  }

  /** The start of a log (redacted), for a preview in the UI. */
  async readLog(id: string, name: string, maxBytes = 200_000): Promise<{ text: string; truncated: boolean }> {
    if (!LOG_NAME.test(name)) throw new BugInputError('Nama log tidak valid.');
    const file = join(this.logDir(id), name);
    const s = await stat(file).catch(() => null);
    if (!s) throw new BugInputError('Log tidak ditemukan.');
    const text = (await readFile(file, 'utf8')).slice(0, maxBytes);
    return { text: redactLog(text), truncated: s.size > maxBytes };
  }

  // Analysis ---------------------------------------------------------------------------------

  async analyze(req: BugAnalyzeRequest): Promise<BugJob> {
    const c = await this.get(req.caseId);
    const busy = [...this.jobs.values()].find((j) => j.caseId === c.id && j.status === 'running');
    if (busy) return this.public(busy);
    let servicesRoot: string | undefined;
    let services: string[] = [];
    if (req.useCodebase) {
      try {
        servicesRoot = await this.deps.resolveServicesRoot(req.servicesRoot ?? '');
        services = await this.deps.listServices(servicesRoot);
      } catch (e) {
        throw new BugInputError((e as Error).message);
      }
    }

    // The AI's folder: the report and redacted logs, nothing else.
    const cwd = await mkdtemp(join(tmpdir(), 'tlc-bug-'));
    await mkdir(join(cwd, 'logs'));
    const excerpts: { name: string; excerpt: string }[] = [];
    for (const l of c.logs) {
      const raw = await readFile(join(this.logDir(c.id), l.name), 'utf8').catch(() => '');
      const red = redactLog(raw);
      await writeFile(join(cwd, 'logs', l.name), red);
      excerpts.push({ name: l.name, excerpt: logExcerpt(red) });
    }
    const prompt = buildBugPrompt(c, { servicesRoot, logExcerpts: excerpts, instructions: req.instructions });
    await writeFile(join(cwd, 'BUG.md'), prompt);

    const job: BugJob & { cancel?: () => void } = { id: randomUUID(), caseId: c.id, caseTitle: c.title, status: 'running', startedAt: new Date().toISOString(), progress: 'Menyiapkan…' };
    this.jobs.set(job.id, job);
    c.status = 'analyzing';
    await this.save(c);
    const changed = servicesRoot && this.deps.watchRepos ? await this.deps.watchRepos(servicesRoot).catch(() => undefined) : undefined;
    const run = this.deps.runAi(req.ai, prompt, { cwd, timeoutMs: TIMEOUT_MS, readOnlyDirs: servicesRoot ? [servicesRoot] : [], onProgress: (t) => (job.progress = t.slice(0, 200)) });
    job.cancel = run.cancel;
    void run.done
      .then(async (outcome) => {
        if (job.status === 'cancelled') return;
        if (outcome.error) throw new Error(outcome.error);
        let parsed: ReturnType<typeof parseBugReply>;
        try {
          parsed = parseBugReply(outcome.reply, services);
        } catch (e) {
          job.rawReply = outcome.reply.slice(0, 50_000);
          throw e;
        }
        const touchedRepos = changed ? await changed().catch(() => undefined) : undefined;
        const fresh = await this.get(c.id);
        // A re-trace replaces only tasks that are still proposals; ticketed/fixing ones stay.
        const kept = fresh.tasks.filter((t) => t.status !== 'proposed');
        const tasks = [...kept, ...parsed.tasks.filter((p) => !kept.some((k) => k.repo === p.repo)).map(newTask)];
        const next: BugCase = { ...fresh, status: 'analyzed', tasks, analysis: { ...parsed, at: new Date().toISOString(), ai: req.ai, touchedRepos } };
        next.status = deriveStatus(next);
        await this.save(next);
        job.status = 'done';
      })
      .catch(async (e: Error) => {
        if (job.status === 'running') {
          job.status = 'error';
          job.error = e.message;
        }
        const fresh = await this.get(c.id).catch(() => null);
        if (fresh && fresh.status === 'analyzing') await this.save({ ...fresh, status: fresh.analysis ? 'analyzed' : 'draft' }).catch(() => {});
      })
      .finally(() => {
        job.finishedAt ??= new Date().toISOString();
        job.cancel = undefined;
        void rm(cwd, { recursive: true, force: true });
      });
    return this.public(job);
  }

  private public(job: BugJob & { cancel?: () => void }): BugJob {
    const { cancel: _c, ...rest } = job;
    return rest;
  }

  job(id: string): BugJob | undefined {
    const j = this.jobs.get(id);
    return j && this.public(j);
  }

  /** Recent tracing jobs (newest first), for the Agent Tasks list. */
  jobsList(limit = 20): BugJob[] {
    return [...this.jobs.values()].reverse().slice(0, limit).map((j) => this.public(j));
  }

  latestJob(caseId: string): BugJob | undefined {
    const all = [...this.jobs.values()].filter((j) => j.caseId === caseId);
    return all.length ? this.public(all[all.length - 1]) : undefined;
  }

  async cancel(id: string): Promise<BugJob | undefined> {
    const j = this.jobs.get(id);
    if (j?.status === 'running') {
      j.status = 'cancelled';
      j.finishedAt = new Date().toISOString();
      j.cancel?.();
      const c = await this.get(j.caseId).catch(() => null);
      if (c?.status === 'analyzing') await this.save({ ...c, status: c.analysis ? 'analyzed' : 'draft' });
    }
    return j && this.public(j);
  }

  // Tasks ------------------------------------------------------------------------------------

  private async withAnalysis(caseId: string): Promise<BugCase> {
    const c = await this.get(caseId);
    if (c.status === 'analyzing') throw new BugInputError('Agent tracing masih berjalan; tunggu analisanya selesai.');
    if (!c.analysis) throw new BugInputError('Kirim bug ke agent tracing dulu: task dibuat dari hasil analisanya.');
    return c;
  }

  private task(c: BugCase, taskId: string): BugTask {
    const t = c.tasks.find((x) => x.id === taskId);
    if (!t) throw new BugInputError('Task tidak ditemukan.');
    return t;
  }

  private async saveDerived(c: BugCase): Promise<BugCase> {
    c.status = deriveStatus(c);
    return this.save(c);
  }

  async addTask(caseId: string, raw: Partial<BugTaskProposal>): Promise<BugCase> {
    const c = await this.withAnalysis(caseId);
    if (c.tasks.length >= 20) throw new BugInputError('Maksimal 20 task per bug.');
    c.tasks = [...c.tasks, newTask(cleanTask(raw))];
    return this.saveDerived(c);
  }

  async updateTask(caseId: string, taskId: string, raw: Partial<BugTaskProposal>): Promise<BugCase> {
    const c = await this.withAnalysis(caseId);
    const t = this.task(c, taskId);
    const picked = Object.fromEntries(TASK_EDITABLE.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])) as Partial<BugTaskProposal>;
    if (picked.repo !== undefined && picked.repo !== t.repo && t.coderRunIds.length) throw new BugInputError('Repo tidak bisa diganti setelah agent mulai memperbaiki task ini.');
    Object.assign(t, cleanTask(picked, t));
    return this.saveDerived(c);
  }

  async removeTask(caseId: string, taskId: string): Promise<BugCase> {
    const c = await this.withAnalysis(caseId);
    const t = this.task(c, taskId);
    if (t.status !== 'proposed') throw new BugInputError('Task yang sudah punya tiket atau sedang diperbaiki tidak bisa dihapus; tandai selesai saja.');
    c.tasks = c.tasks.filter((x) => x.id !== taskId);
    return this.saveDerived(c);
  }

  async setTaskStatus(caseId: string, taskId: string, status: BugTaskStatus): Promise<BugCase> {
    const c = await this.withAnalysis(caseId);
    const t = this.task(c, taskId);
    if (status === 'fixed') t.status = 'fixed';
    else if (status === 'proposed' || status === 'ticketed' || status === 'fixing') t.status = t.coderRunIds.length ? 'fixing' : t.jira ? 'ticketed' : 'proposed';
    else throw new BugInputError('Status task tidak valid.');
    return this.saveDerived(c);
  }

  // Jira & fixing ----------------------------------------------------------------------------

  async createTicket(req: BugTicketRequest): Promise<{ case: BugCase; task: BugTask }> {
    const c = await this.withAnalysis(req.caseId);
    const t = this.task(c, String(req.taskId ?? ''));
    if (t.jira) throw new BugInputError(`Task ini sudah punya tiket ${t.jira.key}.`);
    const projectKey = clean(req.projectKey, 10);
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(projectKey)) throw new BugInputError('Project key Jira tidak valid.');
    const issueType = clean(req.issueType, 60);
    const summary = clean(req.summary, 250) && bugTicketTitle(clean(req.summary, 250), t.repo, t.profile);
    if (!issueType || !summary) throw new BugInputError('Tipe dan judul tiket wajib diisi.');
    const jira = await this.deps.jira?.();
    if (!jira) throw new BugInputError('Jira belum dikonfigurasi (menu Koneksi).');
    const created = await jira.createIssue({ projectKey, issueType, summary, description: clean(req.description, 30_000), priority: clean(req.priority, 40) || undefined });
    t.jira = { ...created, createdAt: new Date().toISOString() };
    if (t.status === 'proposed') t.status = 'ticketed';
    return { case: await this.saveDerived(c), task: t };
  }

  /** The task a fix is started for, checked: analysis done, task exists. */
  async fixTarget(caseId: string, taskId: string): Promise<{ case: BugCase; task: BugTask }> {
    const c = await this.withAnalysis(caseId);
    return { case: c, task: this.task(c, taskId) };
  }

  /** Records a coding-agent run started for a task. */
  async attachRun(caseId: string, taskId: string, runId: string): Promise<BugCase> {
    const c = await this.get(caseId);
    if (!/^[\w-]{1,64}$/.test(runId)) throw new BugInputError('Id run tidak valid.');
    const t = this.task(c, taskId);
    t.coderRunIds = [...new Set([...t.coderRunIds, runId])];
    if (t.status !== 'fixed') t.status = 'fixing';
    c.coderRunIds = [...new Set([...c.coderRunIds, runId])];
    return this.saveDerived(c);
  }

  async setStatus(id: string, status: BugCase['status']): Promise<BugCase> {
    const c = await this.get(id);
    if (!['draft', 'analyzed', 'ticketed', 'fixing', 'fixed'].includes(status)) throw new BugInputError('Status tidak valid.');
    return this.save({ ...c, status });
  }
}
