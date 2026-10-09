// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MrSummary } from '../src/lib/gitlab/types.ts';
import { ManualMrs, type MrSource } from './gitlab-manual.ts';
import { parseMrUrl } from './gitlab.ts';

const mr = (projectPath: string, iid: number, state: MrSummary['state'], updatedAt = '2026-10-07T00:00:00Z'): MrSummary =>
  ({ ref: `${projectPath}!${iid}`, projectId: 1, projectPath, iid, title: `MR ${iid}`, state, draft: false, author: { id: 1, username: 'a', name: 'A' }, sourceBranch: 'fix', targetBranch: 'develop', webUrl: `https://gitlab.example.com/${projectPath}/-/merge_requests/${iid}`, createdAt: '', updatedAt }) as MrSummary;

describe('ManualMrs', () => {
  let dir = '';
  let states: Record<string, MrSummary['state']> = {};
  let down = false;
  const gitlab: MrSource = {
    mrSummary: async (p, iid) => {
      if (down) throw new Error('GitLab tidak terjangkau');
      const state = states[`${p}!${iid}`];
      if (!state) throw new Error('404 Not Found');
      return mr(p, iid, state, `t-${state}`);
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-manual-mr-'));
    states = { 'core/promo!12': 'opened', 'core/biller!7': 'merged' };
    down = false;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('links MRs after checking them in GitLab, without duplicates', async () => {
    const m = new ManualMrs(dir);
    await m.add('MU-2383', { projectPath: 'core/promo', iid: 12 }, gitlab);
    await m.add('MU-2383', { projectPath: 'core/promo', iid: 12 }, gitlab);
    const store = await m.add('MU-2383', { projectPath: 'core/biller', iid: 7 }, gitlab);
    expect(store['MU-2383'].map((l) => [l.projectPath, l.iid, l.last.state, l.last.manual])).toEqual([
      ['core/promo', 12, 'opened', true],
      ['core/biller', 7, 'merged', true],
    ]);
    await expect(m.add('MU-1', { projectPath: 'core/x', iid: 1 }, gitlab)).rejects.toThrow('tidak bisa dibaca');
    await expect(m.add('bukan key', { projectPath: 'core/promo', iid: 12 }, gitlab)).rejects.toThrow('Jira key');
    expect(Object.keys(await m.remove('MU-2383', 'core/promo!12'))).toEqual(['MU-2383']);
    expect(await m.remove('MU-2383', 'core/biller!7')).toEqual({});
  });

  it('merges links into detected MRs with fresh state, or the last known one when GitLab is down', async () => {
    const m = new ManualMrs(dir);
    await m.add('MU-2383', { projectPath: 'core/promo', iid: 12 }, gitlab);
    const detected = { 'MU-2383': [mr('core/biller', 7, 'merged')], 'MU-2384': [] };

    states['core/promo!12'] = 'merged';
    const fresh = await m.merge(['MU-2383', 'MU-2384'], detected, gitlab);
    expect(fresh['MU-2383'].map((x) => [x.ref, x.state, x.manual ?? false])).toEqual([
      ['core/biller!7', 'merged', false],
      ['core/promo!12', 'merged', true],
    ]);
    expect(fresh['MU-2384']).toEqual([]);
    // The refreshed state was stored.
    expect((await m.all())['MU-2383'][0].last.state).toBe('merged');

    down = true;
    const offline = await m.merge(['MU-2383'], {}, gitlab);
    expect(offline['MU-2383'].map((x) => x.state)).toEqual(['merged']);
    expect((await m.merge(['MU-2383'], {}, null))['MU-2383']).toHaveLength(1);
  });

  it('does not count an MR twice when it is also auto-detected', async () => {
    const m = new ManualMrs(dir);
    await m.add('MU-2383', { projectPath: 'core/biller', iid: 7 }, gitlab);
    const out = await m.merge(['MU-2383'], { 'MU-2383': [mr('core/biller', 7, 'merged')] }, gitlab);
    expect(out['MU-2383']).toHaveLength(1);
  });

  it('parses MR links of the configured GitLab only', () => {
    expect(parseMrUrl('https://gitlab.example.com/core/promo-ultimate/-/merge_requests/41/diffs', 'https://gitlab.example.com')).toEqual({ projectPath: 'core/promo-ultimate', iid: 41 });
    expect(parseMrUrl('https://github.com/x/y/pull/1', 'https://gitlab.example.com')).toBeNull();
  });
});
