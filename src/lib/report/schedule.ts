/**
 * When the scheduled report goes out: days of the week and one or more times, in WIB. Pure, so
 * the modal (summary, next sends) and the connector (Hermes cron in the server's timezone) agree.
 */

export const WIB_OFFSET_MIN = 7 * 60;
/** Index = JavaScript/cron day (0 = Minggu). */
export const DAY_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
export const DAY_LONG = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
export const MAX_TIMES = 6;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface SendSchedule {
  /** Days of the week, 0 = Minggu … 6 = Sabtu. */
  days: number[];
  /** HH:MM in WIB. */
  times: string[];
}

export function isTime(t: string): boolean {
  return TIME.test(t);
}

/** Sorted, de-duplicated, validated copy (throws with a readable message). */
export function normalizeSchedule(s: Partial<SendSchedule>): SendSchedule {
  const days = [...new Set((s.days ?? []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  const times = [...new Set((s.times ?? []).map(String))].sort();
  if (!days.length) throw new Error('Pilih minimal satu hari kirim.');
  if (!times.length) throw new Error('Isi minimal satu jam kirim.');
  if (times.length > MAX_TIMES) throw new Error(`Maksimal ${MAX_TIMES} jam kirim per hari.`);
  const bad = times.find((t) => !isTime(t));
  if (bad) throw new Error(`Jam kirim "${bad}" harus HH:MM.`);
  return { days, times };
}

/** "Senin–Jumat", "Setiap hari", "Sen, Rab, Jum". */
export function describeDays(days: number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'Setiap hari';
  if (d.join() === WEEKDAYS.join()) return 'Senin–Jumat';
  if (d.join() === '0,6') return 'Sabtu & Minggu';
  // A run of consecutive days reads better as a range.
  if (d.length >= 3 && d.every((x, i) => i === 0 || x === d[i - 1] + 1)) return `${DAY_LONG[d[0]]}–${DAY_LONG[d[d.length - 1]]}`;
  return d.map((x) => DAY_SHORT[x]).join(', ');
}

/** "Senin–Jumat pukul 09:00 & 16:00 WIB". */
export function describeSchedule(s: SendSchedule): string {
  const times = [...s.times].sort();
  const t = times.length > 1 ? `${times.slice(0, -1).join(', ')} & ${times[times.length - 1]}` : times[0];
  return `${describeDays(s.days)} pukul ${t} WIB`;
}

/** The next `count` send moments after `from` (as instants). */
export function nextSends(s: SendSchedule, from: Date, count = 3): Date[] {
  const out: Date[] = [];
  // Walk WIB calendar days: shift the clock so UTC getters read WIB.
  const wibNow = new Date(from.getTime() + WIB_OFFSET_MIN * 60_000);
  const times = [...s.times].sort();
  for (let day = 0; day < 15 && out.length < count; day++) {
    const d = new Date(Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate() + day));
    if (!s.days.includes(d.getUTCDay())) continue;
    for (const t of times) {
      const [h, m] = t.split(':').map(Number);
      const instant = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) - WIB_OFFSET_MIN * 60_000);
      if (instant > from && out.length < count) out.push(instant);
    }
  }
  return out;
}

function parseOffset(serverOffset: string): number {
  const o = serverOffset.trim().match(/^([+-])(\d{2})(\d{2})$/);
  if (!o) throw new Error(`Zona waktu server tidak valid: ${serverOffset}`);
  return (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3]));
}

/** A WIB time on the server's clock, plus how many days it shifts (crossing midnight). */
export function toServerTime(time: string, serverOffset: string): { time: string; dayShift: number } {
  const t = time.match(TIME);
  if (!t) throw new Error(`Jam kirim "${time}" harus HH:MM.`);
  const total = Number(t[1]) * 60 + Number(t[2]) + (parseOffset(serverOffset) - WIB_OFFSET_MIN);
  const minuteOfDay = ((total % 1440) + 1440) % 1440;
  return { time: `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`, dayShift: Math.floor(total / 1440) };
}

/** Cron expression (server timezone) for one WIB time on the given WIB days. */
export function cronFor(time: string, days: number[], serverOffset: string): string {
  const { time: st, dayShift } = toServerTime(time, serverOffset);
  const [h, m] = st.split(':').map(Number);
  const set = [...new Set(days)].sort((a, b) => a - b);
  const dow = set.length === 7 ? '*' : set.map((d) => (((d + dayShift) % 7) + 7) % 7).sort((a, b) => a - b).join(',');
  return `${m} ${h} * * ${dow}`;
}

/** Hermes job name per WIB send time. */
export function jobName(time: string): string {
  return `tad-progress-${time.replace(':', '')}`;
}
