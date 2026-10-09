// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { detectRisks, extractJiraKeys, GitLabClient, GitLabError, parseMrUrl } from './gitlab.ts';
import { buildMrReviewPrompt, REVIEW_STRICTNESS_OPTIONS } from '../src/lib/gitlab/types.ts';

const BASE = 'https://gitlab.example.com';

describe('parseMrUrl', () => {
  it('reads nested project paths and the iid', () => {
    expect(parseMrUrl('https://gitlab.example.com/backend-private/core-fds-ultimate/-/merge_requests/121', BASE)).toEqual({
      projectPath: 'backend-private/core-fds-ultimate',
      iid: 121,
    });
    expect(parseMrUrl('https://gitlab.example.com/a/b/c/-/merge_requests/7/diffs?commit_id=x', BASE)).toEqual({ projectPath: 'a/b/c', iid: 7 });
  });

  it('refuses other hosts so the token is never sent elsewhere', () => {
    expect(parseMrUrl('https://gitlab.com/a/b/-/merge_requests/1', BASE)).toBeNull();
    expect(parseMrUrl('https://evil.example/backend/x/-/merge_requests/1', BASE)).toBeNull();
    expect(parseMrUrl('not a url', BASE)).toBeNull();
    expect(parseMrUrl('https://gitlab.example.com/backend/x/-/issues/1', BASE)).toBeNull();
  });
});

describe('extractJiraKeys', () => {
  it('collects unique keys from branch, title and commits, skipping look-alikes', () => {
    expect(extractJiraKeys('feature/MU-12-otp', 'MU-12: OTP + PAY-7', 'encode as UTF-8, hash SHA-256', 'fix MU-12 again')).toEqual(['MU-12', 'PAY-7']);
  });
});

describe('detectRisks', () => {
  const c = (newPath: string, additions = 1, deletions = 0) => ({ newPath, oldPath: newPath, additions, deletions });

  it('flags sensitive areas with the files involved', () => {
    const risks = detectRisks([
      c('app/Http/Middleware/AuthToken.php'),
      c('database/migrations/2026_10_01_add_pin.php'),
      c('internal/payment/qris_service.go'),
      c('.gitlab-ci.yml'),
      c('routes/api.php'),
      c('.env.example'),
    ]);
    const kinds = risks.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['auth', 'database', 'payment', 'infra', 'api', 'config', 'tests']));
    expect(risks.find((r) => r.kind === 'payment')?.files).toEqual(['internal/payment/qris_service.go']);
  });

  it('does not flag missing tests when tests changed, and flags big MRs', () => {
    expect(detectRisks([c('src/a.ts'), c('src/a.test.ts')]).map((r) => r.kind)).not.toContain('tests');
    expect(detectRisks([c('docs/a.md', 2000)]).map((r) => r.kind)).toContain('size');
  });
});

describe('GitLabClient', () => {
  type Route = (url: URL) => { status?: number; body: unknown; headers?: Record<string, string> };
  const fakeFetch = (routes: Record<string, Route>, seen: string[] = []) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(`${url.pathname}${url.search}`);
      expect((init?.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('tok');
      const key = Object.keys(routes).find((k) => url.pathname.endsWith(k));
      if (!key) return new Response('{}', { status: 404 });
      const r = routes[key](url);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
    }) as typeof fetch;

  const apiMr = {
    id: 1,
    iid: 5,
    project_id: 9,
    title: 'MU-3 add OTP',
    description: 'Implements PAY-1',
    state: 'opened',
    author: { id: 2, username: 'agus', name: 'Agus' },
    source_branch: 'feature/MU-3',
    target_branch: 'staging',
    web_url: `${BASE}/backend/user-auth/-/merge_requests/5`,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    references: { full: 'backend/user-auth!5' },
    sha: 'abc',
    head_pipeline: { id: 77, status: 'failed', web_url: 'p' },
    reviewers: [{ id: 3, username: 'willy', name: 'Willy' }],
    labels: ['backend'],
  };

  it('builds MR detail from paginated diffs, commits and approvals', async () => {
    const seen: string[] = [];
    const client = new GitLabClient(
      { baseUrl: BASE, token: 'tok' },
      fakeFetch(
        {
          '/merge_requests/5': () => ({ body: apiMr }),
          '/merge_requests/5/commits': () => ({ body: [{ id: 'c1', short_id: 'c1', title: 'fix PAY-2', author_name: 'Agus', created_at: '' }] }),
          '/merge_requests/5/approvals': () => ({ body: { approved: false, approved_by: [], approvals_left: 1 } }),
          '/merge_requests/5/diffs': (u) =>
            u.searchParams.get('page') === '1'
              ? { body: [{ old_path: 'a.go', new_path: 'a.go', new_file: false, renamed_file: false, deleted_file: false, diff: '@@\n+x\n+y\n-z\n' }], headers: { 'x-next-page': '2' } }
              : { body: [{ old_path: 'big.json', new_path: 'big.json', new_file: true, renamed_file: false, deleted_file: false, diff: '', too_large: true }] },
        },
        seen,
      ),
    );
    const mr = await client.mr('backend/user-auth', 5);
    expect(seen[0]).toBe('/api/v4/projects/backend%2Fuser-auth/merge_requests/5');
    expect(mr.ref).toBe('backend/user-auth!5');
    expect(mr.pipeline?.status).toBe('failed');
    expect(mr.changes).toHaveLength(2);
    expect(mr.totals).toEqual({ files: 2, additions: 2, deletions: 1 });
    expect(mr.diffTruncated).toBe(true);
    expect(mr.changes[1].truncated).toBe(true);
    expect(mr.jiraKeys).toEqual(['MU-3', 'PAY-1', 'PAY-2']);
    expect(mr.approvals).toMatchObject({ approved: false, left: 1 });
  });

  it('falls back to /changes on GitLab versions without /diffs', async () => {
    const client = new GitLabClient(
      { baseUrl: BASE, token: 'tok' },
      fakeFetch({
        '/merge_requests/5': () => ({ body: apiMr }),
        '/merge_requests/5/changes': () => ({ body: { changes: [{ old_path: 'b.php', new_path: 'b.php', new_file: false, renamed_file: false, deleted_file: false, diff: '+1\n' }] } }),
        '/merge_requests/5/commits': () => ({ body: [] }),
      }),
    );
    expect((await client.mr('backend/user-auth', 5)).changes.map((c) => c.newPath)).toEqual(['b.php']);
  });

  it('explains auth failures', async () => {
    const client = new GitLabClient({ baseUrl: BASE, token: 'tok' }, fakeFetch({ '/user': () => ({ status: 401, body: {} }) }));
    await expect(client.currentUser()).rejects.toMatchObject({ status: 401, code: 'unauthorized' } satisfies Partial<GitLabError>);
  });

  it('lists MRs with different scopes including "all"', async () => {
    const seen: string[] = [];
    const client = new GitLabClient(
      { baseUrl: BASE, token: 'tok' },
      fakeFetch({
        '/merge_requests': (url) => {
          return { body: [apiMr] };
        },
      }, seen),
    );

    const me = { id: 3, username: 'willy', name: 'Willy' };

    const allMrs = await client.listMrs('all', me);
    expect(seen[0]).toContain('/api/v4/merge_requests?state=opened&scope=all&order_by=updated_at&per_page=100');
    expect(allMrs).toHaveLength(1);

    await client.listMrs('reviewer', me);
    expect(seen[1]).toContain('/api/v4/merge_requests?state=opened&scope=all&reviewer_id=3&order_by=updated_at&per_page=100');

    await client.listMrs('assigned', me);
    expect(seen[2]).toContain('/api/v4/merge_requests?state=opened&scope=assigned_to_me&order_by=updated_at&per_page=100');

    await client.listMrs('created', me);
    expect(seen[3]).toContain('/api/v4/merge_requests?state=opened&scope=created_by_me&order_by=updated_at&per_page=100');
  });
});

describe('buildMrReviewPrompt and REVIEW_STRICTNESS_OPTIONS', () => {
  it('defines 3 distinct strictness options', () => {
    expect(REVIEW_STRICTNESS_OPTIONS).toHaveLength(3);
    const ids = REVIEW_STRICTNESS_OPTIONS.map((o) => o.id);
    expect(ids).toEqual(['lenient', 'standard', 'strict']);
  });

  it('defaults to standard strictness when none specified', () => {
    const prompt = buildMrReviewPrompt();
    expect(prompt).toContain('STANDAR');
  });

  it('injects tailored instructions for each strictness level', () => {
    expect(buildMrReviewPrompt({ strictness: 'lenient' })).toContain('SANTAI');
    expect(buildMrReviewPrompt({ strictness: 'standard' })).toContain('STANDAR');
    expect(buildMrReviewPrompt({ strictness: 'strict' })).toContain('SANGAT KETAT');
  });

  it('includes custom instruction when provided', () => {
    const prompt = buildMrReviewPrompt({
      strictness: 'strict',
      customInstruction: 'Pastikan skema database backward-compatible',
    });
    expect(prompt).toContain('Pastikan skema database backward-compatible');
    expect(prompt).toContain('SANGAT KETAT');
  });
});


describe('GitLabClient.mrsForKeys', () => {
  it('matches keys in branch, title or description, then searches the rest', async () => {
    const seen: string[] = [];
    const mrBase = { project_id: 1, state: 'opened', author: { id: 1, username: 'a', name: 'A' }, target_branch: 'staging', created_at: '', updated_at: '' };
    const recent = [
      { ...mrBase, id: 1, iid: 1, title: 'feat: sof', source_branch: 'feature/MU-2434-sof', web_url: 'https://gitlab.example.com/b/core-tcico/-/merge_requests/1', references: { full: 'b/core-tcico!1' } },
      { ...mrBase, id: 2, iid: 2, title: 'MU-24345 other', source_branch: 'x', web_url: 'https://gitlab.example.com/b/x/-/merge_requests/2', references: { full: 'b/x!2' } },
    ];
    const searched = [{ ...mrBase, id: 3, iid: 9, title: 'old', description: 'closes MU-1', source_branch: 'y', state: 'merged', web_url: 'https://gitlab.example.com/b/y/-/merge_requests/9', references: { full: 'b/y!9' } }];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      seen.push(url.search);
      const body = url.searchParams.get('search') ? (url.searchParams.get('search') === 'MU-1' ? searched : []) : recent;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const out = await new GitLabClient({ baseUrl: BASE, token: 'tok' }, fetchImpl).mrsForKeys(['MU-2434', 'MU-1', 'MU-7']);
    expect(out['MU-2434'].map((m) => m.ref)).toEqual(['b/core-tcico!1']);
    expect(out['MU-1'].map((m) => [m.ref, m.state])).toEqual([['b/y!9', 'merged']]);
    expect(out['MU-7']).toEqual([]);
    expect(seen.filter((s) => s.includes('search=')).length).toBe(2);
  });
});
