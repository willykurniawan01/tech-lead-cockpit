import { describe, expect, it } from 'vitest';
import { latestResults, resultBucket, resultCounts } from './latest';
import type { QAFlowResult, QARun, QAStepStatus } from './types';

const result = (flowId: string, status: QAStepStatus): QAFlowResult => ({ flowId, name: flowId, category: 'happy-path', taskTitles: [], status, steps: [] });

const run = (id: string, startedAt: string, flows: QAFlowResult[], env = 'dev', status: QARun['status'] = 'done'): QARun => ({
  id,
  projectId: 'p',
  projectName: 'P',
  environment: { id: env, name: env === 'dev' ? 'Development' : 'Local', readOnly: false },
  status,
  startedAt,
  finishedAt: status === 'done' ? startedAt.replace('00Z', '30Z') : undefined,
  flows,
  summary: { flows: flows.length, passedFlows: 0, failedFlows: 0, steps: 0, passedSteps: 0, failedSteps: 0 },
});

describe('latest E2E results per flow', () => {
  const runs = [
    run('r1', '2026-10-20T01:00:00Z', [result('a', 'failed'), result('b', 'passed'), result('c', 'passed')]),
    // A later run of one flow only: a and b keep their own latest outcome.
    run('r2', '2026-10-22T02:00:00Z', [result('a', 'passed')]),
    // Cancelled: skipped flows don't hide the earlier outcome.
    run('r3', '2026-10-22T03:00:00Z', [result('b', 'skipped'), result('c', 'error')], 'dev', 'cancelled'),
    // Another environment.
    run('r4', '2026-10-22T04:00:00Z', [result('b', 'failed')], 'local'),
  ];

  it('takes each flow from the newest run that really ran it, on the chosen environment', () => {
    const dev = latestResults(runs, 'dev');
    expect(dev.get('a')).toMatchObject({ status: 'passed', runId: 'r2', envName: 'Development' });
    expect(dev.get('b')).toMatchObject({ status: 'passed', runId: 'r1' });
    expect(dev.get('c')).toMatchObject({ status: 'error', runId: 'r3' });
    expect(dev.has('d')).toBe(false);
    // Without an environment, any run counts.
    expect(latestResults(runs).get('b')).toMatchObject({ status: 'failed', runId: 'r4' });
    // A flow still running keeps its previous outcome.
    expect(latestResults([...runs, run('r5', '2026-10-22T05:00:00Z', [result('a', 'running')], 'dev', 'running')], 'dev').get('a')?.runId).toBe('r2');
  });

  it('buckets outcomes and counts them', () => {
    const dev = latestResults(runs, 'dev');
    expect(resultBucket(dev.get('a'))).toBe('passed');
    expect(resultBucket(dev.get('c'))).toBe('failed');
    expect(resultBucket(undefined)).toBe('none');
    expect(resultCounts([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], dev)).toEqual({ passed: 2, failed: 1, none: 1 });
  });
});
