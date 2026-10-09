/**
 * TAD tasks and their Jira tickets after the scope changes: which tasks still need a ticket, what
 * the ticket says, and which tickets were left behind by tasks removed from the scope.
 */
import { detailTaskSpec, parseScopeTasks, type ScopeTask } from './task-links';

/** Development Scope rows without a Jira key (only real table rows, not the Rencana Scope fallback). */
export function tasksWithoutTicket(markdown: string): ScopeTask[] {
  return parseScopeTasks(markdown).filter((t) => !t.jiraKeys.length);
}

/** Ticket description: where the task comes from, then its Detail Task. */
export function ticketDescription(markdown: string, task: ScopeTask, tad: { title: string; url?: string }): string {
  const spec = detailTaskSpec(markdown, task.title);
  return [
    `Task dari TAD "${tad.title}"${tad.url ? `: ${tad.url}` : ''}`,
    task.service ? `Service: ${task.service}` : '',
    '',
    spec?.text || 'Detail Task untuk task ini belum ada di TAD.',
  ]
    .filter((l, i) => l || i === 2)
    .join('\n')
    .trim();
}

/**
 * Keys that earlier revisions of the TAD had in Development Scope but the TAD no longer has: the
 * tickets of tasks removed from the scope. Newest revisions first; `limit` keeps it cheap.
 */
export function droppedTicketKeys(markdown: string, revisions: { markdown: string }[], limit = 40): string[] {
  const now = new Set(parseScopeTasks(markdown).flatMap((t) => t.jiraKeys));
  const out = new Set<string>();
  for (const r of revisions.slice(0, limit)) for (const t of parseScopeTasks(r.markdown)) for (const k of t.jiraKeys) if (!now.has(k)) out.add(k);
  return [...out];
}
