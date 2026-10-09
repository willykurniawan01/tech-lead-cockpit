import type {
  JiraStatus,
  JiraIssue,
  JiraIssueDetail,
  JiraProject,
  JiraTransition,
  SaveTokenRequest,
  JiraUser,
  TadTicketRequest,
  TadTicketResult,
  TadTicketTemplate,
} from './types';
import type { DeveloperJiraLoad, JiraCandidate } from '../estimate/types';
import { api, connectorDownMessage } from '../api-base';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector${path}`), {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1', ...init.headers },
    });
  } catch {
    throw new Error(connectorDownMessage());
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const jira = {
  status: () => call<JiraStatus>('/jira/status'),
  saveToken: (req: SaveTokenRequest) => post<{ ok: true; message: string }>('/jira/save-token', req),
  issues: (jql?: string, maxResults = 25) =>
    call<JiraIssue[]>(
      `/jira/issues${jql ? `?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}` : `?maxResults=${maxResults}`}`
    ),
  issue: (key: string) => call<JiraIssueDetail>(`/jira/issue?key=${encodeURIComponent(key)}`),
  projects: () => call<JiraProject[]>('/jira/projects'),
  transitions: (key: string) => call<JiraTransition[]>(`/jira/transitions?key=${encodeURIComponent(key)}`),
  /** Moves the issue after checking the transition is still offered and the status hasn't changed. */
  transition: (key: string, transitionId: string, context: { mrUrl?: string; headSha?: string; expectedStatus?: string } = {}) =>
    post<{ ok: true; from?: string; to?: string }>('/jira/transition', { key, transitionId, ...context }),
  /** Jira users by name or email (to link a developer). */
  users: (q: string) => call<JiraUser[]>(`/jira/users?q=${encodeURIComponent(q)}`),
  /** Open work per account outside the given issue keys (stale issues and epics skipped). */
  loads: (accountIds: string[], excludeKeys: string[], opts: { defaultDays?: number; staleDays?: number } = {}) =>
    post<Record<string, DeveloperJiraLoad>>('/jira/load', { accountIds, excludeKeys, ...opts }),
  /** People assignable in these Jira projects, least loaded first. */
  candidates: (projectKeys: string[], excludeKeys: string[], opts: { defaultDays?: number; staleDays?: number } = {}) =>
    post<JiraCandidate[]>('/jira/candidates', { projectKeys, excludeKeys, ...opts }),
  issueTypes: (project: string) => call<{ id: string; name: string }[]>(`/jira/issue-types?project=${encodeURIComponent(project)}`),
  /** Project, type, epic, labels and components shared by these tickets (a TAD's existing tasks). */
  tadTemplate: (keys: string[]) => post<TadTicketTemplate>('/jira/tad-template', { keys }),
  /** Creates one ticket per task; an existing ticket with the same summary is linked instead. */
  createTadTickets: (req: TadTicketRequest) => post<TadTicketResult[]>('/jira/tad-tickets', req),
};
