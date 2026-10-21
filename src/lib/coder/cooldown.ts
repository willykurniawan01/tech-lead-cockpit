import type { CoderRun } from './types';

/** Time left until the run's provider quota is back; 0 when there is no cooldown. */
export function quotaCooldownMs(run: Pick<CoderRun, 'quotaResetAt'>, now = Date.now()): number {
  const at = run.quotaResetAt ? Date.parse(run.quotaResetAt) : NaN;
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

/** `188_000` → "3 menit 8 detik"; rounded up to whole seconds so a countdown never shows 0 early. */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h} jam ${m} menit` : `${h} jam`;
  if (m) return s ? `${m} menit ${s} detik` : `${m} menit`;
  return `${s} detik`;
}
