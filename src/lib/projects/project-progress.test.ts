import { describe, expect, it, vi } from 'vitest';
import type { TadProgressData } from '../tad/progress-report';

vi.mock('../../tad/drafts.svelte', () => ({ draftTitle: (d: { id: string }) => d.id }));
vi.mock('../tad/progress-data', () => ({ loadTadProgress: vi.fn() }));
vi.mock('./ops-tasks', () => ({ hasOpsSources: () => false, loadOpsProgress: vi.fn(), opsId: (id: string) => `ops:${id}`, OPS_TITLE: 'Tiket & Bug' }));
const { summarizeProgress } = await import('./project-progress');

const row = (keys: [string, string, string][]) => ({
  task: { no: '', service: '', title: keys.map((k) => k[0]).join('+') || 'tanpa', jiraKeys: keys.map((k) => k[0]) },
  issues: keys.map(([key, status, statusCategory]) => ({ key, issue: { id: key, key, summary: '', status, statusCategory, issueType: 'Task', updated: '' } as never })),
  mrs: [],
  flags: [],
});
const tad = (tadId: string, rows: ReturnType<typeof row>[]): TadProgressData => ({ tadId, tadTitle: tadId, summary: { tasks: rows.length, withMr: 0, merged: 0, done: 0, attention: 0 }, rows });

describe('summarizeProgress', () => {
  it('combines every TAD and the tickets & bugs, with stages and Jira statuses', () => {
    const p = summarizeProgress([
      tad('tad1', [row([['A-1', 'READY TO TEST', 'indeterminate']]), row([['A-2', 'READY TO TEST', 'indeterminate']])]),
      tad('ops:p1', [row([['A-3', 'In Review', 'indeterminate']]), row([['A-1', 'READY TO TEST', 'indeterminate']]), row([])]),
    ]);
    expect(p.percent).toBe(75); // (100+100+75+100+0) / 5
    expect(p.stages).toMatchObject({ merged: 3, review: 1, inProgress: 0, todo: 1, total: 5 });
    expect(p.parts).toEqual([
      { id: 'tad1', title: 'tad1', kind: 'tad', percent: 100, tasks: 2, statuses: ['READY TO TEST'] },
      { id: 'ops:p1', title: 'ops:p1', kind: 'ops', percent: 58, tasks: 3, statuses: ['IN REVIEW', 'READY TO TEST', '__none'] },
    ]);
    // Each ticket counted once; tasks without a ticket listed last.
    expect(p.statuses).toEqual([
      { status: 'READY TO TEST', category: 'indeterminate', count: 2 },
      { status: 'In Review', category: 'indeterminate', count: 1 },
      { status: 'Tanpa tiket Jira', category: 'none', count: 1 },
    ]);
  });
});
