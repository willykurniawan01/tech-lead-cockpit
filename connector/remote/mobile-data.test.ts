// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EstimateProject } from '../../src/lib/estimate/types.ts';
import type { MrSummary } from '../../src/lib/gitlab/types.ts';
import type { JiraIssue } from '../../src/lib/jira/types.ts';
import { TaskPeakStore } from '../task-peaks.ts';
import { connectorMobileData, type MobileSources } from './mobile-data.ts';

const TAD = `# Payment Revamp

## Development Scope

| No | Service | Task | Jira |
|----|---------|------|------|
| 1 | api | [BE][api] Create payment endpoint | PAY-1 |
| 2 | api | [BE][api] Refund flow | PAY-2 |
| 3 | web | [WEB-FE][cms] Payment page | |
`;

const issue = (key: string, status: string, statusCategory: string): JiraIssue => ({ id: key, key, summary: key, status, statusCategory, issueType: 'Task', updated: '', url: '' }) as JiraIssue;
const mr = (iid: number, state: MrSummary['state']): MrSummary =>
  ({ ref: `g/api!${iid}`, projectId: 1, projectPath: 'g/api', iid, title: `PAY MR ${iid}`, state, draft: false, author: { id: 1, username: 'a', name: 'Ana' }, sourceBranch: 'b', targetBranch: 'main', webUrl: 'https://gitlab/x', createdAt: '', updatedAt: '2026-10-07T00:00:00Z' }) as MrSummary;

const project: EstimateProject = {
  id: 'p1',
  name: 'Payment',
  draftIds: ['d1'],
  startDate: '2026-10-05',
  skipCutiBersama: true,
  developers: [{ id: 'dev1', name: 'Ana', role: 'BACKEND', allocation: 1 }],
  tasks: [
    { id: 'd1::[BE][api] Create payment endpoint', draftId: 'd1', title: '[BE][api] Create payment endpoint', service: 'api', role: 'BACKEND', effortDays: 2, dependsOn: [] },
    { id: 'd1::[BE][api] Refund flow', draftId: 'd1', title: '[BE][api] Refund flow', service: 'api', role: 'BACKEND', effortDays: 3, dependsOn: [] },
  ],
  createdAt: '',
  updatedAt: '',
};

describe('connectorMobileData', () => {
  let dir: string;
  let src: MobileSources;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-mobile-'));
    src = {
      dir,
      projects: async () => [project],
      holidays: async () => [],
      drafts: async () => [{ id: 'd1', markdown: TAD }],
      jiraIssues: vi.fn(async () => [issue('PAY-1', 'Done', 'done'), issue('PAY-2', 'Code Review', 'indeterminate')]),
      gitlabMrsForKeys: vi.fn(async () => ({ 'PAY-1': [mr(1, 'merged')], 'PAY-2': [] })),
      openMrs: async () => [mr(5, 'opened'), mr(5, 'opened')],
      agentTasks: async () => [
        { id: 'a', title: 'Old', status: 'completed', updatedAt: '2026-10-01T00:00:00Z' },
        { id: 'b', title: 'Live', status: 'running', updatedAt: '2026-10-02T00:00:00Z' },
      ],
      qaRuns: async () => [{ id: 'r', projectId: 'p1', projectName: 'Payment', environment: { id: 'e', name: 'staging', readOnly: true }, status: 'done', startedAt: '2026-10-07T01:00:00Z', flows: [], summary: { flows: 3, passedFlows: 2, failedFlows: 1, steps: 9, passedSteps: 8, failedSteps: 1 } }],
      sendWhatsApp: vi.fn(async () => {}),
      reportTargets: async () => ({ p1: { jid: '1203@g.us', name: 'Squad' } }),
    };
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('computes dev %, stages, attention and the target date with the app rules', async () => {
    const [p] = await connectorMobileData(src).projects();
    // Furthest of code and Jira: merged MR (100) + Jira "Code Review" without an MR (75) + todo (0) → 58%
    expect(p).toMatchObject({ id: 'p1', devPercent: 58, livePercent: 58, tasks: 3, stages: { merged: 1, review: 1, inProgress: 0, todo: 1 }, reportTarget: 'Squad', errors: [] });
    expect(p.attention.map((a) => a.task)).toEqual(['[BE][api] Refund flow', '[WEB-FE][cms] Payment page']);
    expect(p.attention[0].flags[0]).toMatch(/belum ada MR/);
    // 2 + 3 days for one developer from Mon 5 Oct → Fri 9 Oct; the FE task has no estimate yet.
    expect(p.targetDate).toBe('2026-10-09');
  });

  it('keeps the peak % when tickets bounce back (anti-regression), and reports GitLab outages', async () => {
    await connectorMobileData(src).projects();
    src.jiraIssues = async () => [issue('PAY-1', 'To Do', 'new'), issue('PAY-2', 'To Do', 'new')];
    src.gitlabMrsForKeys = async () => null;
    const [p] = await connectorMobileData(src).projects();
    expect(p.livePercent).toBe(0);
    expect(p.devPercent).toBe(58);
    expect(p.errors[0]).toMatch(/GitLab/);
  });

  it('keeps a task that went back at the stage it reached (task peaks shared with the app)', async () => {
    const store = new TaskPeakStore(join(dir, 'task-peaks.json'));
    src.taskPeaks = store;
    await connectorMobileData(src).projects();
    expect(await store.read()).toMatchObject({ 'd1::[BE][api] Refund flow': 'review' });
    // QA sends the ticket back: the task stays at Review, so the stages don't drop.
    src.jiraIssues = async () => [issue('PAY-1', 'Done', 'done'), issue('PAY-2', 'Code Not Pass', 'indeterminate')];
    const [p] = await connectorMobileData(src).projects();
    expect(p.livePercent).toBe(58);
    expect(p.stages).toMatchObject({ merged: 1, review: 1, todo: 1 });
  });

  it('builds the WhatsApp report with the shared builder', async () => {
    const { projectName, text } = await connectorMobileData(src, () => Date.parse('2026-10-07T09:00:00Z')).reportText('p1');
    expect(projectName).toBe('Payment');
    expect(text).toContain('🚀 *Payment*');
    expect(text).toContain('📊 *Development: 58%* (3 task)');
    expect(text).not.toContain('Create payment endpoint');
    await expect(connectorMobileData(src).reportText('nope')).rejects.toThrow(/tidak ditemukan/);
  });

  it('summarises agent tasks, MRs and the latest E2E run', async () => {
    const d = connectorMobileData(src);
    const agents = await d.agentTasks();
    expect(agents.counts).toEqual({ completed: 1, running: 1 });
    expect(agents.tasks[0].title).toBe('Live');
    expect(await d.mrs()).toHaveLength(1);
    expect(await d.e2e()).toEqual([expect.objectContaining({ projectName: 'Payment', failedFlows: 1, environment: 'staging' })]);
  });
});
