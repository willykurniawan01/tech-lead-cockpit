import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugCase } from '../bugs/types';
import type { MrSummary } from '../gitlab/types';
import type { JiraIssue } from '../jira/types';
import { getTaskDevProgress, type ProgressTaskRow } from '../tad/progress-report';

const issuesFn = vi.fn<(jql?: string, max?: number) => Promise<JiraIssue[]>>();
const mrsFn = vi.fn<(keys: string[]) => Promise<Record<string, MrSummary[]>>>();
const bugGet = vi.fn<(id: string) => Promise<BugCase>>();
vi.mock('../jira/client', () => ({ jira: { issues: (jql?: string, max?: number) => issuesFn(jql, max) } }));
vi.mock('../gitlab/client', () => ({ gitlab: { mrsForKeys: (k: string[]) => mrsFn(k) } }));
vi.mock('../bugs/client', () => ({ bugs: { get: (id: string) => bugGet(id) } }));

const { loadOpsProgress, opsJql, rowRef, hasOpsSources } = await import('./ops-tasks');

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({ id: key, key, summary: `Ringkasan ${key}`, status: 'To Do', statusCategory: 'new', issueType: 'Bug', updated: '', ...over }) as JiraIssue;
const mr = (state: MrSummary['state'], over: Partial<MrSummary> = {}): MrSummary => ({ ref: `g/p!${state}`, iid: 1, title: 't', state, draft: false, projectPath: 'g/p', webUrl: 'u', sourceBranch: 'b', ...over }) as MrSummary;

describe('opsJql', () => {
  it('builds the ticket filter', () => {
    expect(opsJql({ projectKey: 'MU', issueTypes: ['Bug', 'Task'], label: 'bug"fix', epicKey: 'MU-9', activeSprint: true, doneDays: 7 })).toBe(
      'project = MU AND issuetype in ("Bug", "Task") AND labels = "bugfix" AND parent = MU-9 AND sprint in openSprints() AND (statusCategory != Done OR resolved >= -7d) ORDER BY updated DESC',
    );
    expect(opsJql({ projectKey: 'MU', issueTypes: [] })).toBe('project = MU AND (statusCategory != Done OR resolved >= -14d) ORDER BY updated DESC');
  });

  it('knows when a project has sources besides its TADs', () => {
    expect(hasOpsSources({})).toBe(false);
    expect(hasOpsSources({ manualTasks: [{ id: '1', title: 'x', createdAt: '' }] })).toBe(true);
  });
});

describe('progress rules for tasks outside a TAD', () => {
  const row = (over: Partial<ProgressTaskRow>): ProgressTaskRow => ({ task: { no: '', service: '', title: 't', jiraKeys: [] }, issues: [], mrs: [], flags: [], ...over });
  it('counts merged MRs, manual done and Jira Done as finished', () => {
    expect(getTaskDevProgress(row({ mrs: [mr('merged')] })).stage).toBe('merged');
    expect(getTaskDevProgress(row({ source: 'manual', manualDone: true })).stage).toBe('merged');
    const done = { key: 'MU-1', issue: issue('MU-1', { status: 'Done', statusCategory: 'done' }) };
    expect(getTaskDevProgress(row({ source: 'jira', issues: [done] })).stageLabel).toBe('Dev Selesai (Jira: Done)');
  });
});

describe('loadOpsProgress', () => {
  beforeEach(() => {
    issuesFn.mockReset();
    mrsFn.mockReset();
    bugGet.mockReset();
  });

  it('merges Jira tickets, bug tasks and manual tasks; bug/manual keys replace the ticket row', async () => {
    bugGet.mockImplementation(async (id) => {
      if (id !== 'case1') throw new Error('not found');
      return {
        id: 'case1',
        title: 'Saldo dobel',
        status: 'fixing',
        tasks: [{ id: 't1', title: 'Fix', repo: 'core-payment', status: 'fixing', jira: { key: 'MU-2', url: '', createdAt: '' }, coderRunIds: [] }],
      } as unknown as BugCase;
    });
    issuesFn.mockImplementation(async (jql) => (jql?.startsWith('project') ? [issue('MU-1'), issue('MU-2'), issue('MU-4', { statusCategory: 'done' })] : [issue('MU-3')]));
    mrsFn.mockResolvedValue({ 'MU-1': [mr('opened')] });

    const p = await loadOpsProgress({
      id: 'p1',
      jiraFilter: { projectKey: 'MU', issueTypes: ['Bug'] },
      bugCaseIds: ['case1', 'gone'],
      manualTasks: [
        { id: 'm1', title: 'Naikkan timeout', jiraKey: 'MU-3', createdAt: '' },
        { id: 'm2', title: 'Rapikan config', done: true, createdAt: '' },
      ],
    });

    expect(p.tadId).toBe('ops:p1');
    expect(p.missingBugCases).toEqual(['gone']);
    expect(p.rows.map((r) => [r.task.no, r.source])).toEqual([
      ['bug:case1:t1', 'bug'],
      ['manual:m1', 'manual'],
      ['manual:m2', 'manual'],
      ['jira:MU-1', 'jira'],
      ['jira:MU-4', 'jira'],
    ]);
    const stage = (no: string) => getTaskDevProgress(p.rows.find((r) => r.task.no === no)!).stage;
    expect(stage('bug:case1:t1')).toBe('in_progress');
    expect(stage('manual:m2')).toBe('merged');
    expect(stage('jira:MU-1')).toBe('review');
    expect(stage('jira:MU-4')).toBe('merged');
    // A manual task without a ticket is not nagged for a missing Jira key.
    expect(p.rows.find((r) => r.task.no === 'manual:m2')!.flags).toEqual([]);
    expect(rowRef(p.rows[0])).toEqual({ source: 'bug', id: 'case1', taskId: 't1' });
    expect(mrsFn).toHaveBeenCalledWith(['MU-2', 'MU-3', 'MU-1', 'MU-4']);
  });

  it('reports a Jira failure without dropping the other sources', async () => {
    issuesFn.mockRejectedValue(new Error('Jira tidak terjangkau'));
    mrsFn.mockResolvedValue({});
    const p = await loadOpsProgress({ id: 'p1', jiraFilter: { projectKey: 'MU', issueTypes: [] }, manualTasks: [{ id: 'm1', title: 'A', createdAt: '' }] });
    expect(p.jiraError).toBe('Jira tidak terjangkau');
    expect(p.rows).toHaveLength(1);
  });
});
