import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraClient, JiraError, extractTextFromAdf } from './jira.ts';

describe('Jira Connector Module', () => {
  describe('extractTextFromAdf', () => {
    it('returns empty string for null or empty input', () => {
      expect(extractTextFromAdf(null)).toBe('');
      expect(extractTextFromAdf('')).toBe('');
    });

    it('returns plain string if input is already string', () => {
      expect(extractTextFromAdf('Test description')).toBe('Test description');
    });

    it('extracts text from ADF paragraph nodes', () => {
      const adf = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'World' },
            ],
          },
        ],
      };
      expect(extractTextFromAdf(adf).trim()).toBe('Hello World');
    });

    it('extracts bullet list items', () => {
      const adf = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }],
              },
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }],
              },
            ],
          },
        ],
      };
      const text = extractTextFromAdf(adf);
      expect(text).toContain('Item 1');
      expect(text).toContain('Item 2');
    });
  });

  describe('JiraClient', () => {
    const config = {
      baseUrl: 'https://acme.atlassian.net',
      flavor: 'cloud' as const,
      auth: 'basic' as const,
      email: 'user@example.com',
      token: 'fake-token-123',
    };

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('fetches currentUser successfully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          accountId: 'acc-123',
          displayName: 'Willy Kurniawan',
          emailAddress: 'user@example.com',
          active: true,
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new JiraClient(config);
      const user = await client.currentUser();

      expect(user.displayName).toBe('Willy Kurniawan');
      expect(user.accountId).toBe('acc-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://acme.atlassian.net/rest/api/3/myself',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        })
      );
    });

    it('searches issues and maps them accurately', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          total: 1,
          issues: [
            {
              id: '1001',
              key: 'MP-42',
              fields: {
                summary: 'Migrasi Plan Merchant App',
                status: { name: 'In Progress', statusCategory: { name: 'In Progress', colorName: 'yellow' } },
                issuetype: { name: 'Task', iconUrl: 'https://icon' },
                priority: { name: 'High' },
                assignee: { displayName: 'Willy Kurniawan', emailAddress: 'user@example.com' },
                project: { key: 'MP', name: 'Acme' },
                updated: '2026-10-04T12:00:00Z',
              },
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new JiraClient(config);
      const issues = await client.searchIssues('assignee = currentUser()');

      expect(issues).toHaveLength(1);
      expect(issues[0].key).toBe('MP-42');
      expect(issues[0].summary).toBe('Migrasi Plan Merchant App');
      expect(issues[0].status).toBe('In Progress');
      expect(issues[0].url).toBe('https://acme.atlassian.net/browse/MP-42');
    });

    it('throws unauthorized JiraError on 401', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }));

      const client = new JiraClient(config);
      await expect(client.currentUser()).rejects.toThrow(JiraError);
      await expect(client.currentUser()).rejects.toThrow('Token ditolak Jira (401)');
    });

    it('getUser looks up user by accountId successfully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          accountId: 'acc-456',
          displayName: 'Ridwan',
          emailAddress: 'ridwan@example.com',
          active: true,
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new JiraClient(config);
      const user = await client.getUser('acc-456');

      expect(user?.displayName).toBe('Ridwan');
      expect(user?.accountId).toBe('acc-456');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://acme.atlassian.net/rest/api/3/user?accountId=acc-456',
        expect.anything(),
      );
    });

    it('getUser returns null on failure or empty id', async () => {
      const client = new JiraClient(config);
      expect(await client.getUser('')).toBeNull();

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      }));
      expect(await client.getUser('not-found-id')).toBeNull();
    });
    it('sets an assignee: accountId on Cloud, user name on Data Center, and reads current ones', async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('/search/jql')) return { ok: true, status: 200, json: async () => ({ issues: [{ key: 'MU-1', fields: { assignee: { accountId: 'acc-a', displayName: 'Agus' } } }, { key: 'MU-2', fields: { assignee: null } }], isLast: true }) };
        return { ok: true, status: 204, json: async () => ({}) };
      }));
      await new JiraClient(config).assignIssue('MU-1', 'acc-a');
      expect(calls[0].url).toBe('https://acme.atlassian.net/rest/api/3/issue/MU-1/assignee');
      expect(calls[0].init.method).toBe('PUT');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ accountId: 'acc-a' });
      await new JiraClient({ ...config, flavor: 'datacenter' as const }).assignIssue('MU-2', 'agus.s');
      expect(calls[1].url).toBe('https://acme.atlassian.net/rest/api/2/issue/MU-2/assignee');
      expect(JSON.parse(String(calls[1].init.body))).toEqual({ name: 'agus.s' });
      expect(await new JiraClient(config).assignees(['MU-1', 'MU-2', 'bad key'])).toEqual({ 'MU-1': { accountId: 'acc-a', displayName: 'Agus' }, 'MU-2': null });
      expect(decodeURIComponent(calls[2].url)).toContain('key in (MU-1,MU-2)');
    });
  });
});
