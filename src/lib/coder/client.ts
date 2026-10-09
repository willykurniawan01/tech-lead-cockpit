import { api, connectorDownMessage } from '../api-base';
import type { MrFileChange } from '../gitlab/types';
import type { CoderAiReview, CoderProfile, CoderProfileId, CoderRun, CoderSettings, CoderState, StartCoderRunRequest } from './types';

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/coder${path}`), {
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

/** Coding agents working on TAD tasks (connector/coder-runs.ts). */
export const coder = {
  state: () => call<CoderState>('/state'),
  repos: () => call<string[]>('/repos'),
  settings: (patch: Partial<CoderSettings> & { profiles?: Partial<Record<CoderProfileId, Partial<CoderProfile>>> }) => call<CoderState>('/settings', patch),
  start: (requests: StartCoderRunRequest[]) => call<CoderRun[]>('/runs', { requests }),
  diff: (id: string) => call<MrFileChange[]>(`/runs/diff?id=${encodeURIComponent(id)}`),
  push: (id: string) => call<CoderRun>('/runs/push', { id }),
  revise: (id: string, feedback: string, opts?: { syncTarget?: boolean }) => call<CoderRun>('/runs/revise', { id, feedback, syncTarget: opts?.syncTarget }),
  resume: (id: string, feedback?: string) => call<CoderRun>('/runs/resume', { id, feedback }),
  syncLocal: (id: string) => call<{ branch: string; repo: string; synced: boolean; message: string }>('/runs/sync-local', { id }),
  cancel: (id: string) => call<CoderRun>('/runs/cancel', { id }),
  complete: (id: string, feedback?: string) => call<CoderRun>('/runs/complete', { id, feedback }),
  remove: (id: string) => call<{ ok: true }>('/runs/remove', { id }),
  runTests: (id: string) => call<CoderRun['test']>('/runs/test', { id }),
  generateFlowTests: (id: string, feedback?: string) => call<CoderRun>('/runs/flow-tests', { id, feedback }),
  saveReview: (id: string, review: CoderAiReview) => call<CoderRun>('/runs/review', { id, review }),
};

/** BACKEND tasks → backend profile; WEB-FE / MOBILE-FE / FRONTEND → frontend. */
export function profileForTask(title: string): CoderProfileId {
  return /^\[(WEB-FE|MOBILE-FE|FRONTEND|FE)\]/i.test(title.trim()) ? 'frontend' : 'backend';
}

/** Best Services folder for a TAD service name (CORE-TCICO-ULTIMATE → core-tcico-ultimate). */
export function suggestRepo(services: string[], ...names: (string | undefined)[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const name of names.filter(Boolean).map((n) => norm(n!))) {
    const exact = services.find((s) => norm(s) === name);
    if (exact) return exact;
  }
  for (const name of names.filter(Boolean).map((n) => norm(n!))) {
    const prefix = services.filter((s) => norm(s).startsWith(name) || name.startsWith(norm(s))).sort((a, b) => a.length - b.length);
    if (prefix.length) return prefix[0];
  }
  return '';
}
