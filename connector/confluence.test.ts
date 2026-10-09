import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfluenceClient } from './confluence.ts';

describe('Confluence Connector Module', () => {
  const config = {
    baseUrl: 'https://acme.atlassian.net/wiki',
    flavor: 'cloud' as const,
    auth: 'basic' as const,
    email: 'user@example.com',
    token: 'fake-token-123',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('withMentionNames', () => {
    it('extracts display name from plain-text-link-body CDATA without making network requests', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const client = new ConfluenceClient(config);
      const storage = '<ac:link><ri:user ri:account-id="acc-123" /><ac:plain-text-link-body><![CDATA[@Ridwan Dev]]></ac:plain-text-link-body></ac:link>';
      const result = await client.withMentionNames(storage);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toContain('data-display-name="Ridwan Dev"');
    });

    it('matches ri:user even when ri:local-id is placed before ri:account-id', async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      const client = new ConfluenceClient(config);
      const storage = '<ac:link><ri:user ri:local-id="f364-abcd" ri:account-id="acc-123" /><ac:link-body>@Willy K</ac:link-body></ac:link>';
      const result = await client.withMentionNames(storage);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toContain('ri:local-id="f364-abcd"');
      expect(result).toContain('ri:account-id="acc-123"');
      expect(result).toContain('data-display-name="Willy K"');
    });

    it('queries Confluence user API when no link body is present', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          displayName: 'Guntur Tech Lead',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new ConfluenceClient(config);
      const storage = '<ac:link><ri:user ri:account-id="acc-456" /></ac:link>';
      const result = await client.withMentionNames(storage);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://acme.atlassian.net/wiki/rest/api/user?accountId=acc-456',
        expect.anything(),
      );
      expect(result).toContain('data-display-name="Guntur Tech Lead"');
    });

    it('falls back to fallbackLookup (e.g. Jira) when Confluence user API fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      }));

      const fallback = vi.fn().mockResolvedValue('Fallback Jira User');
      const client = new ConfluenceClient(config);
      const storage = '<ac:link><ri:user ri:account-id="acc-789" /></ac:link>';
      const result = await client.withMentionNames(storage, fallback);

      expect(fallback).toHaveBeenCalledWith('acc-789');
      expect(result).toContain('data-display-name="Fallback Jira User"');
    });
  });

  describe('searchUsers', () => {
    it('returns empty array when query is empty', async () => {
      const client = new ConfluenceClient(config);
      expect(await client.searchUsers('')).toEqual([]);
      expect(await client.searchUsers('   ')).toEqual([]);
    });

    it('searches users via CQL on Cloud', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              user: {
                accountId: 'acc-111',
                displayName: 'Alice Engineer',
                email: 'alice@example.com',
              },
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = new ConfluenceClient(config);
      const results = await client.searchUsers('Alice');

      expect(results).toEqual([
        {
          accountId: 'acc-111',
          displayName: 'Alice Engineer',
          email: 'alice@example.com',
        },
      ]);
    });
  });
});
