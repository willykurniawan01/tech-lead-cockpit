import type { AiSelection } from '../ai/types';
import { api, connectorDownMessage } from '../api-base';
import type { Trace } from './types';

const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector${path}`), { ...init, headers: HEADERS });
  } catch {
    throw new Error(connectorDownMessage());
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const traces = {
  list: () => call<Trace[]>('/traces'),
  get: (id: string) => call<Trace>(`/traces/one?${new URLSearchParams({ id })}`),
  /** New trace, or a follow-up question when `traceId` is given. Runs in the background. */
  ask: (question: string, ai: AiSelection, traceId?: string) => post<Trace>('/traces', { question, ai, traceId }),
  cancel: (id: string) => post<Trace>('/traces/cancel', { id }),
  remove: (id: string) => post<{ ok: true }>('/traces/delete', { id }),
};
