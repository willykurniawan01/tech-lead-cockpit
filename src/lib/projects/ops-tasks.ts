import { bugs } from '../bugs/client';
import type { BugCase } from '../bugs/types';
import { DEFAULT_DONE_DAYS, type EstimateProject, type ProjectJiraFilter } from '../estimate/types';
import { gitlab } from '../gitlab/client';
import type { MrSummary } from '../gitlab/types';
import { jira } from '../jira/client';
import type { JiraIssue } from '../jira/types';
import { buildTadProgress } from '../tad/progress-build';
import type { ProgressTaskRow, TadProgressData, TaskSource } from '../tad/progress-report';
import { jiraKeysIn, type ScopeTask } from '../tad/task-links';
import { withTaskPeaks } from '../tad/task-peaks';

/**
 * The project's work outside its TADs, as one extra "TAD" so the Task Board, the progress rules
 * and the scheduled report treat it like any other: Jira tickets from the project's filter, fix
 * tasks of linked Bug Tracing cases, and tasks added by hand. A task's `no` holds where it came
 * from (`jira:KEY`, `bug:<caseId>:<taskId>`, `manual:<id>`).
 */

export const OPS_PREFIX = 'ops:';
export const OPS_TITLE = 'Tiket & Bug';
export const opsId = (projectId: string) => `${OPS_PREFIX}${projectId}`;
const MAX_JIRA = 100;

export function hasOpsSources(p: Pick<EstimateProject, 'jiraFilter' | 'bugCaseIds' | 'manualTasks'>): boolean {
  return Boolean(p.jiraFilter?.projectKey || p.bugCaseIds?.length || p.manualTasks?.length);
}

/** JQL for the project's ticket filter; values were sanitized when the project was saved. */
export function opsJql(f: ProjectJiraFilter): string {
  const q = (v: string) => `"${v.replace(/["\\]/g, '')}"`;
  const parts = [`project = ${f.projectKey}`];
  if (f.issueTypes.length) parts.push(`issuetype in (${f.issueTypes.map(q).join(', ')})`);
  if (f.label) parts.push(`labels = ${q(f.label)}`);
  if (f.epicKey) parts.push(`parent = ${f.epicKey}`);
  if (f.activeSprint) parts.push('sprint in openSprints()');
  parts.push(`(statusCategory != Done OR resolved >= -${f.doneDays ?? DEFAULT_DONE_DAYS}d)`);
  return `${parts.join(' AND ')} ORDER BY updated DESC`;
}

export interface OpsRowRef {
  source: Exclude<TaskSource, 'tad'>;
  /** Jira key, bug case id or manual task id. */
  id: string;
  /** Bug task id within the case. */
  taskId?: string;
}

export function rowRef(row: Pick<ProgressTaskRow, 'task'>): OpsRowRef | null {
  const [source, id, taskId] = row.task.no.split(':');
  if (source !== 'jira' && source !== 'bug' && source !== 'manual') return null;
  return { source, id, ...(taskId ? { taskId } : {}) };
}

export interface OpsProgress extends TadProgressData {
  jiraError?: string;
  gitlabError?: string;
  /** The filter returned the maximum; older tickets may be missing. */
  jiraTruncated?: boolean;
  /** Linked bug cases that no longer exist. */
  missingBugCases: string[];
  bugCases: Record<string, BugCase>;
}

interface Draft {
  task: ScopeTask;
  source: OpsRowRef['source'];
  manualDone?: boolean;
  run?: { status: string } | null;
}

export async function loadOpsProgress(project: Pick<EstimateProject, 'id' | 'jiraFilter' | 'bugCaseIds' | 'manualTasks'>): Promise<OpsProgress> {
  let jiraError: string | undefined;
  let gitlabError: string | undefined;
  const issues: Record<string, JiraIssue> = {};

  // Bug cases and manual tasks first: their Jira keys take precedence over the filter's rows.
  const bugCases: Record<string, BugCase> = {};
  const missingBugCases: string[] = [];
  await Promise.all(
    (project.bugCaseIds ?? []).map((id) =>
      bugs
        .get(id)
        .then((c) => (bugCases[id] = c))
        .catch(() => missingBugCases.push(id)),
    ),
  );

  const drafts: Draft[] = [];
  for (const id of project.bugCaseIds ?? []) {
    const c = bugCases[id];
    if (!c) continue;
    if (!c.tasks.length) {
      drafts.push({
        // A case traced from a Jira ticket carries its key in the title ("MU-123 · …").
        task: { no: `bug:${c.id}`, service: c.analysis?.repo ?? '', title: c.title, jiraKeys: c.jira ? [c.jira.key] : jiraKeysIn(c.title).slice(0, 1) },
        source: 'bug',
        manualDone: c.status === 'fixed',
      });
      continue;
    }
    for (const t of c.tasks) {
      drafts.push({
        task: { no: `bug:${c.id}:${t.id}`, service: t.repo, title: c.tasks.length > 1 ? `${c.title} · ${t.title}` : c.title, jiraKeys: t.jira ? [t.jira.key] : [] },
        source: 'bug',
        manualDone: t.status === 'fixed',
        run: t.status === 'fixing' ? { status: 'running' } : null,
      });
    }
  }
  for (const m of project.manualTasks ?? []) {
    drafts.push({ task: { no: `manual:${m.id}`, service: m.repo ?? '', title: m.title, jiraKeys: m.jiraKey ? [m.jiraKey] : [] }, source: 'manual', manualDone: m.done === true });
  }

  let jiraTruncated = false;
  if (project.jiraFilter?.projectKey) {
    try {
      const found = await jira.issues(opsJql(project.jiraFilter), MAX_JIRA);
      jiraTruncated = found.length >= MAX_JIRA;
      const taken = new Set(drafts.flatMap((d) => d.task.jiraKeys));
      for (const i of found) {
        issues[i.key] = i;
        if (taken.has(i.key)) continue;
        drafts.push({ task: { no: `jira:${i.key}`, service: i.issueType, title: i.summary, jiraKeys: [i.key] }, source: 'jira' });
      }
    } catch (e) {
      jiraError = (e as Error).message;
    }
  }

  // Titles key the report's change list: keep them unique.
  const seen = new Map<string, number>();
  for (const d of drafts) {
    const n = seen.get(d.task.title) ?? 0;
    seen.set(d.task.title, n + 1);
    if (n) d.task.title = `${d.task.title} (${d.task.jiraKeys[0] ?? n + 1})`;
  }

  const keys = [...new Set(drafts.flatMap((d) => d.task.jiraKeys))];
  const missing = keys.filter((k) => !issues[k]);
  let mrs: Record<string, MrSummary[]> = {};
  let mrsLoaded = false;
  await Promise.all([
    missing.length
      ? jira
          .issues(`key in (${missing.join(',')})`, Math.max(missing.length, 50))
          .then((list) => list.forEach((i) => (issues[i.key] = i)))
          .catch((e: Error) => (jiraError ??= e.message))
      : Promise.resolve(),
    keys.length
      ? gitlab
          .mrsForKeys(keys)
          .then((m) => {
            mrs = m;
            mrsLoaded = true;
          })
          .catch((e: Error) => (gitlabError = e.message))
      : Promise.resolve((mrsLoaded = true)),
  ]);

  const base = buildTadProgress(opsId(project.id), OPS_TITLE, drafts.map((d) => d.task), issues, mrs, mrsLoaded);
  const rows: ProgressTaskRow[] = base.rows.map((r, i) => {
    const d = drafts[i];
    // TAD-specific nags don't apply: work without a ticket is fine, and tickets may close without code.
    const flags = r.flags.filter((f) => !(d.source === 'manual' && f.text === 'Belum ada Jira key') && !/di Jira, tapi MR-nya tidak terdeteksi/.test(f.text));
    return { ...r, flags, source: d.source, ...(d.manualDone ? { manualDone: true } : {}), ...(d.run ? { run: d.run } : {}) };
  });
  const summary = { ...base.summary, attention: rows.filter((r) => r.flags.some((f) => f.tone !== 'info')).length };
  return withTaskPeaks({ ...base, rows, summary, jiraError, gitlabError, jiraTruncated, missingBugCases, bugCases });
}
