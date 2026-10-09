import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MrSummary } from '../src/lib/gitlab/types.ts';
import { DATA_DIR } from './paths.ts';

/**
 * MRs linked to a Jira key by hand, for when auto-detection (the key in branch, title or
 * description) misses them. Stored with the last known summary so a link still counts while
 * GitLab is unreachable; refreshed whenever MRs are loaded. ~/.tech-lead-cockpit/progress (0700).
 */

const KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/;
const MAX_PER_KEY = 10;

export class ManualMrError extends Error {}

export interface ManualMr {
  projectPath: string;
  iid: number;
  addedAt: string;
  /** Last summary read from GitLab. */
  last: MrSummary;
}

type Store = Record<string, ManualMr[]>;

export interface MrSource {
  mrSummary(projectPath: string, iid: number): Promise<MrSummary>;
}

export class ManualMrs {
  private readonly file: string;

  constructor(dir = join(DATA_DIR, 'progress')) {
    this.file = join(dir, 'manual-mrs.json');
  }

  async all(): Promise<Store> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Store;
    } catch {
      return {};
    }
  }

  private async save(store: Store) {
    await mkdir(join(this.file, '..'), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Links an MR (checked against GitLab first) to a Jira key. */
  async add(key: string, ref: { projectPath: string; iid: number }, gitlab: MrSource): Promise<Store> {
    if (!KEY.test(key)) throw new ManualMrError('Jira key tidak valid.');
    let last: MrSummary;
    try {
      last = await gitlab.mrSummary(ref.projectPath, ref.iid);
    } catch (e) {
      throw new ManualMrError(`MR tidak bisa dibaca dari GitLab: ${(e as Error).message}`);
    }
    const store = await this.all();
    const list = (store[key] ?? []).filter((m) => !(m.projectPath === last.projectPath && m.iid === last.iid));
    if (list.length >= MAX_PER_KEY) throw new ManualMrError(`Maksimal ${MAX_PER_KEY} MR manual per Jira key.`);
    store[key] = [...list, { projectPath: last.projectPath, iid: last.iid, addedAt: new Date().toISOString(), last: { ...last, manual: true } }];
    await this.save(store);
    return store;
  }

  async remove(key: string, ref: string): Promise<Store> {
    const store = await this.all();
    store[key] = (store[key] ?? []).filter((m) => `${m.projectPath}!${m.iid}` !== ref);
    if (!store[key].length) delete store[key];
    await this.save(store);
    return store;
  }

  /**
   * Adds the hand-linked MRs to auto-detected ones (same MR counted once), refreshing their state
   * from GitLab when it answers and falling back to the stored summary when it doesn't.
   */
  async merge(keys: string[], detected: Record<string, MrSummary[]>, gitlab: MrSource | null): Promise<Record<string, MrSummary[]>> {
    const store = await this.all();
    const out: Record<string, MrSummary[]> = { ...detected };
    let changed = false;
    for (const key of keys) {
      const links = store[key];
      if (!links?.length) continue;
      const list = [...(out[key] ?? [])];
      for (const link of links) {
        let mr = link.last;
        if (gitlab) {
          try {
            mr = { ...(await gitlab.mrSummary(link.projectPath, link.iid)), manual: true };
            if (mr.state !== link.last.state || mr.updatedAt !== link.last.updatedAt) (link.last = mr), (changed = true);
          } catch {
            /* keep the last known state */
          }
        }
        const i = list.findIndex((m) => m.ref === mr.ref);
        if (i < 0) list.push(mr);
      }
      out[key] = list;
    }
    if (changed) await this.save(store).catch(() => {});
    return out;
  }
}
