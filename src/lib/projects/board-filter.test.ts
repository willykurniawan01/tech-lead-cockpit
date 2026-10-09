import { describe, expect, it } from 'vitest';
import { matchesJiraStatus, NO_TICKET, statusOptions } from './board-filter.svelte';

const r = (...statuses: [string, string][]) => ({ issues: statuses.map(([key, status]) => ({ key, issue: { status } })) });

describe('Jira status filter', () => {
  it('lists statuses by count (each ticket once) with tasks without a ticket last', () => {
    expect(statusOptions([r(['A-1', 'Ready to Test']), r(['A-2', 'READY TO TEST']), r(['A-1', 'Ready to Test'], ['A-3', 'In QA']), r()])).toEqual([
      { value: 'READY TO TEST', label: 'Ready to Test', count: 2 },
      { value: 'IN QA', label: 'In QA', count: 1 },
      { value: NO_TICKET, label: 'Tanpa tiket Jira', count: 1 },
    ]);
  });

  it('matches case-insensitively, and NO_TICKET only tasks without a ticket', () => {
    expect(matchesJiraStatus(r(['A-1', 'In QA']).issues, '')).toBe(true);
    expect(matchesJiraStatus(r(['A-1', 'In QA']).issues, 'IN QA')).toBe(true);
    expect(matchesJiraStatus(r(['A-1', 'In QA']).issues, 'READY TO TEST')).toBe(false);
    expect(matchesJiraStatus(r().issues, NO_TICKET)).toBe(true);
    expect(matchesJiraStatus(r(['A-1', 'In QA']).issues, NO_TICKET)).toBe(false);
  });
});
