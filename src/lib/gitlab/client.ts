import { api, connectorDownMessage } from '../api-base';
import type { GitLabStatus, GitLabUser, MrDetail, MrScope, MrSummary } from './types';

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/gitlab${path}`), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(connectorDownMessage());
  }
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** sessionStorage key other screens set (to an MR link) before navigating to #/mr. */
export const OPEN_MR_KEY = 'tlc.mr.open';

/** Read-only access to the internal GitLab through the local connector. */
export const gitlab = {
  status: () => call<GitLabStatus>('/status'),
  saveToken: (token: string, baseUrl?: string) => call<{ ok: true; user: GitLabUser }>('/save-token', { token, baseUrl }),
  mrs: (scope: MrScope) => call<MrSummary[]>(`/mrs?scope=${scope}`),
  /** MRs per Jira key (branch, title or description mention it). */
  mrsForKeys: (keys: string[]) => call<Record<string, MrSummary[]>>(`/mrs/by-keys?keys=${encodeURIComponent(keys.join(','))}`),
  mrByUrl: (url: string) => call<MrDetail>(`/mr?url=${encodeURIComponent(url)}`),
  mr: (projectPath: string, iid: number) => call<MrDetail>(`/mr?project=${encodeURIComponent(projectPath)}&iid=${iid}`),
  /** Links an MR to a Jira key by hand when auto-detection misses it; it then counts like any other MR. */
  addManualMr: (key: string, url: string) => call<unknown>('/manual-mrs', { key, url }),
  removeManualMr: (key: string, ref: string) => call<unknown>('/manual-mrs/delete', { key, ref }),
};
