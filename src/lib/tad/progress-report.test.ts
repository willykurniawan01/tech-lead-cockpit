import { describe, expect, it } from 'vitest';
import type { JiraIssue } from '../jira/types';
import type { MrSummary } from '../gitlab/types';
import {
  calculateCombinedSummary,
  calculateTadDevProgress,
  applyTaskPeaks,
  getTaskDevProgress,
  jiraDevStage,
  type ProgressSummary,
  type ProgressTaskRow,
  type TadProgressData,
} from './progress-report';

const sampleRow1: ProgressTaskRow = {
  task: {
    no: '1',
    title: 'Implement Auth Endpoint',
    service: 'CORE-USER-AUTH',
    jiraKeys: ['MP-101'],
  },
  issues: [
    {
      key: 'MP-101',
      issue: {
        key: 'MP-101',
        summary: 'Auth Endpoint',
        status: 'Done',
        statusCategory: 'done',
        assignee: { displayName: 'Willy Kurniawan' },
      } as unknown as JiraIssue,
    },
  ],
  mrs: [
    {
      ref: 'backend/auth!10',
      projectPath: 'backend/auth',
      iid: 10,
      title: 'Add auth endpoint',
      state: 'merged',
      webUrl: 'https://gitlab.com/backend/auth/-/merge_requests/10',
      hasConflicts: false,
    } as unknown as MrSummary,
  ],
  flags: [],
};

const sampleRow2: ProgressTaskRow = {
  task: {
    no: '2',
    title: 'Add Payment Callback',
    service: 'CORE-PAYMENT',
    jiraKeys: ['MP-102'],
  },
  issues: [
    {
      key: 'MP-102',
      issue: {
        key: 'MP-102',
        summary: 'Payment Callback',
        status: 'In Progress',
        statusCategory: 'indeterminate',
        assignee: { displayName: 'Dev B' },
      } as unknown as JiraIssue,
    },
  ],
  mrs: [
    {
      ref: 'backend/payment!25',
      projectPath: 'backend/payment',
      iid: 25,
      title: 'Payment callback',
      state: 'opened',
      webUrl: 'https://gitlab.com/backend/payment/-/merge_requests/25',
      hasConflicts: true,
    } as unknown as MrSummary,
  ],
  flags: [{ tone: 'err', text: 'MR punya konflik' }],
};

const sampleRow3: ProgressTaskRow = {
  task: {
    no: '3',
    title: 'Bank Reconciliation Job',
    service: 'SETTLEMENT',
    jiraKeys: ['MP-201'],
  },
  issues: [
    {
      key: 'MP-201',
      issue: {
        key: 'MP-201',
        summary: 'Bank Reconciliation',
        status: 'Done',
        statusCategory: 'done',
        assignee: { displayName: 'Dev C' },
      } as unknown as JiraIssue,
    },
  ],
  mrs: [
    {
      ref: 'backend/settlement!5',
      projectPath: 'backend/settlement',
      iid: 5,
      title: 'Recon job',
      state: 'merged',
      webUrl: 'https://gitlab.com/backend/settlement/-/merge_requests/5',
      hasConflicts: false,
    } as unknown as MrSummary,
  ],
  flags: [],
};

describe('getTaskDevProgress & calculateTadDevProgress', () => {
  it('correctly determines progress stage and percentage', () => {
    expect(getTaskDevProgress(sampleRow1)).toEqual({
      stage: 'merged',
      percent: 100,
      stageLabel: 'Dev Selesai (Merged)',
    });
    expect(getTaskDevProgress(sampleRow2)).toEqual({
      stage: 'review',
      percent: 75,
      stageLabel: 'Review / QA',
    });
    expect(calculateTadDevProgress([sampleRow1, sampleRow2])).toBe(88);
  });
});

describe('progress from code and Jira together', () => {
  const issue = (status: string, statusCategory = 'indeterminate') => ({ key: 'PRM-1', issue: { id: '1', key: 'PRM-1', summary: '', status, statusCategory, issueType: 'Task', updated: '' } as never });
  const mr = (state: 'opened' | 'merged', draft = false) => ({ ref: `g/p!${state}`, iid: 1, title: 't', state, draft, projectPath: 'g/p', webUrl: 'u', sourceBranch: 'b' }) as never;
  const row = (issues: ReturnType<typeof issue>[], mrs: never[] = []) => ({ task: { no: '1', service: '', title: 't', jiraKeys: issues.map((i) => i.key) }, issues, mrs, flags: [] });

  it('maps Jira statuses to dev stages', () => {
    expect(jiraDevStage({ status: 'READY TO TEST', statusCategory: 'indeterminate' })).toBe('merged');
    expect(jiraDevStage({ status: 'IN QA', statusCategory: 'indeterminate' })).toBe('merged');
    expect(jiraDevStage({ status: 'UAT', statusCategory: 'indeterminate' })).toBe('merged');
    expect(jiraDevStage({ status: 'Done', statusCategory: 'done' })).toBe('merged');
    expect(jiraDevStage({ status: 'IN REVIEW TL', statusCategory: 'indeterminate' })).toBe('review');
    expect(jiraDevStage({ status: 'In Progress', statusCategory: 'indeterminate' })).toBe('in_progress');
    expect(jiraDevStage({ status: 'Code Not Pass', statusCategory: 'indeterminate' })).toBe('in_progress');
    expect(jiraDevStage({ status: 'Failed QA', statusCategory: 'indeterminate' })).toBe('in_progress');
    expect(jiraDevStage({ status: 'To Do', statusCategory: 'new' })).toBeNull();
    expect(jiraDevStage({ status: 'Backlog', statusCategory: 'new' })).toBeNull();
  });

  it('takes the furthest of code and Jira', () => {
    // All tickets Ready to Test but no MR detected: dev is done.
    expect(getTaskDevProgress(row([issue('READY TO TEST')]))).toMatchObject({ stage: 'merged', percent: 100, stageLabel: 'Dev Selesai (Jira: READY TO TEST)' });
    // Jira behind the code: the code wins.
    expect(getTaskDevProgress(row([issue('To Do', 'new')], [mr('opened')])).stage).toBe('review');
    expect(getTaskDevProgress(row([issue('In Progress')], [mr('merged')])).stage).toBe('merged');
    // Several tickets: the least advanced one counts.
    expect(getTaskDevProgress(row([issue('READY TO TEST'), { ...issue('In Progress'), key: 'PRM-2' }])).stage).toBe('in_progress');
    expect(calculateTadDevProgress([row([issue('READY TO TEST')]), row([issue('IN QA')])])).toBe(100);
  });
});

describe('progress never drops when a task goes back', () => {
  const issue = (status: string, statusCategory = 'indeterminate') => ({ key: 'PRM-1', issue: { id: '1', key: 'PRM-1', summary: '', status, statusCategory, issueType: 'Task', updated: '' } as never });
  const row = (title: string, status: string, statusCategory?: string) => ({ task: { no: '1', service: '', title, jiraKeys: ['PRM-1'] }, issues: [issue(status, statusCategory)], mrs: [], flags: [] });

  it('holds each task at the furthest stage it reached, and reports new peaks', () => {
    // First load: tickets at Ready to Test and In Review are recorded.
    const first = applyTaskPeaks('tad1', [row('A', 'READY TO TEST'), row('B', 'IN REVIEW TL'), row('C', 'To Do', 'new')], {});
    expect(first.raised).toEqual({ 'tad1::A': 'merged', 'tad1::B': 'review' });

    // QA sends A back and B is reopened: both keep their progress.
    const back = applyTaskPeaks('tad1', [row('A', 'Code Not Pass'), row('B', 'To Do', 'new'), row('C', 'To Do', 'new')], first.raised);
    expect(back.raised).toEqual({});
    expect(getTaskDevProgress(back.rows[0])).toMatchObject({ stage: 'merged', percent: 100, stageLabel: 'Dev Selesai · tidak turun (Jira sekarang: Code Not Pass)' });
    expect(getTaskDevProgress(back.rows[1])).toMatchObject({ stage: 'review', percent: 75 });
    expect(calculateTadDevProgress(back.rows)).toBe(58);

    // Moving further still raises the peak.
    expect(applyTaskPeaks('tad1', [row('B', 'IN QA')], first.raised).raised).toEqual({ 'tad1::B': 'merged' });
  });
});
