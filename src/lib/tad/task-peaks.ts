import { api } from '../api-base';
import { applyTaskPeaks, type DevStage, type TadProgressData } from './progress-report';

/**
 * The connector's record of the furthest stage each task reached (connector/task-peaks.ts), so
 * a task that goes back never lowers progress. Cached here; raises are sent back as they happen.
 */

const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };
const TTL_MS = 60_000;
let cache: { at: number; peaks: Record<string, DevStage> } | null = null;
let inflight: Promise<Record<string, DevStage>> | null = null;

export function loadTaskPeaks(): Promise<Record<string, DevStage>> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.peaks);
  inflight ??= fetch(api('/api/connector/progress/task-peaks'), { headers: HEADERS })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, DevStage>>) : {}))
    .catch(() => cache?.peaks ?? {})
    .then((peaks) => {
      cache = { at: Date.now(), peaks };
      return peaks;
    })
    .finally(() => (inflight = null));
  return inflight;
}

/** Stores peaks that went up; best effort (the next load retries what was missed). */
export async function recordTaskPeaks(raised: Record<string, DevStage>): Promise<void> {
  if (!Object.keys(raised).length) return;
  if (cache) cache.peaks = { ...cache.peaks, ...raised };
  try {
    const res = await fetch(api('/api/connector/progress/task-peaks'), { method: 'POST', headers: HEADERS, body: JSON.stringify({ peaks: raised }) });
    if (res.ok) cache = { at: Date.now(), peaks: (await res.json()) as Record<string, DevStage> };
  } catch {
    /* kept in the cache; sent again on the next raise */
  }
}

/** A TAD's progress with every task held at the furthest stage it reached. */
export async function withTaskPeaks<T extends TadProgressData>(tad: T): Promise<T> {
  const { rows, raised } = applyTaskPeaks(tad.tadId, tad.rows, await loadTaskPeaks());
  void recordTaskPeaks(raised);
  return { ...tad, rows };
}
