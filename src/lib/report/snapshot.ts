import type { JiraIssue } from '../jira/types';
import { calculateCombinedDevProgress, calculateTadDevProgress, getDevStageCounts, getTaskDevProgress, type DevStage, type TadProgressData } from '../tad/progress-report';

/**
 * Scheduled progress report. Cockpit (on the laptop, with VPN) loads Jira + GitLab + coder runs
 * per project and uploads this snapshot to the VPS; at report time the VPS refreshes the Jira
 * statuses it can reach and renders a short WhatsApp summary (numbers only, no task list) with
 * the same stage/percent rules as the in-app Progress Report. Pure: no browser or Node APIs, so
 * both sides share it.
 */

export const SNAPSHOT_VERSION = 1;
export const REPORT_TZ = 'Asia/Jakarta';

export interface SnapshotProject {
  projectId: string;
  name: string;
  tads: TadProgressData[];
  /** Highest dev % Cockpit has recorded (anti-regression when tickets bounce back). */
  peakPercent: number;
}

export interface ProgressSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** When Cockpit loaded the data (ISO). */
  generatedAt: string;
  projects: SnapshotProject[];
}

export interface RenderOptions {
  now: Date;
  /** Snapshot used for the previous report, to list what changed since then. */
  previous?: ProgressSnapshot | null;
  /** Peaks kept on the VPS between runs, per project id. */
  peaks?: Record<string, number>;
  /** Older data than this is flagged in the message. */
  staleAfterHours?: number;
  /** Jira statuses were refreshed at report time (ISO), or why that failed. */
  jiraRefreshedAt?: string;
  jiraError?: string;
}

export function formatWib(iso: string | Date, withDay = true): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const date = d.toLocaleDateString('id-ID', { timeZone: REPORT_TZ, ...(withDay ? { weekday: 'short' } : {}), day: '2-digit', month: 'short' });
  const time = d.toLocaleTimeString('id-ID', { timeZone: REPORT_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':');
  return `${date} ${time} WIB`;
}

const taskKey = (tadId: string, title: string) => `${tadId}::${title}`;

/** Dev stage of every task in a snapshot, keyed by `${tadId}::${title}`. */
export function taskStages(snapshot: ProgressSnapshot): Map<string, { stage: DevStage; title: string; project: string }> {
  const out = new Map<string, { stage: DevStage; title: string; project: string }>();
  for (const p of snapshot.projects) for (const t of p.tads) for (const r of t.rows) out.set(taskKey(t.tadId, r.task.title), { stage: getTaskDevProgress(r).stage, title: r.task.title, project: p.name });
  return out;
}

/** All Jira keys referenced by the snapshot. */
export function snapshotJiraKeys(snapshot: ProgressSnapshot): string[] {
  return [...new Set(snapshot.projects.flatMap((p) => p.tads.flatMap((t) => t.rows.flatMap((r) => r.task.jiraKeys))))];
}

/** A copy of the snapshot with fresher Jira data (status, category, assignee) where available. */
export function applyIssueRefresh(snapshot: ProgressSnapshot, fresh: Record<string, Pick<JiraIssue, 'status' | 'statusCategory' | 'assignee'>>): ProgressSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.map((p) => ({
      ...p,
      tads: p.tads.map((t) => ({
        ...t,
        rows: t.rows.map((r) => ({
          ...r,
          issues: r.issues.map((i) => {
            const f = fresh[i.key];
            if (!f) return i;
            const base = i.issue ?? ({ id: i.key, key: i.key, summary: '', issueType: 'Task', updated: '', url: '' } as JiraIssue);
            return { ...i, issue: { ...base, status: f.status, statusCategory: f.statusCategory, assignee: f.assignee ?? base.assignee } };
          }),
        })),
      })),
    })),
  };
}

export interface StageChanges {
  merged: number;
  review: number;
  inProgress: number;
  /** Tasks that went back a stage (e.g. reopened). */
  back: number;
  added: number;
}

/** How many tasks moved into each stage since the previous report. */
export function changeCounts(current: ProgressSnapshot, previous: ProgressSnapshot): StageChanges {
  const before = taskStages(previous);
  const order: DevStage[] = ['todo', 'in_progress', 'review', 'merged'];
  const c: StageChanges = { merged: 0, review: 0, inProgress: 0, back: 0, added: 0 };
  for (const [key, now] of taskStages(current)) {
    const was = before.get(key);
    if (!was) c.added++;
    else if (order.indexOf(now.stage) < order.indexOf(was.stage)) c.back++;
    else if (now.stage !== was.stage) {
      if (now.stage === 'merged') c.merged++;
      else if (now.stage === 'review') c.review++;
      else if (now.stage === 'in_progress') c.inProgress++;
    }
  }
  return c;
}

function changeLine(c: StageChanges): string {
  const parts = [
    c.merged ? `🟢 +${c.merged} selesai` : '',
    c.review ? `🟡 +${c.review} masuk review/QA` : '',
    c.inProgress ? `🔵 +${c.inProgress} mulai coding` : '',
    c.back ? `⬇️ ${c.back} mundur` : '',
    c.added ? `🆕 ${c.added} task baru` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'tidak ada perubahan status';
}

/** One project's summary: overall %, stage counts, % per TAD, attention count. */
function projectSummary(p: SnapshotProject, percent: number): string[] {
  const rows = p.tads.flatMap((t) => t.rows);
  const s = getDevStageCounts(rows);
  const attention = rows.filter((r) => r.flags.some((f) => f.tone !== 'info')).length;
  const lines = [
    `🚀 *${p.name}*`,
    `📊 *Development: ${percent}%* (${s.total} task)`,
    `🟢 Selesai ${s.merged} · 🟡 Review/QA ${s.review} · 🔵 Coding ${s.inProgress} · ⚪ To Do ${s.todo}`,
  ];
  if (p.tads.length > 1) lines.push(...p.tads.map((t) => `• ${t.tadTitle}: ${calculateTadDevProgress(t.rows)}%`));
  if (attention) lines.push(`⚠️ Perlu perhatian: ${attention} task (cek Cockpit)`);
  return lines;
}

/**
 * The WhatsApp message: date and data freshness, then per project the overall % (never below
 * the recorded peak), stage counts, % per TAD and what changed since the last report — numbers
 * only, the task list stays in Cockpit. Returns the peaks to persist.
 */
export function renderScheduledReport(snapshot: ProgressSnapshot, opts: RenderOptions): { text: string; peaks: Record<string, number> } {
  const peaks: Record<string, number> = { ...(opts.peaks ?? {}) };
  const projects = snapshot.projects.filter((p) => p.tads.length);
  if (!projects.length) return { text: '', peaks };

  const ageHours = (opts.now.getTime() - new Date(snapshot.generatedAt).getTime()) / 3_600_000;
  const stale = ageHours > (opts.staleAfterHours ?? 12);
  const date = opts.now.toLocaleDateString('id-ID', { timeZone: REPORT_TZ, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });

  const header = [`📋 *Progress Report — ${date}*`, `🕓 Data per ${formatWib(snapshot.generatedAt)}`];
  if (stale) header.push(`⚠️ *Data belum diperbarui ${ageHours >= 48 ? `${Math.floor(ageHours / 24)} hari` : `${Math.round(ageHours)} jam`}* — buka Cockpit (dengan VPN) agar progres MR ikut terbaru.`);
  if (opts.jiraError) header.push(`⚠️ Status Jira dari snapshot (refresh gagal: ${opts.jiraError})`);

  const previous = opts.previous ?? null;
  const prevById = new Map((previous?.projects ?? []).map((p) => [p.projectId, p]));
  const sections = projects.map((p) => {
    const live = calculateCombinedDevProgress(p.tads);
    const peak = Math.max(live, p.peakPercent || 0, peaks[p.projectId] || 0);
    peaks[p.projectId] = peak;
    const lines = projectSummary(p, peak);
    const before = prevById.get(p.projectId);
    if (previous && before) {
      lines.push(`🔁 Sejak ${formatWib(previous.generatedAt, false)}: ${changeLine(changeCounts({ ...snapshot, projects: [p] }, { ...previous, projects: [before] }))}`);
    }
    return lines.join('\n');
  });

  const footer = opts.jiraRefreshedAt ? `\n\n_Status Jira diperbarui ${formatWib(opts.jiraRefreshedAt, false)}. Detail task di Cockpit._` : '\n\n_Detail task di Cockpit._';
  return { text: `${header.join('\n')}\n\n${sections.join('\n\n')}${footer}`, peaks };
}

/** Structural check of an uploaded snapshot (the VPS trusts nothing else). */
export function isSnapshot(x: unknown): x is ProgressSnapshot {
  if (!x || typeof x !== 'object') return false;
  const s = x as Partial<ProgressSnapshot>;
  return (
    s.version === SNAPSHOT_VERSION &&
    typeof s.generatedAt === 'string' &&
    !Number.isNaN(Date.parse(s.generatedAt)) &&
    Array.isArray(s.projects) &&
    s.projects.every((p) => p && typeof p.projectId === 'string' && typeof p.name === 'string' && Array.isArray(p.tads) && p.tads.every((t) => t && Array.isArray(t.rows)))
  );
}
