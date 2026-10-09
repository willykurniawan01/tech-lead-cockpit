import { api, connectorDownMessage } from '../api-base';
import { AGENT_LIMITS, type AgentTask, type AgentTaskEvent, type AgentTaskStatus } from './types';

/** Connector (or local validation) failure. `status` 0 means the connector was unreachable or the input never left the browser. */
export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentApiError';
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
    throw new AgentApiError(0, 'network', connectorDownMessage());
  }
  const body = (await res.json().catch(() => undefined)) as { error?: unknown; code?: unknown } | undefined;
  if (!res.ok) {
    const message = typeof body?.error === 'string' && body.error ? body.error : `HTTP ${res.status}`;
    throw new AgentApiError(res.status, typeof body?.code === 'string' ? body.code : 'http', message);
  }
  if (body === undefined) throw new AgentApiError(res.status, 'invalid-response', 'Respons connector tidak valid.');
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });
const task = (id: string) => `/agent-tasks/${encodeURIComponent(id)}`;

export const agents = {
  list: (opts: { status?: AgentTaskStatus[]; limit?: number; sync?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.status?.length) q.set('status', opts.status.join(','));
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts.sync) q.set('sync', '1');
    const qs = q.toString();
    return call<{ tasks: AgentTask[] }>(`/agent-tasks${qs ? `?${qs}` : ''}`).then((r) => r.tasks);
  },
  get: (id: string) => call<{ task: AgentTask; events: AgentTaskEvent[] }>(task(id)),
  cancel: (id: string) => post<{ task: AgentTask }>(`${task(id)}/cancel`).then((r) => r.task),
  complete: (id: string, reason?: string) => post<{ task: AgentTask }>(`${task(id)}/complete`, reason ? { message: reason } : {}).then((r) => r.task),
  syncMrs: () => post<{ ok: boolean; updated: number }>('/agent-tasks/sync-mrs', {}),
  steer: (id: string, message: string) => {
    const text = message.trim();
    if (!text) return Promise.reject(new AgentApiError(0, 'validation', 'Pesan revisi tidak boleh kosong.'));
    if (text.length > AGENT_LIMITS.steer) return Promise.reject(new AgentApiError(0, 'validation', `Pesan revisi maksimal ${AGENT_LIMITS.steer} karakter.`));
    return post<{ ok: true }>(`${task(id)}/steer`, { message: text });
  },
};

/** Display order: what needs a human first, finished work last. */
export const STATUS_ORDER: AgentTaskStatus[] = ['blocked', 'running', 'queued', 'pending', 'failed', 'completed', 'cancelled'];

export function groupByStatus(tasks: AgentTask[]): { status: AgentTaskStatus; tasks: AgentTask[] }[] {
  return STATUS_ORDER.map((status) => ({ status, tasks: tasks.filter((t) => t.status === status) })).filter((g) => g.tasks.length);
}

export const isLive = (t: AgentTask) => t.status === 'running' || t.status === 'blocked' || t.status === 'queued';
