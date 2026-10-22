import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeSuites } from '../../src/lib/qa/merge.ts';
import { applyChanges, diffSuites } from '../../src/lib/qa/suite-diff.ts';
import type { QAEnvironment, QAPlan, QAProject, QARun, QARunEvidence, QASuite, QASuiteReview } from '../../src/lib/qa/types.ts';
import { QaConflictError, type QaStore } from './store.ts';

/**
 * Test case changes wait in a local draft until someone reviews and sends them. Every suite save
 * (edits, generation, AI fixes) goes to <dir>/<projectId>.json; the shared storage only changes
 * on "Kirim" (publish), all or some of the changes at once. Plans, runs, environments and
 * projects go straight through. Changes others send meanwhile are merged into the draft when
 * they touch other test cases. Tech Lead Cockpit's local file mode keeps no drafts.
 */

export class QaDraftError extends Error {}

interface DraftFile {
  projectId: string;
  /** The published suite the draft started from (null: nothing published yet). */
  base: QASuite | null;
  suite: QASuite;
  /** Bumped on every draft save: a save must carry the revision it was loaded with. */
  rev: number;
  startedAt: string;
  updatedAt: string;
  updatedBy?: string;
  /** The published suite moved on with changes to the same test cases: rebasing waits for a send or a discard. */
  behind?: boolean;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const empty = (s: QASuite): QASuite => ({ projectId: s.projectId, projectName: s.projectName, flows: [], updatedAt: '' });

/** The store's own fields and the draft markers, never stored in a draft or sent. */
function clean(suite: QASuite): QASuite {
  const { draft: _d, draftRev: _r, version: _v, updatedBy: _b, ...rest } = suite;
  return rest as QASuite;
}

export class DraftedQaStore implements QaStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly remoteOf: () => QaStore,
    private readonly dir: string,
  ) {}

  /** The shared storage itself. */
  get remote(): QaStore {
    return this.remoteOf();
  }

  get kind(): 'file' | 'postgres' | 'confluence' {
    return (this.remote as { kind?: 'file' | 'postgres' | 'confluence' }).kind ?? 'confluence';
  }

  private get drafting(): boolean {
    return this.kind !== 'file';
  }

  private file(projectId: string): string {
    if (!ID.test(projectId)) throw new QaDraftError('Id proyek tidak valid.');
    return join(this.dir, `${projectId}.json`);
  }

  private async read(projectId: string): Promise<DraftFile | undefined> {
    try {
      return JSON.parse(await readFile(this.file(projectId), 'utf8')) as DraftFile;
    } catch {
      return undefined;
    }
  }

  private async write(d: DraftFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(d.projectId);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(d), { mode: 0o600 });
    await rename(tmp, file);
  }

  private async drop(projectId: string): Promise<void> {
    await rm(this.file(projectId), { force: true });
  }

  /** One change at a time per project (agents and the UI save concurrently). */
  private locked<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(projectId, next.catch(() => {}));
    return next;
  }

  private view(d: DraftFile): QASuite {
    return {
      ...d.suite,
      version: d.base?.version ?? 0,
      ...(d.updatedBy ? { updatedBy: d.updatedBy } : {}),
      draftRev: d.rev,
      draft: { startedAt: d.startedAt, changes: diffSuites(d.base, d.suite).length, ...(d.behind ? { behind: true } : {}) },
    };
  }

  /**
   * Catches the draft up with what others sent: merged when it touches other test cases, else
   * marked `behind`. Unreachable storage leaves the draft as it is. Undefined: nothing left to send.
   */
  private async refresh(d: DraftFile): Promise<{ draft?: DraftFile; latest: QASuite | null | undefined }> {
    const latest = await this.remote.getSuite(d.projectId).catch(() => undefined);
    if (latest === undefined || (latest?.version ?? 0) === (d.base?.version ?? 0)) return { draft: d, latest };
    if (!latest) return { draft: d, latest };
    const merged = mergeSuites(d.base ?? empty(latest), d.suite, latest);
    if ('conflicts' in merged) {
      if (!d.behind) await this.write({ ...d, behind: true });
      return { draft: { ...d, behind: true }, latest };
    }
    const next: DraftFile = { ...d, base: latest, suite: clean(merged.suite), rev: d.rev + 1, behind: undefined };
    if (!diffSuites(latest, next.suite).length) {
      await this.drop(d.projectId);
      return { latest };
    }
    await this.write(next);
    return { draft: next, latest };
  }

  async getSuite(projectId: string): Promise<QASuite | null> {
    if (!this.drafting) return this.remote.getSuite(projectId);
    return this.locked(projectId, async () => {
      const d = await this.read(projectId);
      if (!d) return this.remote.getSuite(projectId);
      const { draft, latest } = await this.refresh(d);
      return draft ? this.view(draft) : (latest ?? null);
    });
  }

  /** Saves into the draft: over its revision, or (no draft yet) over the published version. */
  async saveSuite(suite: QASuite, by?: string): Promise<QASuite> {
    if (!this.drafting) return this.remote.saveSuite(suite, by);
    return this.locked(suite.projectId, async () => {
      const now = new Date().toISOString();
      let d = await this.read(suite.projectId);
      if (d) {
        if (suite.draftRev !== d.rev) throw new QaConflictError('suite', d.updatedBy, d.updatedAt);
      } else {
        const published = await this.remote.getSuite(suite.projectId);
        // A copy of a draft that was sent or thrown away meanwhile, or of an older published one.
        if (suite.draftRev !== undefined || (suite.version ?? 0) !== (published?.version ?? 0)) throw new QaConflictError('suite', published?.updatedBy, published?.updatedAt);
        d = { projectId: suite.projectId, base: published, suite: clean(suite), rev: 0, startedAt: now, updatedAt: now };
      }
      const next = { ...clean(suite), updatedAt: now };
      if (d.base && !diffSuites(d.base, next).length) {
        // Back to what is published: nothing to review.
        await this.drop(suite.projectId);
        return d.base;
      }
      const saved: DraftFile = { ...d, suite: next, rev: d.rev + 1, updatedAt: now, ...(by ? { updatedBy: by } : {}) };
      await this.write(saved);
      return this.view(saved);
    });
  }

  /** The draft's changes against what it started from, and what collides with later sends. */
  async reviewSuite(projectId: string): Promise<QASuiteReview> {
    return this.locked(projectId, async () => {
      const d0 = this.drafting ? await this.read(projectId) : undefined;
      if (!d0) return { projectId, changes: [], conflicts: [] };
      const { draft: d, latest } = await this.refresh(d0);
      if (!d) return { projectId, changes: [], conflicts: [] };
      const changes = diffSuites(d.base, d.suite);
      const moved = latest && (latest.version ?? 0) !== (d.base?.version ?? 0);
      return {
        projectId,
        startedAt: d.startedAt,
        changes,
        ...(moved ? { published: { version: latest.version, updatedBy: latest.updatedBy, updatedAt: latest.updatedAt } } : {}),
        conflicts: moved ? this.collisions(d, latest, changes.map((c) => c.key)) : [],
      };
    });
  }

  /** Keys changed in the draft that the published suite also changed, differently. */
  private collisions(d: DraftFile, latest: QASuite, keys: string[]): string[] {
    const at = (s: QASuite | null, key: string) =>
      key.startsWith('suite:') ? (s as unknown as Record<string, unknown> | null)?.[key.slice(6)] : s?.flows.find((f) => f.id === key);
    const json = (v: unknown) => JSON.stringify(v ?? null);
    return keys.filter((k) => json(at(latest, k)) !== json(at(d.base, k)) && json(at(latest, k)) !== json(at(d.suite, k)));
  }

  /** Sends the chosen changes (all when `keys` is absent); the rest stay in the draft. */
  async publishSuite(projectId: string, keys: string[] | undefined, by?: string): Promise<{ suite: QASuite; sent: number }> {
    return this.locked(projectId, async () => {
      const d0 = await this.read(projectId);
      if (!d0) throw new QaDraftError('Tidak ada perubahan yang menunggu dikirim.');
      const { draft: d, latest } = await this.refresh(d0);
      if (!d) return { suite: latest!, sent: 0 };
      if (latest === undefined) throw new QaDraftError('Penyimpanan bersama tidak bisa dihubungi. Perubahan tetap tersimpan di draft.');
      const all = diffSuites(d.base, d.suite).map((c) => c.key);
      const pick = keys ? all.filter((k) => keys.includes(k)) : all;
      if (!pick.length) throw new QaDraftError('Pilih perubahan yang akan dikirim.');

      let sending = applyChanges(d.base, d.suite, pick);
      if (latest && (latest.version ?? 0) !== (d.base?.version ?? 0)) {
        const merged = mergeSuites(d.base ?? empty(latest), sending, latest);
        if ('conflicts' in merged) throw new QaConflictError('suite', latest.updatedBy, latest.updatedAt, merged.conflicts);
        sending = merged.suite;
      }
      const saved = await this.remote.saveSuite({ ...clean(sending), version: latest?.version ?? 0, updatedAt: new Date().toISOString() }, by);

      const rest = all.filter((k) => !pick.includes(k));
      if (!rest.length) {
        await this.drop(projectId);
        return { suite: saved, sent: pick.length };
      }
      const next: DraftFile = { ...d, base: saved, suite: clean(applyChanges(saved, d.suite, rest)), rev: d.rev + 1, behind: undefined };
      await this.write(next);
      return { suite: this.view(next), sent: pick.length };
    });
  }

  /** Throws away the chosen changes (all when `keys` is absent). */
  async discardSuite(projectId: string, keys?: string[]): Promise<QASuite | null> {
    return this.locked(projectId, async () => {
      const d = await this.read(projectId);
      if (d && keys) {
        const rest = diffSuites(d.base, d.suite).map((c) => c.key).filter((k) => !keys.includes(k));
        if (rest.length) {
          const next: DraftFile = { ...d, suite: clean(applyChanges(d.base, d.suite, rest)), rev: d.rev + 1 };
          await this.write(next);
          return this.view(next);
        }
      }
      await this.drop(projectId);
      return this.remote.getSuite(projectId);
    });
  }

  // Everything else goes straight to the shared storage.
  getPlan(projectId: string): Promise<QAPlan | null> {
    return this.remote.getPlan(projectId);
  }
  savePlan(plan: QAPlan, by?: string): Promise<QAPlan> {
    return this.remote.savePlan(plan, by);
  }
  listEnvironments(): Promise<QAEnvironment[]> {
    return this.remote.listEnvironments();
  }
  saveEnvironment(env: QAEnvironment, by?: string): Promise<QAEnvironment> {
    return this.remote.saveEnvironment(env, by);
  }
  deleteEnvironment(id: string): Promise<void> {
    return this.remote.deleteEnvironment(id);
  }
  listRuns(projectId: string): Promise<QARun[]> {
    return this.remote.listRuns(projectId);
  }
  getRun(projectId: string, id: string): Promise<QARun | undefined> {
    return this.remote.getRun(projectId, id);
  }
  saveRun(run: QARun, by?: string): Promise<void> {
    return this.remote.saveRun(run, by);
  }
  listProjects(): Promise<QAProject[]> {
    return this.remote.listProjects();
  }
  get saveEvidence(): ((run: QARun, page: { title: string; storage: string }, by?: string) => Promise<QARunEvidence>) | undefined {
    const remote = this.remote;
    return remote.saveEvidence ? (run, page, by) => remote.saveEvidence!(run, page, by) : undefined;
  }
  upsertProject(project: Omit<QAProject, 'updatedAt' | 'updatedBy'>, by?: string): Promise<QAProject> {
    return this.remote.upsertProject(project, by);
  }
}
