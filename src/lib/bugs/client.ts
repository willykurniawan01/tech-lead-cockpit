import { api, connectorDownMessage } from '../api-base';
import type { CoderRun } from '../coder/types';
import type { BugAnalyzeRequest, BugCase, BugCaseInput, BugJob, BugTaskProposal, BugTaskStatus, BugTicketRequest } from './types';

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
const q = (p: Record<string, string>) => `?${new URLSearchParams(p)}`;

export const bugs = {
  list: () => call<BugCase[]>('/bugs'),
  get: (id: string) => call<BugCase>(`/bugs/one${q({ id })}`),
  create: (c: Partial<BugCaseInput>) => post<BugCase>('/bugs', { case: c }),
  update: (id: string, c: Partial<BugCaseInput>) => post<BugCase>('/bugs/update', { id, case: c }),
  remove: (id: string) => post<{ ok: true }>('/bugs/delete', { id }),
  addLog: (id: string, name: string, text: string) => post<BugCase>('/bugs/logs', { id, name, text }),
  removeLog: (id: string, name: string) => post<BugCase>('/bugs/logs/delete', { id, name }),
  readLog: (id: string, name: string) => call<{ text: string; truncated: boolean }>(`/bugs/logs/read${q({ id, name })}`),
  analyze: (req: BugAnalyzeRequest) => post<BugJob>('/bugs/analyze', req),
  job: (id: string) => call<{ job: BugJob | null }>(`/bugs/analyze${q({ id })}`).then((r) => r.job),
  latestJob: (caseId: string) => call<{ job: BugJob | null }>(`/bugs/analyze${q({ caseId })}`).then((r) => r.job),
  cancel: (id: string) => post<{ job: BugJob | null }>('/bugs/analyze/cancel', { id }).then((r) => r.job),
  issueTypes: (project: string) => call<{ id: string; name: string }[]>(`/bugs/jira-types${q({ project })}`),
  ticket: (req: BugTicketRequest) => post<BugCase>('/bugs/ticket', req),
  /** Recent tracing jobs across all cases (Agent Tasks). */
  jobs: () => call<BugJob[]>('/bugs/jobs'),
  addTask: (caseId: string, task: Partial<BugTaskProposal>) => post<BugCase>('/bugs/tasks/add', { caseId, task }),
  updateTask: (caseId: string, taskId: string, task: Partial<BugTaskProposal>) => post<BugCase>('/bugs/tasks/update', { caseId, taskId, task }),
  removeTask: (caseId: string, taskId: string) => post<BugCase>('/bugs/tasks/delete', { caseId, taskId }),
  setTaskStatus: (caseId: string, taskId: string, status: BugTaskStatus) => post<BugCase>('/bugs/tasks/status', { caseId, taskId, status }),
  fix: (req: { caseId: string; taskId: string; profile?: 'backend' | 'frontend'; baseBranch?: string; targetBranch?: string }) => post<{ case: BugCase; run: CoderRun }>('/bugs/fix', req),
  setStatus: (id: string, status: BugCase['status']) => post<BugCase>('/bugs/status', { id, status }),
};
