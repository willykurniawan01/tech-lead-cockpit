import type { WaChat, WaDraftRequest, WaDraftResponse, WaMessage, WaSendRequest, WaStatus, WaTemplate } from './types';
import { api, connectorDownMessage } from '../api-base';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/wa${path}`), {
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

const post = <T>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const wa = {
  status: () => call<WaStatus>('/status'),
  connect: () => post<WaStatus>('/connect'),
  logout: () => post<WaStatus>('/logout'),
  chats: () => call<WaChat[]>('/chats'),
  messages: (jid: string) => call<WaMessage[]>(`/messages?jid=${encodeURIComponent(jid)}`),
  draft: (req: WaDraftRequest) => post<WaDraftResponse>('/draft', req),
  send: (req: WaSendRequest) => post<{ ok: true }>('/send', req),
  setContactName: (jid: string, name: string) => post<{ ok: true; name: string }>('/contact', { jid, name }),
  templates: () => call<WaTemplate[]>('/templates'),
  saveTemplates: (templates: WaTemplate[]) => call<WaTemplate[]>('/templates', { method: 'PUT', body: JSON.stringify(templates) }),
};
