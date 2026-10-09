import type { MrSummary } from '../gitlab/types';
import type { JiraIssue } from '../jira/types';
import type { ProgressSummary, ProgressTaskRow, TadProgressData } from './progress-report';
import type { ScopeTask } from './task-links';

/**
 * Progress of one TAD from already-fetched Jira issues and GitLab MRs. Pure, so the app (browser
 * clients) and the connector (remote mobile API) compute rows, flags and the summary identically.
 * `mrsLoaded` is false when GitLab could not be reached: MR-based flags are then skipped.
 */
export function buildTadProgress(
  tadId: string,
  tadTitle: string,
  tasks: ScopeTask[],
  issues: Record<string, JiraIssue>,
  mrs: Record<string, MrSummary[]>,
  mrsLoaded: boolean,
): TadProgressData {
  const rows: ProgressTaskRow[] = tasks.map((t) => {
    const taskMrs = t.jiraKeys.flatMap((k) => mrs[k] ?? []);
    const openMrs = taskMrs.filter((m) => m.state === 'opened');
    const mergedMrs = taskMrs.filter((m) => m.state === 'merged');
    const flags: ProgressTaskRow['flags'] = [];

    if (!t.jiraKeys.length) {
      flags.push({ tone: 'warn', text: 'Belum ada Jira key' });
    } else {
      for (const k of t.jiraKeys) {
        const issue = issues[k];
        if (!issue || !mrsLoaded) continue;
        const done = issue.statusCategory === 'done';
        const reviewish = /review|qa|test|uat/i.test(issue.status);
        if (done && openMrs.length) flags.push({ tone: 'warn', text: `${k} sudah ${issue.status}, tapi masih ada MR terbuka` });
        if (!done && mergedMrs.length && !openMrs.length) flags.push({ tone: 'warn', text: `MR sudah merged, ${k} masih ${issue.status}` });
        if (reviewish && !taskMrs.length) flags.push({ tone: 'err', text: `${k} berstatus ${issue.status}, tapi belum ada MR` });
        if (done && !taskMrs.length) flags.push({ tone: 'warn', text: `${k} sudah ${issue.status} di Jira, tapi MR-nya tidak terdeteksi (tambahkan MR manual)` });
      }
      if (openMrs.some((m) => m.hasConflicts)) flags.push({ tone: 'err', text: 'MR punya konflik' });
    }

    return {
      task: t,
      issues: t.jiraKeys.map((k) => ({ key: k, issue: issues[k] })),
      mrs: taskMrs.filter((m, i, a) => a.findIndex((x) => x.ref === m.ref) === i),
      flags,
    };
  });

  const summary: ProgressSummary = {
    tasks: rows.length,
    withMr: rows.filter((r) => r.mrs.length).length,
    merged: rows.filter((r) => r.mrs.length && r.mrs.every((m) => m.state === 'merged')).length,
    done: rows.filter((r) => r.issues.length && r.issues.every((i) => i.issue?.statusCategory === 'done')).length,
    attention: rows.filter((r) => r.flags.some((f) => f.tone !== 'info')).length,
  };

  return { tadId, tadTitle, summary, rows };
}
