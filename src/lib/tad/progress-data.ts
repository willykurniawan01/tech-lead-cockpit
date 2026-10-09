import { gitlab } from '../gitlab/client';
import type { MrSummary } from '../gitlab/types';
import { jira } from '../jira/client';
import type { JiraIssue } from '../jira/types';
import { buildTadProgress } from './progress-build';
import type { TadProgressData } from './progress-report';
import { parseScopeTasks } from './task-links';
import { withTaskPeaks } from './task-peaks';

/** Live progress of one TAD: its Development Scope tasks with their Jira issues and GitLab MRs. */
export async function loadTadProgress(draft: { id: string; markdown: string; scopePlan?: string }, title: string): Promise<TadProgressData> {
  const tasks = parseScopeTasks(draft.markdown, draft.scopePlan);
  const keys = [...new Set(tasks.flatMap((t) => t.jiraKeys))];

  let issues: Record<string, JiraIssue> = {};
  let mrs: Record<string, MrSummary[]> = {};
  let mrsLoaded = false;

  if (keys.length > 0) {
    await Promise.all([
      jira
        .issues(`key in (${keys.join(',')})`, Math.max(keys.length, 50))
        .then((list) => (issues = Object.fromEntries(list.map((i) => [i.key, i]))))
        .catch(() => {}),
      gitlab
        .mrsForKeys(keys)
        .then((m) => {
          mrs = m;
          mrsLoaded = true;
        })
        .catch(() => {}),
    ]);
  }

  return withTaskPeaks(buildTadProgress(draft.id, title, tasks, issues, mrs, mrsLoaded));
}
