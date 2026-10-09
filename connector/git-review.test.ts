// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveRepoPath } from './git-review.ts';

describe('resolveRepoPath', () => {
  it('resolves current workspace when repo is empty or tech-lead-cockpit', async () => {
    const res1 = await resolveRepoPath();
    expect(res1.repoName).toBe('tech-lead-cockpit');
    expect(res1.repoPath).toBe(process.cwd());

    const res2 = await resolveRepoPath('tech-lead-cockpit');
    expect(res2.repoName).toBe('tech-lead-cockpit');
    expect(res2.repoPath).toBe(process.cwd());
  });
});
