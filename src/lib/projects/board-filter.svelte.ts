/**
 * Jira status filter shared by the project's boards (TAD Task Board, Tiket & Bug) and the
 * project progress card, so clicking a status there filters the open board.
 * '' = all, NO_TICKET = tasks without a Jira ticket; otherwise a status name (case-insensitive).
 */
export const NO_TICKET = '__none';

export const boardFilter = $state({ jiraStatus: '' });

export function matchesJiraStatus(issues: { issue?: { status: string } }[], filter: string): boolean {
  if (!filter) return true;
  if (filter === NO_TICKET) return issues.length === 0;
  const want = filter.toUpperCase();
  return issues.some((i) => i.issue?.status.toUpperCase() === want);
}

/** Statuses present in the rows (each ticket once), most common first; NO_TICKET last. */
export function statusOptions(rows: { issues: { key: string; issue?: { status: string } }[] }[]): { value: string; label: string; count: number }[] {
  const byKey = new Map<string, string>();
  let none = 0;
  for (const r of rows) {
    if (!r.issues.length) none++;
    for (const i of r.issues) if (i.issue) byKey.set(i.key, i.issue.status);
  }
  const counts = new Map<string, { label: string; count: number }>();
  for (const s of byKey.values()) {
    const k = s.toUpperCase();
    const c = counts.get(k) ?? { label: s, count: 0 };
    c.count++;
    counts.set(k, c);
  }
  const out = [...counts.entries()].map(([value, c]) => ({ value, label: c.label, count: c.count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  if (none) out.push({ value: NO_TICKET, label: 'Tanpa tiket Jira', count: none });
  return out;
}
