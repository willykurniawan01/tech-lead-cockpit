import { api, connectorDownMessage } from '../api-base';
import type { RemoteDuration, RemotePairing, RemoteSettings, RemoteStatus } from './types';

const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(`/api/connector/remote${path}`), { ...init, headers: HEADERS });
  } catch {
    throw new Error(connectorDownMessage());
  }
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** Remote Access control; these routes exist on the local connector only. */
export const remote = {
  status: () => call<RemoteStatus>('/status'),
  enable: (duration: RemoteDuration) => post<RemoteStatus>('/enable', { duration }),
  disable: () => post<RemoteStatus>('/disable'),
  pair: () => post<RemotePairing>('/pair'),
  revoke: (deviceId: string) => post<RemoteStatus>('/devices/revoke', { deviceId }),
  settings: () => call<RemoteSettings>('/settings'),
  saveSettings: (s: RemoteSettings) => post<RemoteSettings>('/settings', s),
};

/** "2 j 5 mnt" style remaining time. */
export function remainingLabel(ms: number): string {
  const min = Math.max(0, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} mnt`;
  return `${Math.floor(min / 60)} j ${min % 60} mnt`;
}

/** Next occurrence of HH:MM (today, or tomorrow when already past), as ISO. */
export function untilIso(hhmm: string, now = new Date()): string | null {
  const m = hhmm.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
