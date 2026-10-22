import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QAEnvironment, QAPlan, QAProject, QARun, QARunEvidence, QASuite } from '../../src/lib/qa/types.ts';

/**
 * Where E2E data lives: files under ~/.tech-lead-cockpit/qa (one user), or a shared PostgreSQL
 * database (Tech Lead and QA together, see pg-store.ts). Suites, plans and environments carry a
 * version: a save must bring the version it was loaded with, so two people saving at once never
 * overwrite each other silently; the later save gets a QaConflictError instead.
 * Environment secrets are never part of the store: they stay in each user's Keychain.
 */

/** Finished runs kept per project (the oldest go first). */
export const KEEP_RUNS = 50;

export type QaStoreKind = 'file' | 'postgres' | 'confluence';

export class QaConflictError extends Error {
  constructor(
    readonly what: 'suite' | 'plan' | 'environment',
    readonly updatedBy?: string,
    readonly updatedAt?: string,
    /** What changed on both sides ('test case "X"', 'catatan suite'): why an automatic merge was impossible. */
    readonly flows?: string[],
  ) {
    const list = flows?.length ? `${flows.slice(0, 5).join(', ')}${flows.length > 5 ? ` dan ${flows.length - 5} lainnya` : ''}` : '';
    const names = list && list[0].toUpperCase() + list.slice(1);
    const subject = names || (what === 'suite' ? 'Test case proyek ini' : what === 'plan' ? 'Rencana journey ini' : 'Environment ini');
    const who = updatedBy ? ` oleh ${updatedBy}` : '';
    const when = updatedAt ? ` pada ${formatTime(updatedAt)}` : '';
    super(`${subject} sudah diubah${who}${when}. Perubahan Anda belum disimpan; muat ulang untuk melihat versi terbaru.`);
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export interface QaStore {
  readonly kind: QaStoreKind;
  getSuite(projectId: string): Promise<QASuite | null>;
  /** Saves when `suite.version` (absent = 0) is the stored one; returns it with the next version. */
  saveSuite(suite: QASuite, by?: string): Promise<QASuite>;
  getPlan(projectId: string): Promise<QAPlan | null>;
  savePlan(plan: QAPlan, by?: string): Promise<QAPlan>;
  listEnvironments(): Promise<QAEnvironment[]>;
  /** Same version rule; a new environment (not stored yet) needs none. */
  saveEnvironment(env: QAEnvironment, by?: string): Promise<QAEnvironment>;
  deleteEnvironment(id: string): Promise<void>;
  /** Newest first. */
  listRuns(projectId: string): Promise<QARun[]>;
  getRun(projectId: string, id: string): Promise<QARun | undefined>;
  /** Stores a finished run and drops the oldest beyond KEEP_RUNS. */
  saveRun(run: QARun, by?: string): Promise<void>;
  listProjects(): Promise<QAProject[]>;
  /** Creates or updates a project's name and TADs (no version: the latest wins, nothing else is in it). */
  upsertProject(project: Omit<QAProject, 'updatedAt' | 'updatedBy'>, by?: string): Promise<QAProject>;
  /** A readable evidence page for a finished run (Confluence only). */
  saveEvidence?(run: QARun, page: { title: string; storage: string }, by?: string): Promise<QARunEvidence>;
  close?(): Promise<void>;
}

/** Strips what the store sets itself, so it is never stored twice or trusted from a caller. */
export function bare<T extends { version?: number; updatedBy?: string }>(item: T): Omit<T, 'version' | 'updatedBy'> {
  const { version: _v, updatedBy: _b, ...rest } = item;
  return rest;
}

/** The connector's own fields, set per user from the Keychain (never stored). */
export function storableEnvironment(env: QAEnvironment): QAEnvironment {
  const { hasSecret: _a, secretVariableNames: _b, dbServerPassword: _c, dbPasswords: _d, ...rest } = env;
  return bare(rest) as QAEnvironment;
}

/**
 * The file layout used since the start: suites/<projectId>.json, plans/<projectId>.json,
 * runs/<projectId>/<runId>.json, environments.json and projects.json, all 0600 in a 0700 folder.
 */
export class FileQaStore implements QaStore {
  readonly kind = 'file' as const;
  /** Version check and write of one file happen one at a time (this process is the only writer). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(readonly dir: string) {}

  private async write(file: string, data: unknown) {
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  private async read<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => {}));
    return next;
  }

  suiteFile = (projectId: string) => join(this.dir, 'suites', `${projectId}.json`);
  planFile = (projectId: string) => join(this.dir, 'plans', `${projectId}.json`);
  runDir = (projectId: string) => join(this.dir, 'runs', projectId);
  private envFile = () => join(this.dir, 'environments.json');
  private projectsFile = () => join(this.dir, 'projects.json');

  /** One versioned JSON file: refused when someone saved since `expected` was loaded. */
  private saveVersioned<T extends { version?: number; updatedBy?: string; updatedAt?: string }>(file: string, item: T, what: QaConflictError['what'], by?: string): Promise<T> {
    return this.locked(file, async () => {
      const current = await this.read<T>(file);
      if (current && (current.version ?? 0) !== (item.version ?? 0)) throw new QaConflictError(what, current.updatedBy, current.updatedAt);
      const saved = { ...item, version: (current?.version ?? 0) + 1, ...(by ? { updatedBy: by } : {}) };
      await this.write(file, saved);
      return saved;
    });
  }

  async getSuite(projectId: string): Promise<QASuite | null> {
    const suite = await this.read<QASuite>(this.suiteFile(projectId));
    return suite ? { ...suite, version: suite.version ?? 0 } : null;
  }

  saveSuite(suite: QASuite, by?: string): Promise<QASuite> {
    return this.saveVersioned(this.suiteFile(suite.projectId), suite, 'suite', by);
  }

  async getPlan(projectId: string): Promise<QAPlan | null> {
    const plan = await this.read<QAPlan>(this.planFile(projectId));
    return plan ? { ...plan, version: plan.version ?? 0 } : null;
  }

  savePlan(plan: QAPlan, by?: string): Promise<QAPlan> {
    return this.saveVersioned(this.planFile(plan.projectId), plan, 'plan', by);
  }

  async listEnvironments(): Promise<QAEnvironment[]> {
    return ((await this.read<QAEnvironment[]>(this.envFile())) ?? []).map((e) => ({ ...e, version: e.version ?? 0 }));
  }

  saveEnvironment(env: QAEnvironment, by?: string): Promise<QAEnvironment> {
    return this.locked(this.envFile(), async () => {
      const envs = (await this.read<QAEnvironment[]>(this.envFile())) ?? [];
      const index = envs.findIndex((e) => e.id === env.id);
      const current = index >= 0 ? envs[index] : undefined;
      if (current && (current.version ?? 0) !== (env.version ?? 0)) throw new QaConflictError('environment', current.updatedBy, current.updatedAt);
      const saved = { ...storableEnvironment(env), version: (current?.version ?? 0) + 1, updatedAt: new Date().toISOString(), ...(by ? { updatedBy: by } : {}) } as QAEnvironment;
      if (index >= 0) envs[index] = saved;
      else envs.push(saved);
      await this.write(this.envFile(), envs);
      return saved;
    });
  }

  deleteEnvironment(id: string): Promise<void> {
    return this.locked(this.envFile(), async () => {
      const envs = (await this.read<QAEnvironment[]>(this.envFile())) ?? [];
      await this.write(this.envFile(), envs.filter((e) => e.id !== id));
    });
  }

  async listRuns(projectId: string): Promise<QARun[]> {
    const names = (await readdir(this.runDir(projectId)).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort().reverse();
    return (await Promise.all(names.map((n) => this.read<QARun>(join(this.runDir(projectId), n))))).filter((r): r is QARun => Boolean(r));
  }

  getRun(projectId: string, id: string): Promise<QARun | undefined> {
    return this.read<QARun>(join(this.runDir(projectId), `${id}.json`));
  }

  async saveRun(run: QARun): Promise<void> {
    await this.write(join(this.runDir(run.projectId), `${run.id}.json`), run);
    // Run ids start with their start time, so names sort oldest first.
    const names = (await readdir(this.runDir(run.projectId)).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
    for (const n of names.slice(0, Math.max(0, names.length - KEEP_RUNS))) await rm(join(this.runDir(run.projectId), n), { force: true });
  }

  async listProjects(): Promise<QAProject[]> {
    return (await this.read<QAProject[]>(this.projectsFile())) ?? [];
  }

  upsertProject(project: Omit<QAProject, 'updatedAt' | 'updatedBy'>, by?: string): Promise<QAProject> {
    return this.locked(this.projectsFile(), async () => {
      const all = (await this.read<QAProject[]>(this.projectsFile())) ?? [];
      const saved: QAProject = { id: project.id, name: project.name, tads: project.tads, updatedAt: new Date().toISOString(), ...(by ? { updatedBy: by } : {}) };
      const index = all.findIndex((p) => p.id === project.id);
      if (index >= 0) all[index] = saved;
      else all.push(saved);
      await this.write(this.projectsFile(), all);
      return saved;
    });
  }
}
