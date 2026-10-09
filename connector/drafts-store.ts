import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidDraftId } from './generator-runner.ts';
import { DATA_DIR } from './paths.ts';

/**
 * TAD drafts as one JSON file each, outside the app bundle and the browser profile, so a rebuild,
 * a reinstall or a cleared WebView never loses them, and the browser and the Mac app share them.
 */
export const DRAFTS_DIR = join(DATA_DIR, 'drafts');

const MAX_DRAFT_BYTES = 20 * 1024 * 1024;

export class DraftFileError extends Error {}

interface DraftLike {
  id: string;
  markdown: string;
  updatedAt: string;
}

function isDraftLike(v: unknown): v is DraftLike {
  const d = v as Partial<DraftLike> | null;
  return Boolean(d) && isValidDraftId(d!.id) && typeof d!.markdown === 'string' && typeof d!.updatedAt === 'string';
}

export class DraftFiles {
  constructor(readonly dir = DRAFTS_DIR) {}

  async list(): Promise<DraftLike[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: DraftLike[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const d = JSON.parse(await readFile(join(this.dir, name), 'utf8'));
        if (isDraftLike(d)) out.push(d);
      } catch {
        // A half-written or hand-edited file must not hide the other drafts.
      }
    }
    return out;
  }

  async save(draft: unknown): Promise<void> {
    if (!isDraftLike(draft)) throw new DraftFileError('Draft tidak valid.');
    const json = JSON.stringify(draft);
    if (Buffer.byteLength(json) > MAX_DRAFT_BYTES) throw new DraftFileError('Draft terlalu besar untuk disimpan.');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write leaves the previous version intact.
    const tmp = join(this.dir, `.${draft.id}.${process.pid}.tmp`);
    await writeFile(tmp, json, { mode: 0o600 });
    await rename(tmp, join(this.dir, `${draft.id}.json`));
  }

  /** Moves the file to .trash instead of deleting it, so a mistaken delete can still be recovered by hand. */
  async remove(id: unknown): Promise<void> {
    if (!isValidDraftId(id)) throw new DraftFileError('draftId tidak valid.');
    const trash = join(this.dir, '.trash');
    await mkdir(trash, { recursive: true, mode: 0o700 });
    try {
      await rename(join(this.dir, `${id}.json`), join(trash, `${id}-${Date.now()}.json`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
