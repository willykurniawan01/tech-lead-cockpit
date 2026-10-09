// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { JiraClient } from './jira.ts';
import { TadTicketError, createTadTickets, templateFromIssues, validateTicketRequest } from './tad-tickets.ts';

const issue = (key: string, f: Record<string, unknown>) => ({ key, fields: { project: { key: key.split('-')[0] }, issuetype: { name: 'Task' }, ...f } });

describe('templateFromIssues', () => {
  it('copies the epic, type and labels most of the TAD tickets share', () => {
    const t = templateFromIssues([
      issue('MU-1', { parent: { key: 'MU-100', fields: { summary: 'Epic Promo' } }, labels: ['promo', 'q4'], components: [{ name: 'Backend' }] }),
      issue('MU-2', { parent: { key: 'MU-100', fields: { summary: 'Epic Promo' } }, labels: ['promo'], components: [{ name: 'Backend' }] }),
      issue('MU-3', { issuetype: { name: 'Story' }, labels: ['promo'] }),
      issue('OPS-9', { issuetype: { name: 'Bug' } }),
    ]);
    expect(t).toEqual({
      projectKey: 'MU',
      issueType: 'Task',
      parent: { key: 'MU-100', summary: 'Epic Promo' },
      labels: ['promo'],
      components: ['Backend'],
      basedOn: ['MU-1', 'MU-2', 'MU-3'],
    });
  });

  it('is empty without tickets', () => {
    expect(templateFromIssues([])).toMatchObject({ projectKey: undefined, labels: [], components: [] });
  });
});

describe('validateTicketRequest', () => {
  it('rejects bad keys and empty selections', () => {
    expect(() => validateTicketRequest({ projectKey: 'mu x', issueType: 'Task', items: [{ title: 'A', description: '' }] })).toThrow(TadTicketError);
    expect(() => validateTicketRequest({ projectKey: 'MU', issueType: 'Task', parentKey: 'epic', items: [{ title: 'A', description: '' }] })).toThrow(/Parent/);
    expect(() => validateTicketRequest({ projectKey: 'MU', issueType: 'Task', items: [{ title: '  ', description: '' }] })).toThrow(/Tidak ada task/);
    expect(validateTicketRequest({ projectKey: 'mu', issueType: 'Task', parentKey: 'mu-100', labels: ['tad promo', 'tad promo'], items: [{ title: ' A  B ', description: 'x' }] })).toEqual({
      projectKey: 'MU',
      issueType: 'Task',
      parentKey: 'MU-100',
      labels: ['tad-promo'],
      components: [],
      items: [{ title: 'A B', description: 'x' }],
    });
  });
});

describe('createTadTickets', () => {
  it('links an existing ticket with the same summary, creates the rest and keeps going after a failure', async () => {
    const created: unknown[] = [];
    const client = {
      searchRaw: vi.fn(async (jql: string) => (jql.includes('API Lama') ? [{ key: 'MU-5', fields: { summary: '[BACKEND][A][X] - API Lama' } }] : [{ key: 'MU-6', fields: { summary: 'Mirip tapi beda' } }])),
      createIssue: vi.fn(async (input: { summary: string }) => {
        if (input.summary.includes('Gagal')) throw new Error('Field parent tidak valid');
        created.push(input);
        return { key: 'MU-7', url: 'https://x/browse/MU-7' };
      }),
      browseUrl: (k: string) => `https://x/browse/${k}`,
    } as unknown as JiraClient;
    const audit = vi.fn(async () => {});
    const out = await createTadTickets(
      client,
      validateTicketRequest({
        projectKey: 'MU',
        issueType: 'Task',
        parentKey: 'MU-100',
        labels: ['promo'],
        items: [
          { title: '[BACKEND][A][X] - API Lama', description: 'a' },
          { title: '[BACKEND][A][X] - API Baru', description: 'b' },
          { title: '[BACKEND][A][X] - Gagal', description: 'c' },
        ],
      }),
      audit,
    );
    expect(out).toEqual([
      { title: '[BACKEND][A][X] - API Lama', key: 'MU-5', url: 'https://x/browse/MU-5', existed: true },
      { title: '[BACKEND][A][X] - API Baru', key: 'MU-7', url: 'https://x/browse/MU-7' },
      { title: '[BACKEND][A][X] - Gagal', error: 'Field parent tidak valid' },
    ]);
    expect(created).toEqual([{ projectKey: 'MU', issueType: 'Task', summary: '[BACKEND][A][X] - API Baru', description: 'b', parentKey: 'MU-100', labels: ['promo'], components: [] }]);
    // JQL operators in the summary are neutralised.
    expect((client.searchRaw as any).mock.calls[0][0]).toBe('project = MU AND summary ~ "BACKEND A X API Lama" ORDER BY created DESC');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'jira.create', result: 'success', jiraKeys: ['MU-5', 'MU-7'] }));
  });
});
