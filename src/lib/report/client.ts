import { api, connectorDownMessage } from '../api-base';
import type { ProgressSnapshot } from './snapshot';

/** Mirrors connector/report/vps.ts. */
export interface ReportSettings {
  enabled: boolean;
  host: string;
  user: string;
  port: number;
  projectIds: string[];
  /** Send days (0 = Minggu … 6 = Sabtu) and times (HH:MM WIB). */
  days: number[];
  times: string[];
  deliver: string;
  lastSync?: { at: string; ok: boolean; error?: string; generatedAt?: string };
  /** What runs on the VPS now: one Hermes job per send time. */
  installed?: { at: string; jobs: { name: string; time: string; cron: string }[]; days: number[]; times: string[]; serverOffset: string; deliver: string; deliverSetting: string };
}

const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/report${path}`), { ...init, headers: HEADERS });
  } catch {
    throw new Error(connectorDownMessage());
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const report = {
  settings: () => call<ReportSettings>('/settings'),
  saveSettings: (settings: Partial<ReportSettings>) => post<ReportSettings>('/settings', { settings }),
  sync: (snapshot: ProgressSnapshot) => post<ReportSettings>('/sync', { snapshot }),
  install: () => post<{ settings: ReportSettings; output: string }>('/install'),
  preview: () => post<{ text: string; meta: { generatedAt?: string; jiraRefreshedAt?: string; jiraError?: string; previousAt?: string; error?: string } }>('/preview'),
  sendNow: () => post<{ output: string }>('/send-now'),
  status: () => call<{ status: string }>('/status').then((r) => r.status),
};
