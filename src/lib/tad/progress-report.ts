import type { JiraIssue } from '../jira/types';
import type { MrSummary } from '../gitlab/types';
import type { ScopeTask } from './task-links';

/** Where a task comes from: a TAD's Development Scope, or the project's other sources. */
export type TaskSource = 'tad' | 'jira' | 'bug' | 'manual';

export interface ProgressTaskRow {
  task: ScopeTask;
  issues: Array<{ key: string; issue?: JiraIssue }>;
  mrs: MrSummary[];
  flags: Array<{ tone: 'warn' | 'err' | 'info'; text: string }>;
  run?: { status: string } | null;
  /** Absent = a TAD task. */
  source?: TaskSource;
  /** Marked done by hand (manual tasks, fixed bug tasks). */
  manualDone?: boolean;
  /** Furthest stage this task ever reached; progress never drops below it (see applyTaskPeaks). */
  peakStage?: DevStage;
}

export interface ProgressSummary {
  tasks: number;
  withMr: number;
  merged: number;
  done: number;
  attention: number;
}

export interface TadProgressData {
  tadId: string;
  tadTitle: string;
  summary: ProgressSummary;
  rows: ProgressTaskRow[];
}

export type DevStage = 'merged' | 'review' | 'in_progress' | 'todo';

export interface TaskDevProgress {
  stage: DevStage;
  percent: number;
  stageLabel: string;
}

export interface DevStageCounts {
  merged: number;
  review: number;
  inProgress: number;
  todo: number;
  total: number;
  devPercent: number;
}

const STAGE_RANK: Record<DevStage, number> = { todo: 0, in_progress: 1, review: 2, merged: 3 };
const STAGE_PERCENT: Record<DevStage, number> = { todo: 0, in_progress: 40, review: 75, merged: 100 };

/**
 * Dev stage implied by a Jira status. A ticket moved past development (Ready to Test, In QA, UAT,
 * Done, …) means the code is finished, even when its MR wasn't detected. Rework statuses
 * ("Code Not Pass", "Failed QA", "Reopened") count as coding again. Unknown statuses say nothing.
 */
export function jiraDevStage(issue?: Pick<JiraIssue, 'status' | 'statusCategory'>): DevStage | null {
  if (!issue) return null;
  const s = issue.status.toLowerCase();
  if (/fail|reject|not\s*pass|re-?open|rework|revis/.test(s)) return 'in_progress';
  if (issue.statusCategory === 'done') return 'merged';
  if (/ready\s*(to|for)\s*(test|qa|uat|release|deploy|prod)|\bqa\b|\btest(ing)?\b|\buat\b|staging|deploy|release|verif/.test(s)) return 'merged';
  if (/review|\bcr\b/.test(s)) return 'review';
  if (/progress|develop|coding|doing|\bwip\b/.test(s)) return 'in_progress';
  return null;
}

/** The stage all of a task's tickets have reached (the least advanced one), or null. */
function ticketsStage(row: ProgressTaskRow): { stage: DevStage; status: string } | null {
  let worst: { stage: DevStage; status: string } | null = null;
  for (const { issue } of row.issues) {
    const stage = jiraDevStage(issue);
    if (!stage) return null;
    if (!worst || STAGE_RANK[stage] < STAGE_RANK[worst.stage]) worst = { stage, status: issue!.status };
  }
  return worst;
}

/**
 * A task's development stage: the furthest of what the code and Jira show.
 * Code (GitLab):
 * - an MR merged (any target branch, auto-detected or linked by hand) -> 100% Dev Selesai
 * - an MR open (not draft)                                             -> 75% Review / QA
 * - a draft MR, or a coding agent run for the task                     -> 40% Sedang Coding
 * Jira (see jiraDevStage): Ready to Test / In QA / Done -> 100%, review -> 75%, in progress -> 40%.
 * Teams often move Jira late, and MRs that don't mention the key go undetected, so either one
 * alone under-reports; taking the furthest of both does not. Marked done by hand -> 100%.
 */
export function getTaskDevProgress(row: ProgressTaskRow): TaskDevProgress {
  const live = liveDevProgress(row);
  const peak = row.peakStage;
  if (!peak || STAGE_RANK[peak] <= STAGE_RANK[live.stage]) return live;
  // A task that went back (QA returned it, ticket reopened) keeps the progress it reached.
  const now = row.issues.find((i) => i.issue)?.issue?.status;
  return { stage: peak, percent: STAGE_PERCENT[peak], stageLabel: `${STAGE_NAME[peak]} · tidak turun${now ? ` (Jira sekarang: ${now})` : ''}` };
}

const STAGE_NAME: Record<DevStage, string> = { merged: 'Dev Selesai', review: 'Review', in_progress: 'Sedang Coding', todo: 'To Do' };

/** Where the task is now, from code and Jira (no memory of earlier stages). */
function liveDevProgress(row: ProgressTaskRow): TaskDevProgress {
  if (row.mrs.some((m) => m.state === 'merged')) {
    return { stage: 'merged', percent: 100, stageLabel: 'Dev Selesai (Merged)' };
  }
  if (row.manualDone) {
    return { stage: 'merged', percent: 100, stageLabel: 'Selesai' };
  }
  const code: TaskDevProgress = row.mrs.some((m) => m.state === 'opened' && !m.draft)
    ? { stage: 'review', percent: 75, stageLabel: 'Review / QA' }
    : row.mrs.some((m) => m.state === 'opened') || row.run
      ? { stage: 'in_progress', percent: 40, stageLabel: 'Sedang Coding' }
      : { stage: 'todo', percent: 0, stageLabel: 'To Do' };
  const jira = ticketsStage(row);
  if (jira && STAGE_RANK[jira.stage] > STAGE_RANK[code.stage]) {
    const label = jira.stage === 'merged' ? 'Dev Selesai' : jira.stage === 'review' ? 'Review' : 'Sedang Coding';
    return { stage: jira.stage, percent: STAGE_PERCENT[jira.stage], stageLabel: `${label} (Jira: ${jira.status})` };
  }
  return code;
}

export const taskPeakKey = (tadId: string, title: string) => `${tadId}::${title}`;

/**
 * Gives every row the furthest stage it ever reached (from `peaks`, keyed by taskPeakKey), and
 * returns the peaks that went up now, for the caller to store. Pure: the app, the connector and
 * the VPS share it.
 */
export function applyTaskPeaks<R extends ProgressTaskRow>(tadId: string, rows: R[], peaks: Record<string, DevStage>): { rows: R[]; raised: Record<string, DevStage> } {
  const raised: Record<string, DevStage> = {};
  const out = rows.map((r) => {
    const key = taskPeakKey(tadId, r.task.title);
    const known = peaks[key];
    const row: R = known && known !== 'todo' ? { ...r, peakStage: known } : r;
    const { stage } = getTaskDevProgress(row);
    if (stage !== 'todo' && STAGE_RANK[stage] > STAGE_RANK[known ?? 'todo']) raised[key] = stage;
    return row;
  });
  return { rows: out, raised };
}

export function isDevStage(v: unknown): v is DevStage {
  return v === 'todo' || v === 'in_progress' || v === 'review' || v === 'merged';
}

export function calculateTadDevProgress(rows: ProgressTaskRow[]): number {
  if (!rows.length) return 0;
  const total = rows.reduce((acc, r) => acc + getTaskDevProgress(r).percent, 0);
  return Math.round(total / rows.length);
}

export function calculateCombinedDevProgress(tads: TadProgressData[]): number {
  const allRows = tads.flatMap((t) => t.rows);
  return calculateTadDevProgress(allRows);
}

const PEAK_KEY_PREFIX = 'tlc.tad.peak_dev_progress.';

/**
 * Reads the historical highest (peak) progress recorded for a TAD from localStorage.
 */
export function getPeakDevPercent(tadId: string): number {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  try {
    const raw = localStorage.getItem(`${PEAK_KEY_PREFIX}${tadId}`);
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

/**
 * Saves and updates the peak progress recorded for a TAD (anti-regression).
 */
export function savePeakDevPercent(tadId: string, percent: number): number {
  if (typeof window === 'undefined' || !window.localStorage) return percent;
  try {
    const current = getPeakDevPercent(tadId);
    if (percent > current) {
      localStorage.setItem(`${PEAK_KEY_PREFIX}${tadId}`, String(percent));
      return percent;
    }
    return current;
  } catch {
    return percent;
  }
}

/**
 * Gets the combined high-water mark (highest progress ever recorded).
 * Prevents progress from decreasing if tickets are kicked back to To Do / reopened.
 */
export function getCombinedPeakPercent(tads: TadProgressData[], currentCalculated: number): number {
  if (!tads.length) return currentCalculated;
  if (tads.length === 1) {
    const current = getPeakDevPercent(tads[0].tadId);
    const peak = Math.max(current, currentCalculated);
    if (peak > current) savePeakDevPercent(tads[0].tadId, peak);
    return peak;
  }
  const combinedId = `multi_${tads.map((t) => t.tadId).sort().join('_')}`;
  const current = getPeakDevPercent(combinedId);
  const peak = Math.max(current, currentCalculated);
  if (peak > current) savePeakDevPercent(combinedId, peak);
  return peak;
}

export function getDevStageCounts(rows: ProgressTaskRow[]): DevStageCounts {
  let merged = 0;
  let review = 0;
  let inProgress = 0;
  let todo = 0;

  for (const r of rows) {
    const { stage } = getTaskDevProgress(r);
    if (stage === 'merged') merged++;
    else if (stage === 'review') review++;
    else if (stage === 'in_progress') inProgress++;
    else todo++;
  }

  return {
    merged,
    review,
    inProgress,
    todo,
    total: rows.length,
    devPercent: calculateTadDevProgress(rows),
  };
}

export function calculateCombinedSummary(tads: TadProgressData[]): ProgressSummary {
  return tads.reduce(
    (acc, t) => ({
      tasks: acc.tasks + t.summary.tasks,
      withMr: acc.withMr + t.summary.withMr,
      merged: acc.merged + t.summary.merged,
      done: acc.done + t.summary.done,
      attention: acc.attention + t.summary.attention,
    }),
    { tasks: 0, withMr: 0, merged: 0, done: 0, attention: 0 },
  );
}
