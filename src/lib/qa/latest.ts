import type { QAFlow, QARun, QAStepStatus } from './types';

/**
 * The latest real outcome of each flow, for the Skenario tab: from the newest run that actually ran
 * it (a run of one flow counts too). Unfinished results (running, waiting, skipped by a cancel)
 * leave the previous outcome in place.
 */
export interface LatestResult {
  status: QAStepStatus;
  runId: string;
  at: string;
  envName: string;
}

export type ResultBucket = 'passed' | 'failed' | 'none';

const FINAL: QAStepStatus[] = ['passed', 'failed', 'error', 'blocked'];

/** Per flow id; only runs on `envId` when given (a pass on Local says nothing about Development). */
export function latestResults(runs: QARun[], envId?: string): Map<string, LatestResult> {
  const out = new Map<string, LatestResult>();
  const newest = [...runs].filter((r) => !envId || r.environment.id === envId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const run of newest) {
    for (const f of run.flows) {
      if (out.has(f.flowId) || !FINAL.includes(f.status)) continue;
      out.set(f.flowId, { status: f.status, runId: run.id, at: run.finishedAt ?? run.startedAt, envName: run.environment.name });
    }
  }
  return out;
}

/** Lulus, gagal (failed, error, blocked), or not run yet. */
export const resultBucket = (r: LatestResult | undefined): ResultBucket => (!r ? 'none' : r.status === 'passed' ? 'passed' : 'failed');

/** How many of `flows` passed, failed, or haven't run. */
export function resultCounts(flows: Pick<QAFlow, 'id'>[], latest: Map<string, LatestResult>): Record<ResultBucket, number> {
  const counts: Record<ResultBucket, number> = { passed: 0, failed: 0, none: 0 };
  for (const f of flows) counts[resultBucket(latest.get(f.id))]++;
  return counts;
}
