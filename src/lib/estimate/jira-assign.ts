import type { EstimateProject } from './types';

/**
 * The developer assigned in the estimate, pushed to the task's Jira ticket(s). Only tasks assigned
 * by hand count ("Otomatis" stays a scheduling suggestion until it is locked).
 */

export interface JiraAssignTarget {
  key: string;
  taskTitle: string;
  developer: string;
  accountId: string;
}

export interface JiraAssignTargets {
  targets: JiraAssignTarget[];
  /** Assigned tasks whose Development Scope row has no Jira key yet. */
  noKey: string[];
  /** Assigned to a developer not linked to a Jira account. */
  noAccount: { taskTitle: string; developer: string }[];
  /** One ticket shared by tasks assigned to different developers: left alone. */
  conflicts: { key: string; developers: string[] }[];
  /** Estimated tasks still on "Otomatis". */
  unassigned: number;
}

export function jiraAssignTargets(project: Pick<EstimateProject, 'tasks' | 'developers'>, scope: { id: string; jiraKeys: string[] }[]): JiraAssignTargets {
  const keysOf = new Map(scope.map((t) => [t.id, t.jiraKeys]));
  const devs = new Map(project.developers.map((d) => [d.id, d]));
  const byKey = new Map<string, JiraAssignTarget[]>();
  const out: JiraAssignTargets = { targets: [], noKey: [], noAccount: [], conflicts: [], unassigned: 0 };
  for (const t of project.tasks) {
    if (!t.assigneeId) {
      if (t.effortDays) out.unassigned++;
      continue;
    }
    const dev = devs.get(t.assigneeId);
    if (!dev) continue;
    const keys = keysOf.get(t.id) ?? [];
    if (!keys.length) {
      out.noKey.push(t.title);
      continue;
    }
    if (!dev.jira?.accountId) {
      out.noAccount.push({ taskTitle: t.title, developer: dev.name });
      continue;
    }
    for (const key of keys) byKey.set(key, [...(byKey.get(key) ?? []), { key, taskTitle: t.title, developer: dev.name, accountId: dev.jira.accountId }]);
  }
  for (const [key, list] of byKey) {
    const people = [...new Set(list.map((x) => x.accountId))];
    if (people.length > 1) out.conflicts.push({ key, developers: [...new Set(list.map((x) => x.developer))] });
    else out.targets.push(list[0]);
  }
  return out;
}

export interface JiraAssignChange extends JiraAssignTarget {
  /** Who has it in Jira now (null = nobody). */
  current: string | null;
}

/** Targets split by what Jira has now: only real changes are sent. Keys Jira didn't return are missing. */
export function splitByCurrent(targets: JiraAssignTarget[], current: Record<string, { accountId: string; displayName: string } | null>) {
  const change: JiraAssignChange[] = [];
  const same: JiraAssignTarget[] = [];
  const missing: string[] = [];
  for (const t of targets) {
    if (!(t.key in current)) missing.push(t.key);
    else if (current[t.key]?.accountId === t.accountId) same.push(t);
    else change.push({ ...t, current: current[t.key]?.displayName || null });
  }
  return { change, same, missing };
}
