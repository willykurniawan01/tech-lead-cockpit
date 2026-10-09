import type { AuditEvent } from '../src/lib/confluence/api-types.ts';
import { JiraError, type JiraTransition } from './jira.ts';

export interface TransitionRequest {
  key: string;
  transitionId: string;
  /** MR the decision was based on, for the audit trail. */
  mrUrl?: string;
  headSha?: string;
  /** Status the user saw when choosing; the move is refused if the issue changed since. */
  expectedStatus?: string;
}

interface JiraLike {
  getIssue(key: string): Promise<{ status: string }>;
  getTransitions(key: string): Promise<JiraTransition[]>;
  transitionIssue(key: string, transitionId: string): Promise<void>;
}

/**
 * Moves an issue only if Jira still offers that transition and the status is what the user saw;
 * every attempt (success or failure) is audited with the MR it came from.
 */
export async function transitionWithChecks(jc: JiraLike, req: TransitionRequest, appendAudit: (e: AuditEvent) => Promise<void>) {
  const [issue, transitions] = await Promise.all([jc.getIssue(req.key), jc.getTransitions(req.key)]);
  const t = transitions.find((x) => x.id === req.transitionId);
  if (!t) throw new JiraError(`Transisi tidak tersedia untuk ${req.key} pada status "${issue.status}".`, 409, 'conflict');
  if (req.expectedStatus && req.expectedStatus !== issue.status) {
    throw new JiraError(`Status ${req.key} sudah berubah menjadi "${issue.status}". Muat ulang sebelum memindahkan.`, 409, 'conflict');
  }
  const base = {
    ts: new Date().toISOString(),
    action: 'jira.transition' as const,
    spaceKey: 'Jira',
    title: `${req.key}: ${issue.status} → ${t.to.name}`,
    attachments: 0,
    jiraKeys: [req.key],
    mrUrl: req.mrUrl,
    headSha: req.headSha,
  };
  try {
    await jc.transitionIssue(req.key, req.transitionId);
  } catch (e) {
    await appendAudit({ ...base, result: 'failure', error: (e as Error).message }).catch(() => {});
    throw e;
  }
  await appendAudit({ ...base, result: 'success' }).catch(() => {});
  return { ok: true as const, from: issue.status, to: t.to.name };
}
