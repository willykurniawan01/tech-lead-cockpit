import { api, connectorDownMessage } from '../api-base';
import type { EstimateJob, EstimateProject, EstimateRequest, Holiday } from './types';

const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/estimate${path}`), { ...init, headers: HEADERS });
  } catch {
    throw new Error(connectorDownMessage());
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });

type HolidayList = { holidays: Holiday[]; custom: boolean };

export const estimate = {
  holidays: () => call<HolidayList>('/holidays'),
  saveHolidays: (holidays: Holiday[]) => post<HolidayList>('/holidays', { holidays }),
  resetHolidays: () => post<HolidayList>('/holidays', { reset: true }),
  projects: () => call<EstimateProject[]>('/projects'),
  project: (id: string) => call<EstimateProject>(`/projects/one?id=${encodeURIComponent(id)}`),
  saveProject: (project: EstimateProject) => post<EstimateProject>('/projects', { project }),
  deleteProject: (id: string) => post<EstimateProject[]>('/projects/delete', { id }),
  start: (req: EstimateRequest) => post<EstimateJob>('/ai', req),
  job: (id: string) => call<{ job: EstimateJob | null }>(`/ai?id=${encodeURIComponent(id)}`).then((r) => r.job),
  latestJob: (projectId: string) => call<{ job: EstimateJob | null }>(`/ai?projectId=${encodeURIComponent(projectId)}`).then((r) => r.job),
  cancel: (id: string) => post<{ job: EstimateJob | null }>('/ai/cancel', { id }).then((r) => r.job),
};
