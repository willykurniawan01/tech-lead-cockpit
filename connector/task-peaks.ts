import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDevStage, type DevStage } from '../src/lib/tad/progress-report.ts';
import { DATA_DIR } from './paths.ts';

/**
 * The furthest dev stage each task ever reached (`<tadId>::<title>` → stage), so progress never
 * drops when a task goes back (QA returns it, a ticket is reopened). Only ever raised. Shared by
 * the app (through the connector routes) and the mobile API.
 */

const MAX_ENTRIES = 20_000;
const RANK: Record<DevStage, number> = { todo: 0, in_progress: 1, review: 2, merged: 3 };

export class TaskPeakStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly file = join(DATA_DIR, 'task-peaks.json')) {}

  async read(): Promise<Record<string, DevStage>> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(raw).filter((e): e is [string, DevStage] => isDevStage(e[1])));
    } catch {
      return {};
    }
  }

  /** Raises the given peaks (lower or unknown stages are ignored); returns the full map. */
  raise(input: Record<string, unknown>): Promise<Record<string, DevStage>> {
    const next = this.chain.then(async () => {
      const peaks = await this.read();
      let changed = false;
      for (const [key, stage] of Object.entries(input ?? {}).slice(0, 2_000)) {
        if (typeof key !== 'string' || key.length > 600 || !isDevStage(stage) || stage === 'todo') continue;
        if (RANK[stage] > RANK[peaks[key] ?? 'todo']) {
          peaks[key] = stage;
          changed = true;
        }
      }
      if (changed && Object.keys(peaks).length <= MAX_ENTRIES) {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(peaks), { mode: 0o600 });
        await rename(tmp, this.file);
      }
      return peaks;
    });
    this.chain = next.catch(() => {});
    return next;
  }
}
