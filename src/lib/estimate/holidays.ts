import type { Holiday } from './types';

/**
 * Indonesian national holidays and cuti bersama from the SKB 3 Menteri. Defaults only: the
 * user can edit the list in the app (a changed SKB, company-specific days off).
 * 2026: SKB per setneg.go.id. 2027: SKB signed 15 Sep 2026 (detik.com, kemenag.go.id).
 * Weekend dates are kept for completeness; they don't change the working-day count.
 */
export const DEFAULT_HOLIDAYS: Holiday[] = [
  // 2026 — libur nasional
  { date: '2026-01-01', name: 'Tahun Baru 2026 Masehi', kind: 'libur' },
  { date: '2026-01-16', name: 'Isra Mikraj Nabi Muhammad SAW', kind: 'libur' },
  { date: '2026-02-17', name: 'Tahun Baru Imlek 2577 Kongzili', kind: 'libur' },
  { date: '2026-03-19', name: 'Hari Suci Nyepi (Tahun Baru Saka 1948)', kind: 'libur' },
  { date: '2026-03-21', name: 'Idulfitri 1447 H', kind: 'libur' },
  { date: '2026-03-22', name: 'Idulfitri 1447 H', kind: 'libur' },
  { date: '2026-04-03', name: 'Wafat Yesus Kristus', kind: 'libur' },
  { date: '2026-04-05', name: 'Kebangkitan Yesus Kristus (Paskah)', kind: 'libur' },
  { date: '2026-05-01', name: 'Hari Buruh Internasional', kind: 'libur' },
  { date: '2026-05-14', name: 'Kenaikan Yesus Kristus', kind: 'libur' },
  { date: '2026-05-27', name: 'Iduladha 1447 H', kind: 'libur' },
  { date: '2026-05-31', name: 'Hari Raya Waisak 2570 BE', kind: 'libur' },
  { date: '2026-06-01', name: 'Hari Lahir Pancasila', kind: 'libur' },
  { date: '2026-06-16', name: '1 Muharam Tahun Baru Islam 1448 H', kind: 'libur' },
  { date: '2026-08-17', name: 'Proklamasi Kemerdekaan', kind: 'libur' },
  { date: '2026-08-25', name: 'Maulid Nabi Muhammad SAW', kind: 'libur' },
  { date: '2026-12-25', name: 'Kelahiran Yesus Kristus', kind: 'libur' },
  // 2026 — cuti bersama
  { date: '2026-02-16', name: 'Cuti bersama Tahun Baru Imlek', kind: 'cuti-bersama' },
  { date: '2026-03-18', name: 'Cuti bersama Hari Suci Nyepi', kind: 'cuti-bersama' },
  { date: '2026-03-20', name: 'Cuti bersama Idulfitri 1447 H', kind: 'cuti-bersama' },
  { date: '2026-03-23', name: 'Cuti bersama Idulfitri 1447 H', kind: 'cuti-bersama' },
  { date: '2026-03-24', name: 'Cuti bersama Idulfitri 1447 H', kind: 'cuti-bersama' },
  { date: '2026-05-15', name: 'Cuti bersama Kenaikan Yesus Kristus', kind: 'cuti-bersama' },
  { date: '2026-05-28', name: 'Cuti bersama Iduladha 1447 H', kind: 'cuti-bersama' },
  { date: '2026-12-24', name: 'Cuti bersama Kelahiran Yesus Kristus', kind: 'cuti-bersama' },
  // 2027 — libur nasional
  { date: '2027-01-01', name: 'Tahun Baru 2027 Masehi', kind: 'libur' },
  { date: '2027-01-05', name: 'Isra Mikraj Nabi Muhammad SAW 1448 H', kind: 'libur' },
  { date: '2027-02-06', name: 'Tahun Baru Imlek 2578 Kongzili', kind: 'libur' },
  { date: '2027-03-08', name: 'Hari Suci Nyepi (Tahun Baru Saka 1949)', kind: 'libur' },
  { date: '2027-03-10', name: 'Idulfitri 1448 H', kind: 'libur' },
  { date: '2027-03-11', name: 'Idulfitri 1448 H', kind: 'libur' },
  { date: '2027-03-26', name: 'Wafat Yesus Kristus', kind: 'libur' },
  { date: '2027-03-28', name: 'Kebangkitan Yesus Kristus (Paskah)', kind: 'libur' },
  { date: '2027-05-01', name: 'Hari Buruh Internasional', kind: 'libur' },
  { date: '2027-05-06', name: 'Kenaikan Yesus Kristus', kind: 'libur' },
  { date: '2027-05-17', name: 'Iduladha 1448 H', kind: 'libur' },
  { date: '2027-05-20', name: 'Hari Raya Waisak 2571 BE', kind: 'libur' },
  { date: '2027-06-01', name: 'Hari Lahir Pancasila', kind: 'libur' },
  { date: '2027-06-06', name: '1 Muharam Tahun Baru Islam 1449 H', kind: 'libur' },
  { date: '2027-08-15', name: 'Maulid Nabi Muhammad SAW', kind: 'libur' },
  { date: '2027-08-17', name: 'Proklamasi Kemerdekaan', kind: 'libur' },
  { date: '2027-12-25', name: 'Kelahiran Yesus Kristus', kind: 'libur' },
  { date: '2027-12-26', name: 'Isra Mikraj Nabi Muhammad SAW 1449 H', kind: 'libur' },
  // 2027 — cuti bersama
  { date: '2027-02-05', name: 'Cuti bersama Tahun Baru Imlek', kind: 'cuti-bersama' },
  { date: '2027-03-09', name: 'Cuti bersama Idulfitri 1448 H', kind: 'cuti-bersama' },
  { date: '2027-03-12', name: 'Cuti bersama Idulfitri 1448 H', kind: 'cuti-bersama' },
  { date: '2027-03-15', name: 'Cuti bersama Idulfitri 1448 H', kind: 'cuti-bersama' },
  { date: '2027-03-25', name: 'Cuti bersama Wafat Yesus Kristus', kind: 'cuti-bersama' },
  { date: '2027-05-18', name: 'Cuti bersama Iduladha 1448 H', kind: 'cuti-bersama' },
  { date: '2027-05-19', name: 'Cuti bersama Hari Raya Waisak', kind: 'cuti-bersama' },
  { date: '2027-12-24', name: 'Cuti bersama Kelahiran Yesus Kristus', kind: 'cuti-bersama' },
];

/** Years the list covers; dates beyond them only skip weekends (the UI warns). */
export function coveredYears(holidays: Holiday[]): number[] {
  return [...new Set(holidays.map((h) => Number(h.date.slice(0, 4))))].sort();
}
