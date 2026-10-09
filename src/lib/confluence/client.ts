import type {
  AuditEvent,
  ConnectorError,
  ConnectorStatus,
  PageInfo,
  PreflightRequest,
  PreflightResponse,
  PublishRequest,
  PublishResponse,
} from './api-types';
import { api, connectorDownMessage } from '../api-base';

export class ConnectorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ConnectorError,
  ) {
    super(body.error);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector${path}`), {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1', ...init.headers },
    });
  } catch {
    throw new ConnectorRequestError(0, { error: connectorDownMessage(), code: 'network' });
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new ConnectorRequestError(res.status, body as ConnectorError);
  return body as T;
}

export const connector = {
  status: () => call<ConnectorStatus>('/status'),
  audit: () => call<AuditEvent[]>('/audit'),
  searchPages: (q: string, space?: string) =>
    call<PageInfo[]>(`/confluence/search?q=${encodeURIComponent(q)}${space ? `&space=${encodeURIComponent(space)}` : ''}`),
  page: (ref: { id: string } | { space: string; title: string }) =>
    call<PageInfo>(`/confluence/page?${'id' in ref ? `id=${encodeURIComponent(ref.id)}` : `space=${encodeURIComponent(ref.space)}&title=${encodeURIComponent(ref.title)}`}`),
  /** Current version of a page (no body), with who changed it last and when. */
  pageVersion: (id: string) => call<{ version: number; when?: string; by?: string }>(`/confluence/page/version?id=${encodeURIComponent(id)}`),
  /** The page's storage at an earlier version. */
  pageAt: (id: string, version: number) => call<{ version: number; storage: string }>(`/confluence/page/at?id=${encodeURIComponent(id)}&version=${version}`),
  /** Exact display name → account id (Cloud user directory). */
  resolveUsers: (names: string[]) => call<Record<string, string>>('/confluence/users/resolve', { method: 'POST', body: JSON.stringify({ names }) }),
  preflight: (req: PreflightRequest) => call<PreflightResponse>('/confluence/preflight', { method: 'POST', body: JSON.stringify(req) }),
  publish: (req: PublishRequest) => call<PublishResponse>('/confluence/publish', { method: 'POST', body: JSON.stringify(req) }),
  saveToken: (req: { token: string; baseUrl?: string; email?: string }) =>
    call<{ ok: true; message: string }>('/confluence/save-token', { method: 'POST', body: JSON.stringify(req) }),
};
