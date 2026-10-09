import { estimate } from '../estimate/client';
import { gitlab } from '../gitlab/client';
import { jira } from '../jira/client';
import { hasOpsSources, loadOpsProgress } from '../projects/ops-tasks';
import { loadTadProgress } from '../tad/progress-data';
import { calculateCombinedDevProgress, getCombinedPeakPercent, type TadProgressData } from '../tad/progress-report';
import { draftTitle, drafts } from '../../tad/drafts.svelte';
import { report, type ReportSettings } from './client';
import { SNAPSHOT_VERSION, type ProgressSnapshot } from './snapshot';

/**
 * Keeps the VPS copy of the progress snapshot fresh while Cockpit is open: every 15 minutes (and
 * shortly after start) it loads the reported projects from Jira + GitLab and uploads them. A
 * snapshot is only uploaded when both GitLab and Jira answered: with the VPN off GitLab would
 * look empty and progress would seem to drop, so the last good snapshot stays on the VPS.
 */

const INTERVAL_MS = 15 * 60_000;
const FIRST_RUN_MS = 60_000;

export interface SyncOutcome {
  at: string;
  ok: boolean;
  /** Not an error: nothing to do (disabled, no project) or sources unreachable. */
  skipped?: string;
  error?: string;
}

/** Throws with a readable reason when GitLab or Jira can't be read right now. */
async function assertSourcesReachable() {
  const [gl, jr] = await Promise.all([gitlab.status().catch((e: Error) => ({ configured: false, error: e.message })), jira.status().catch((e: Error) => ({ configured: false, error: e.message }))]);
  const glUser = (gl as { user?: unknown }).user;
  const jrUser = (jr as { user?: unknown }).user;
  if (!gl.configured || !glUser) throw new SkipError(gl.error || 'GitLab tidak terjangkau. Pastikan VPN aktif.');
  if (!jr.configured || !jrUser) throw new SkipError(jr.error || 'Jira tidak terjangkau.');
}

class SkipError extends Error {}

/** Snapshot of the given projects, with the same data and peak logic as the Task Board. */
export async function buildSnapshot(projectIds: string[]): Promise<ProgressSnapshot> {
  const projects = (await estimate.projects()).filter((p) => projectIds.includes(p.id));
  const out: ProgressSnapshot = { version: SNAPSHOT_VERSION, generatedAt: new Date().toISOString(), projects: [] };
  for (const p of projects) {
    const tads: TadProgressData[] = [];
    for (const id of p.draftIds) {
      const d = drafts.drafts.find((x) => x.id === id);
      if (d) tads.push(await loadTadProgress(d, draftTitle(d)));
    }
    // Tickets, bug fixes and manual tasks count like the TAD tasks.
    if (hasOpsSources(p)) {
      const { tadId, tadTitle, summary, rows } = await loadOpsProgress(p);
      tads.push({ tadId, tadTitle, summary, rows });
    }
    out.projects.push({ projectId: p.id, name: p.name, tads, peakPercent: tads.length ? getCombinedPeakPercent(tads, calculateCombinedDevProgress(tads)) : 0 });
  }
  return out;
}

class ReportSync {
  last = $state<SyncOutcome | null>(null);
  busy = $state(false);
  private timer: ReturnType<typeof setInterval> | undefined;

  start() {
    if (this.timer) return;
    setTimeout(() => void this.tick(), FIRST_RUN_MS);
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
  }

  private async tick() {
    let settings: ReportSettings;
    try {
      settings = await report.settings();
    } catch {
      return;
    }
    if (settings.enabled) await this.syncNow(settings);
  }

  /** Builds and uploads now. `settings` defaults to the saved ones. */
  async syncNow(settings?: ReportSettings): Promise<SyncOutcome> {
    if (this.busy) return this.last ?? { at: new Date().toISOString(), ok: false, skipped: 'Sinkron sedang berjalan.' };
    this.busy = true;
    const at = new Date().toISOString();
    try {
      const s = settings ?? (await report.settings());
      if (!s.host) return (this.last = { at, ok: false, skipped: 'Alamat VPS belum diatur.' });
      if (!s.projectIds.length) return (this.last = { at, ok: false, skipped: 'Belum ada proyek yang dipilih.' });
      await assertSourcesReachable();
      await report.sync(await buildSnapshot(s.projectIds));
      return (this.last = { at, ok: true });
    } catch (e) {
      return (this.last = e instanceof SkipError ? { at, ok: false, skipped: e.message } : { at, ok: false, error: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }
}

export const reportSync = new ReportSync();
