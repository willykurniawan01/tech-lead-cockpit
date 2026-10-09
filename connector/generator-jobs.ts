import { randomUUID } from 'node:crypto';
import { DEFAULT_AI_SELECTION, isAiSelection } from '../src/lib/ai/types.ts';
import type { GeneratorJob, GeneratorJobEvent, StartGeneratorJobRequest } from '../src/lib/generator/types.ts';
import { startProviderRun, terminateProviderProcess, type ProviderRun } from './ai-providers.ts';
import { prepareGeneratorWorkspace, readGeneratorResult } from './generator-runner.ts';
import { diffSnapshots, resolveServicesRoot, snapshotRepos, type RepoSnapshot } from './services.ts';

/**
 * Long-running AI edits as background jobs. The HTTP request only starts the job; the UI
 * polls for progress, so a page reload or a slow multi-minute edit doesn't lose the result.
 */

export const JOB_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_EVENTS = 80;
const KEEP_FINISHED_MS = 60 * 60 * 1000;

export class JobConflictError extends Error {
  constructor(readonly job: GeneratorJob) {
    super('Generator masih berjalan untuk draft ini.');
  }
}

interface JobState {
  job: GeneratorJob;
  run?: ProviderRun;
  cancelled: boolean;
}

class GeneratorJobs {
  constructor(private readonly jobs: Map<string, JobState>) {}

  get(id: string): GeneratorJob | undefined {
    return this.jobs.get(id)?.job;
  }

  /** Running job for the draft, else its most recent finished one. */
  latestForDraft(draftId: string): GeneratorJob | undefined {
    const forDraft = [...this.jobs.values()].map((s) => s.job).filter((j) => j.draftId === draftId);
    return forDraft.find((j) => j.status === 'running') ?? forDraft.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  cancel(id: string): GeneratorJob | undefined {
    const s = this.jobs.get(id);
    if (!s || s.job.status !== 'running') return s?.job;
    s.cancelled = true;
    if (s.run?.child) terminateProviderProcess(s.run.child);
    if (s.run?.abort) s.run.abort();
    return s.job;
  }

  async start(req: StartGeneratorJobRequest): Promise<GeneratorJob> {
    this.prune();
    const running = this.latestForDraft(req.draftId);
    if (running?.status === 'running') throw new JobConflictError(running);

    const ai = isAiSelection(req.ai) ? req.ai : DEFAULT_AI_SELECTION;
    const kind = req.kind === 'brainstorm' ? 'brainstorm' : 'edit';
    const job: GeneratorJob = { id: randomUUID(), draftId: req.draftId, prompt: req.prompt, ai, kind, status: 'running', startedAt: new Date().toISOString(), events: [] };
    const state: JobState = { job, cancelled: false };
    this.jobs.set(job.id, state);
    const t0 = Date.now();
    const push = (ev: Omit<GeneratorJobEvent, 'at'>) => {
      job.events.push({ ...ev, at: Date.now() - t0 });
      if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    };

    let servicesRoot: string | undefined;
    let before: RepoSnapshot | undefined;
    try {
      if (req.servicesRoot) {
        servicesRoot = await resolveServicesRoot(req.servicesRoot);
        push({ kind: 'info', text: 'Mencatat status git codebase…' });
        before = await snapshotRepos(servicesRoot);
      }
    } catch (e) {
      this.jobs.delete(job.id);
      throw e;
    }

    const ws = await prepareGeneratorWorkspace({ ...req, servicesRoot, provider: ai.provider, kind, scopeAgreed: Boolean(req.scopeAgreed) });
    const providerLabel = ai.provider === 'claude' ? 'Claude CLI' : ai.provider === 'antigravity' ? 'Antigravity CLI' : ai.provider === '9router' ? '9Router' : 'InferHub';
    push({ kind: 'info', text: `Menjalankan ${providerLabel}${ai.model ? ` (${ai.model})` : ''}…` });

    const resume = typeof req.resumeSession === 'string' && /^[\w-]{8,80}$/.test(req.resumeSession) ? req.resumeSession : undefined;
    const runOnce = (resumeSession?: string) => {
      const run = startProviderRun(ai, 'edit', ws.instructions, {
        cwd: ws.workspaceDir,
        timeoutMs: JOB_TIMEOUT_MS,
        onEvent: push,
        readOnlyDirs: servicesRoot ? [servicesRoot] : [],
        resumeSession,
      });
      state.run = run;
      return run.done;
    };

    void (async () => {
      let outcome = await runOnce(resume);
      // A stale or unknown session shouldn't block the user: start a fresh conversation once.
      if (resume && outcome.error && !outcome.emptyAnswer && !state.cancelled) {
        push({ kind: 'info', text: 'Sesi sebelumnya tidak bisa dilanjutkan, memulai percakapan baru…' });
        outcome = await runOnce(undefined);
      }
      return outcome;
    })().then(async (outcome) => {
      const original = { tad: req.tadMarkdown, scope: ws.initialScope };
      const probe = await readGeneratorResult(ws, original, { reply: outcome.reply });
      // An edit without a closing message is still a valid edit.
      const error = state.cancelled ? 'Dibatalkan oleh user.' : outcome.emptyAnswer && (probe.changed || probe.scopeChanged) ? undefined : outcome.error;
      let result = await readGeneratorResult(ws, original, { reply: outcome.reply, error });
      // Brainstorming must not touch the TAD; drop any TAD edit the model made anyway.
      if (kind === 'brainstorm' && result.changed) {
        push({ kind: 'tool-error', text: 'AI mengubah TAD.md saat brainstorming; perubahan itu diabaikan.' });
        result = { ...result, changed: false, updatedTadMarkdown: undefined };
      }
      // The AI must never touch the codebase; any repo that changed during the run is reported
      // (it may also be the user's own work in parallel, so it's a warning, not a hard failure).
      const touchedRepos = servicesRoot && before ? diffSnapshots(before, await snapshotRepos(servicesRoot)) : [];
      if (touchedRepos.length) push({ kind: 'tool-error', text: `Perubahan terdeteksi di codebase selama job: ${touchedRepos.map((t) => t.repo).join(', ')}` });
      // Long analyses edit TAD.md in batches, so a run that times out or errors late usually holds
      // most of the work: hand it back as a partial revision (rollback-able). Only a user cancel discards.
      const partial = !state.cancelled && Boolean(error) && (result.changed || result.scopeChanged);
      const kept = state.cancelled || (error && !partial) ? { ...result, updatedTadMarkdown: undefined, changed: false, updatedScopeMarkdown: undefined, scopeChanged: false } : result;
      job.result = { ...kept, partial, touchedRepos, sessionId: error ? undefined : outcome.sessionId, baseTadMarkdown: kept.changed ? req.tadMarkdown : undefined };
      job.status = state.cancelled ? 'cancelled' : error ? 'error' : 'done';
      job.finishedAt = new Date().toISOString();
      state.run = undefined;
    });

    return job;
  }

  private prune() {
    const now = Date.now();
    for (const [id, s] of this.jobs) {
      if (s.job.finishedAt && now - Date.parse(s.job.finishedAt) > KEEP_FINISHED_MS) this.jobs.delete(id);
    }
  }
}

/**
 * Job state survives Vite's in-process restarts so running jobs keep reporting progress. Only
 * the data lives on globalThis: the manager is rebuilt per module load, so new jobs always run
 * the current code (a cached instance would keep using the code from before the restart).
 */
const g = globalThis as typeof globalThis & { __tlcGeneratorJobStates?: Map<string, JobState> };
g.__tlcGeneratorJobStates ??= new Map();
const manager = new GeneratorJobs(g.__tlcGeneratorJobStates);
export function generatorJobs(): GeneratorJobs {
  return manager;
}
