import { describe, expect, it } from 'vitest';
import { jiraAssignTargets, splitByCurrent } from './jira-assign';
import type { EstimateProject } from './types';

const dev = (id: string, name: string, accountId?: string) => ({ id, name, role: 'BACKEND', allocation: 1, ...(accountId ? { jira: { accountId, displayName: name } } : {}) });
const task = (id: string, assigneeId?: string, effortDays: number | null = 2) => ({ id, draftId: 'd', title: id, service: 's', role: 'BACKEND', effortDays, dependsOn: [], ...(assigneeId ? { assigneeId } : {}) });

describe('assign in Jira from the estimate', () => {
  const project = {
    developers: [dev('a', 'Agus', 'acc-a'), dev('r', 'Ridwan', 'acc-r'), dev('x', 'Tanpa Jira')],
    tasks: [task('t1', 'a'), task('t2', 'r'), task('t3', 'x'), task('t4', 'a'), task('t5'), task('t6', 'a'), task('t7', 'r')],
  } as unknown as EstimateProject;
  const scope = [
    { id: 't1', jiraKeys: ['MU-1'] },
    { id: 't2', jiraKeys: ['MU-2'] },
    { id: 't3', jiraKeys: ['MU-3'] },
    { id: 't4', jiraKeys: [] },
    { id: 't5', jiraKeys: ['MU-5'] },
    // One ticket for two tasks with different developers.
    { id: 't6', jiraKeys: ['MU-6'] },
    { id: 't7', jiraKeys: ['MU-6'] },
  ];

  it('takes only hand-assigned tasks with a ticket and a linked developer', () => {
    const r = jiraAssignTargets(project, scope);
    expect(r.targets).toEqual([
      { key: 'MU-1', taskTitle: 't1', developer: 'Agus', accountId: 'acc-a' },
      { key: 'MU-2', taskTitle: 't2', developer: 'Ridwan', accountId: 'acc-r' },
    ]);
    expect(r.noKey).toEqual(['t4']);
    expect(r.noAccount).toEqual([{ taskTitle: 't3', developer: 'Tanpa Jira' }]);
    expect(r.conflicts).toEqual([{ key: 'MU-6', developers: ['Agus', 'Ridwan'] }]);
    expect(r.unassigned).toBe(1);
  });

  it('sends only what differs from Jira', () => {
    const { targets } = jiraAssignTargets(project, scope);
    const s = splitByCurrent([...targets, { key: 'MU-9', taskTitle: 'x', developer: 'Agus', accountId: 'acc-a' }], { 'MU-1': { accountId: 'acc-a', displayName: 'Agus' }, 'MU-2': { accountId: 'acc-z', displayName: 'Zaki' } });
    expect(s.same.map((x) => x.key)).toEqual(['MU-1']);
    expect(s.change).toEqual([{ key: 'MU-2', taskTitle: 't2', developer: 'Ridwan', accountId: 'acc-r', current: 'Zaki' }]);
    expect(s.missing).toEqual(['MU-9']);
    expect(splitByCurrent(targets.slice(1), { 'MU-2': null }).change[0].current).toBeNull();
  });
});
