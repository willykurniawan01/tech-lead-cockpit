import { describe, expect, it } from 'vitest';
import { EVERY_DAY, WEEKDAYS, cronFor, describeDays, describeSchedule, jobName, nextSends, normalizeSchedule, toServerTime } from './schedule';

describe('send schedule', () => {
  it('normalizes and validates', () => {
    expect(normalizeSchedule({ days: [5, 1, 1, 3], times: ['16:00', '09:00', '16:00'] })).toEqual({ days: [1, 3, 5], times: ['09:00', '16:00'] });
    expect(() => normalizeSchedule({ days: [], times: ['09:00'] })).toThrow('hari');
    expect(() => normalizeSchedule({ days: [1], times: [] })).toThrow('jam');
    expect(() => normalizeSchedule({ days: [1], times: ['25:00'] })).toThrow('HH:MM');
    expect(() => normalizeSchedule({ days: [1], times: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00'] })).toThrow('Maksimal');
  });

  it('describes days and times in Indonesian', () => {
    expect(describeDays(WEEKDAYS)).toBe('Senin–Jumat');
    expect(describeDays(EVERY_DAY)).toBe('Setiap hari');
    expect(describeDays([0, 6])).toBe('Sabtu & Minggu');
    expect(describeDays([2, 3, 4])).toBe('Selasa–Kamis');
    expect(describeDays([1, 3, 5])).toBe('Sen, Rab, Jum');
    expect(describeSchedule({ days: WEEKDAYS, times: ['16:00', '09:00'] })).toBe('Senin–Jumat pukul 09:00 & 16:00 WIB');
    expect(describeSchedule({ days: EVERY_DAY, times: ['08:00', '12:00', '17:30'] })).toBe('Setiap hari pukul 08:00, 12:00 & 17:30 WIB');
  });

  it('lists the next sends in WIB, skipping days off', () => {
    // Thursday 8 Oct 2026, 10:00 WIB.
    const from = new Date('2026-10-08T03:00:00Z');
    const next = nextSends({ days: WEEKDAYS, times: ['09:00', '16:00'] }, from, 4).map((d) => d.toISOString());
    expect(next).toEqual(['2026-10-08T09:00:00.000Z', '2026-10-09T02:00:00.000Z', '2026-10-09T09:00:00.000Z', '2026-10-12T02:00:00.000Z']);
    // Late Friday evening WIB → Monday.
    expect(nextSends({ days: WEEKDAYS, times: ['16:00'] }, new Date('2026-10-09T15:00:00Z'), 1)[0].toISOString()).toBe('2026-10-12T09:00:00.000Z');
  });

  it('converts to the server clock and cron, shifting days across midnight', () => {
    expect(toServerTime('16:00', '+0800')).toEqual({ time: '17:00', dayShift: 0 });
    expect(toServerTime('23:30', '+0800')).toEqual({ time: '00:30', dayShift: 1 });
    expect(cronFor('16:00', WEEKDAYS, '+0800')).toBe('0 17 * * 1,2,3,4,5');
    expect(cronFor('16:00', WEEKDAYS, '+0700')).toBe('0 16 * * 1,2,3,4,5');
    expect(cronFor('06:30', WEEKDAYS, '-0500')).toBe('30 18 * * 0,1,2,3,4');
    expect(cronFor('23:30', WEEKDAYS, '+0800')).toBe('30 0 * * 2,3,4,5,6');
    expect(cronFor('07:15', EVERY_DAY, '+0530')).toBe('45 5 * * *');
    expect(cronFor('09:00', [1, 3, 5], '+0800')).toBe('0 10 * * 1,3,5');
    expect(() => cronFor('16:00', WEEKDAYS, 'CST')).toThrow();
    expect(jobName('09:30')).toBe('tad-progress-0930');
  });
});
