// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../src/lib/confluence/api-types.ts';
import { transitionWithChecks } from './jira-transition.ts';

function fakeJira(status: string) {
  const moved: string[] = [];
  return {
    moved,
    getIssue: async () => ({ status }),
    getTransitions: async () => [
      { id: '21', name: 'Start', to: { id: '3', name: 'In Progress' } },
      { id: '31', name: 'Send to QA', to: { id: '4', name: 'Ready for QA' } },
    ],
    transitionIssue: async (_k: string, id: string) => void moved.push(id),
  };
}

describe('transitionWithChecks', () => {
  it('moves the issue and audits it with the MR it came from', async () => {
    const jc = fakeJira('Code Review');
    const audit: AuditEvent[] = [];
    const res = await transitionWithChecks(jc, { key: 'MU-1', transitionId: '31', mrUrl: 'https://gitlab/x/-/merge_requests/5', headSha: 'abc', expectedStatus: 'Code Review' }, async (e) => void audit.push(e));
    expect(res).toEqual({ ok: true, from: 'Code Review', to: 'Ready for QA' });
    expect(jc.moved).toEqual(['31']);
    expect(audit[0]).toMatchObject({ action: 'jira.transition', result: 'success', title: 'MU-1: Code Review → Ready for QA', headSha: 'abc', jiraKeys: ['MU-1'] });
  });

  it('refuses a transition Jira no longer offers', async () => {
    const jc = fakeJira('Code Review');
    await expect(transitionWithChecks(jc, { key: 'MU-1', transitionId: '99' }, async () => {})).rejects.toMatchObject({ status: 409 });
    expect(jc.moved).toEqual([]);
  });

  it('refuses when the issue moved since the user looked', async () => {
    const jc = fakeJira('Done');
    await expect(transitionWithChecks(jc, { key: 'MU-1', transitionId: '31', expectedStatus: 'Code Review' }, async () => {})).rejects.toThrow(/sudah berubah menjadi "Done"/);
    expect(jc.moved).toEqual([]);
  });

  it('audits failures from Jira', async () => {
    const jc = { ...fakeJira('Code Review'), transitionIssue: async () => Promise.reject(new Error('boom')) };
    const audit: AuditEvent[] = [];
    await expect(transitionWithChecks(jc, { key: 'MU-1', transitionId: '21' }, async (e) => void audit.push(e))).rejects.toThrow('boom');
    expect(audit[0]).toMatchObject({ result: 'failure', error: 'boom' });
  });
});
