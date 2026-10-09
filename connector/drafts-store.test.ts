// @vitest-environment node
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DraftFileError, DraftFiles } from './drafts-store.ts';

const draft = (id: string, markdown = '# TAD') => ({ id, markdown, updatedAt: '2026-10-04T10:00:00.000Z', revisions: [] });

describe('DraftFiles', () => {
  let dir: string;
  let files: DraftFiles;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-drafts-'));
    files = new DraftFiles(join(dir, 'drafts'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('starts empty when the folder does not exist yet', async () => {
    expect(await files.list()).toEqual([]);
  });

  it('saves, overwrites and lists drafts', async () => {
    await files.save(draft('a1', '# v1'));
    await files.save(draft('a1', '# v2'));
    await files.save(draft('b2'));
    const list = await files.list();
    expect(list.map((d) => d.id).sort()).toEqual(['a1', 'b2']);
    expect(list.find((d) => d.id === 'a1')?.markdown).toBe('# v2');
    expect((await readdir(files.dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects malformed drafts and path-like ids', async () => {
    await expect(files.save({ id: '../evil', markdown: '', updatedAt: '' })).rejects.toBeInstanceOf(DraftFileError);
    await expect(files.save({ id: 'ok' })).rejects.toBeInstanceOf(DraftFileError);
    await expect(files.remove('../../etc')).rejects.toBeInstanceOf(DraftFileError);
  });

  it('moves deleted drafts to .trash instead of erasing them', async () => {
    await files.save(draft('gone'));
    await files.remove('gone');
    await files.remove('never-existed');
    expect(await files.list()).toEqual([]);
    const trash = await readdir(join(files.dir, '.trash'));
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatch(/^gone-\d+\.json$/);
  });

  it('skips corrupt files instead of failing the whole list', async () => {
    await files.save(draft('good'));
    await writeFile(join(files.dir, 'bad.json'), '{not json');
    expect((await files.list()).map((d) => d.id)).toEqual(['good']);
  });
});
