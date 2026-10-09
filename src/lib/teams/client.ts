import type {
  TeamsStatus,
  TeamsDeviceCodeAuth,
  TeamsChat,
  TeamsMessage,
  TeamsSendRequest,
  TeamsDraftRequest,
  TeamsDraftResponse,
} from './types';
import { api, connectorDownMessage } from '../api-base';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/teams${path}`), {
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

export const teams = {
  status: () => call<TeamsStatus>('/status'),
  login: (tenantId?: string, clientId?: string) => post<TeamsDeviceCodeAuth>('/login', { tenantId, clientId }),
  cancelLogin: () => post<{ ok: true }>('/login/cancel'),
  logout: () => post<TeamsStatus>('/logout'),
  /** Cached by the connector for a minute; `fresh` forces a reload from Microsoft. */
  chats: (fresh = false) => call<TeamsChat[]>(fresh ? '/chats?fresh=1' : '/chats'),
  messages: (chatId: string) => call<TeamsMessage[]>(`/messages?chatId=${encodeURIComponent(chatId)}`),
  send: (req: TeamsSendRequest) => post<{ ok: true; id: string }>('/send', req),
  draft: (req: TeamsDraftRequest) => post<TeamsDraftResponse>('/draft', req),
};
