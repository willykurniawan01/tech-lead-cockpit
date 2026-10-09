import { api, connectorDownMessage } from '../api-base';
import type { AssistantConversation, AssistantConversationSummary } from './types';

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/assistant/conversations${path}`), {
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

/** Saved Assistant conversations (stored by the connector under ~/.tech-lead-cockpit/assistant). */
export const conversations = {
  list: () => call<AssistantConversationSummary[]>(''),
  get: (id: string) => call<AssistantConversation>(`/one?id=${encodeURIComponent(id)}`),
  update: (id: string, patch: { title?: string; pinned?: boolean }) => call<AssistantConversationSummary>('/update', { id, ...patch }),
  remove: (id: string) => call<{ ok: true }>('/delete', { id }),
};
