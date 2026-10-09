import type { EstimateProject } from '../estimate/types';
import { loadTadProgress } from '../tad/progress-data';
import { calculateCombinedDevProgress, calculateTadDevProgress, getDevStageCounts, type DevStageCounts, type TadProgressData } from '../tad/progress-report';
import { draftTitle, type Draft } from '../../tad/drafts.svelte';
import { hasOpsSources, loadOpsProgress, opsId, OPS_TITLE } from './ops-tasks';

/**
 * Progress of a whole project: every TAD plus its tickets & bugs, with the same rules (code or
 * Jira, furthest wins; tasks never drop) and the same combination as the scheduled report.
 */

export interface ProjectProgressPart {
  id: string;
  title: string;
  kind: 'tad' | 'ops';
  percent: number;
  tasks: number;
  /** Jira statuses in this part (upper case), plus '__none' when it has tasks without a ticket. */
  statuses: string[];
}

export interface ProjectStatusCount {
  status: string;
  /** Jira status category (new / indeterminate / done), 'none' for tasks without a ticket. */
  category: string;
  count: number;
}

export interface ProjectProgress {
  percent: number;
  stages: DevStageCounts;
  parts: ProjectProgressPart[];
  /** Jira tickets per status (each ticket once), most common first; plus tasks without a ticket. */
  statuses: ProjectStatusCount[];
  /** Sources that could not be read (the numbers may be low). */
  errors: string[];
  at: string;
}

function statusCounts(tads: TadProgressData[]): ProjectStatusCount[] {
  const byKey = new Map<string, { status: string; category: string }>();
  let noTicket = 0;
  for (const r of tads.flatMap((t) => t.rows)) {
    if (!r.issues.length) noTicket++;
    for (const { key, issue } of r.issues) byKey.set(key, { status: issue?.status ?? 'Tidak terbaca', category: issue?.statusCategory ?? 'unknown' });
  }
  const counts = new Map<string, ProjectStatusCount>();
  for (const { status, category } of byKey.values()) {
    const id = status.toUpperCase();
    const c = counts.get(id) ?? { status, category, count: 0 };
    c.count++;
    counts.set(id, c);
  }
  const out = [...counts.values()].sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
  if (noTicket) out.push({ status: 'Tanpa tiket Jira', category: 'none', count: noTicket });
  return out;
}

export function summarizeProgress(tads: TadProgressData[], errors: string[] = []): ProjectProgress {
  return {
    statuses: statusCounts(tads),
    percent: calculateCombinedDevProgress(tads),
    stages: getDevStageCounts(tads.flatMap((t) => t.rows)),
    parts: tads.map((t) => ({
      id: t.tadId,
      title: t.tadTitle,
      kind: t.tadId.startsWith('ops:') ? 'ops' : 'tad',
      percent: calculateTadDevProgress(t.rows),
      tasks: t.rows.length,
      statuses: [...new Set(t.rows.flatMap((r) => (r.issues.length ? r.issues.map((i) => (i.issue?.status ?? '').toUpperCase()).filter(Boolean) : ['__none'])))],
    })),
    errors,
    at: new Date().toISOString(),
  };
}

export async function loadProjectProgress(project: EstimateProject, drafts: Draft[]): Promise<ProjectProgress> {
  const tads: TadProgressData[] = [];
  const errors: string[] = [];
  for (const id of project.draftIds) {
    const d = drafts.find((x) => x.id === id);
    if (d) tads.push(await loadTadProgress(d, draftTitle(d)));
  }
  if (hasOpsSources(project)) {
    const ops = await loadOpsProgress(project);
    if (ops.jiraError) errors.push(`Jira: ${ops.jiraError}`);
    if (ops.gitlabError) errors.push(`GitLab: ${ops.gitlabError}`);
    tads.push({ tadId: opsId(project.id), tadTitle: OPS_TITLE, summary: ops.summary, rows: ops.rows });
  }
  return summarizeProgress(tads, errors);
}
