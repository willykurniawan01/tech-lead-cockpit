// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskPeakStore } from './task-peaks.ts';

describe('TaskPeakStore', () => {
  let dir = '';
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'tlc-peaks-'))));
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('only ever raises, ignores junk, and survives concurrent raises', async () => {
    const store = new TaskPeakStore(join(dir, 'sub', 'task-peaks.json'));
    expect(await store.read()).toEqual({});
    await Promise.all([store.raise({ 'tad::A': 'review' }), store.raise({ 'tad::B': 'in_progress' }), store.raise({ 'tad::A': 'merged', 'tad::C': 'todo', 'tad::D': 'bogus' })]);
    expect(await store.read()).toEqual({ 'tad::A': 'merged', 'tad::B': 'in_progress' });
    await store.raise({ 'tad::A': 'in_progress' });
    expect((await store.read())['tad::A']).toBe('merged');
    expect(JSON.parse(await readFile(join(dir, 'sub', 'task-peaks.json'), 'utf8'))).toEqual({ 'tad::A': 'merged', 'tad::B': 'in_progress' });
  });
});
