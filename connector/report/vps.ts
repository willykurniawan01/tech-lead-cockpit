import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isSnapshot, type ProgressSnapshot } from '../../src/lib/report/snapshot.ts';
import { WEEKDAYS, cronFor, jobName, normalizeSchedule, toServerTime } from '../../src/lib/report/schedule.ts';
import { DATA_DIR } from '../paths.ts';

/**
 * Scheduled progress report: Cockpit pushes its progress snapshot to the user's VPS over SSH
 * (key auth only, BatchMode, never a password) and installs a Hermes script-only cron job that
 * renders and delivers it. No API on the VPS: everything goes through the existing sshd.
 * Every value placed in a remote command is validated against a strict pattern first.
 */

export const REMOTE_DIR = '.hermes/tad-progress';
/** Wrapper script name; also the job name used before multiple send times existed. */
export const JOB_NAME = 'tad-progress';
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export class ReportInputError extends Error {}

export interface InstalledJob {
  name: string;
  /** Send time in WIB. */
  time: string;
  /** Cron in the server's timezone. */
  cron: string;
}

export interface ReportSettings {
  enabled: boolean;
  host: string;
  user: string;
  port: number;
  projectIds: string[];
  /** Send days (0 = Minggu … 6 = Sabtu) and times (HH:MM WIB). */
  days: number[];
  times: string[];
  /** 'allowlist' = first number in the VPS's WHATSAPP_ALLOWED_USERS; else whatsapp:<number> or whatsapp:<group>@g.us. */
  deliver: string;
  lastSync?: { at: string; ok: boolean; error?: string; generatedAt?: string };
  /** What is installed on the VPS right now (one Hermes job per send time). */
  installed?: { at: string; jobs: InstalledJob[]; days: number[]; times: string[]; serverOffset: string; deliver: string; deliverSetting: string };
}

export const DEFAULT_SETTINGS: ReportSettings = {
  enabled: false,
  host: '',
  user: 'ubuntu',
  port: 22,
  projectIds: [],
  days: WEEKDAYS,
  times: ['16:00'],
  deliver: 'allowlist',
};

const HOST = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const DELIVER = /^(allowlist|whatsapp:\d{8,15}|whatsapp:[0-9-]{10,40}@g\.us)$/;
const JOB = /^tad-progress(-\d{4})?$/;

type Legacy = { timeWib?: string; weekdaysOnly?: boolean; installed?: { at: string; cron?: string; serverOffset: string; deliver: string; jobs?: InstalledJob[] } };

/** Settings saved before days/times existed: one time, weekdays or every day, one job. */
export function migrateSettings(raw: Partial<ReportSettings> & Legacy): Partial<ReportSettings> {
  const out: Partial<ReportSettings> & Legacy = { ...raw };
  if (!out.times && out.timeWib) out.times = [out.timeWib];
  if (!out.days && out.weekdaysOnly !== undefined) out.days = out.weekdaysOnly ? WEEKDAYS : [0, 1, 2, 3, 4, 5, 6];
  const inst = out.installed as Legacy['installed'];
  if (inst && !inst.jobs && inst.cron) {
    out.installed = { at: inst.at, jobs: [{ name: JOB_NAME, time: out.timeWib ?? '16:00', cron: inst.cron }], days: out.days ?? WEEKDAYS, times: out.times ?? ['16:00'], serverOffset: inst.serverOffset, deliver: inst.deliver, deliverSetting: out.deliver ?? 'allowlist' };
  }
  delete out.timeWib;
  delete out.weekdaysOnly;
  return out;
}

export function validateSettings(raw: Partial<ReportSettings>, current: ReportSettings = DEFAULT_SETTINGS): ReportSettings {
  const s = { ...current, ...raw };
  const host = String(s.host ?? '').trim();
  if (host && !HOST.test(host)) throw new ReportInputError('Alamat VPS tidak valid (IP atau hostname).');
  const user = String(s.user ?? '').trim();
  if (!USER.test(user)) throw new ReportInputError('User SSH tidak valid.');
  const port = Number(s.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ReportInputError('Port SSH tidak valid.');
  let schedule: { days: number[]; times: string[] };
  try {
    schedule = normalizeSchedule({ days: s.days, times: s.times });
  } catch (e) {
    throw new ReportInputError((e as Error).message);
  }
  const deliver = String(s.deliver ?? '').trim();
  if (!DELIVER.test(deliver)) throw new ReportInputError('Tujuan harus nomor bot (allowlist), whatsapp:62xxxx, atau whatsapp:<id grup>@g.us.');
  const projectIds = (Array.isArray(s.projectIds) ? s.projectIds : []).map(String).filter((id) => /^[\w-]{1,64}$/.test(id)).slice(0, 50);
  if (s.enabled && !host) throw new ReportInputError('Isi alamat VPS sebelum mengaktifkan laporan terjadwal.');
  return { ...s, enabled: Boolean(s.enabled), host, user, port, deliver, projectIds, ...schedule };
}

/** One Hermes job per WIB send time, with its cron on the server's clock. */
export function jobsFor(days: number[], times: string[], serverOffset: string): InstalledJob[] {
  try {
    return times.map((time) => ({ name: jobName(time), time, cron: cronFor(time, days, serverOffset) }));
  } catch (e) {
    throw new ReportInputError((e as Error).message);
  }
}

/** The WIB time on the server's clock, e.g. "17:00 (+0800)". */
export function serverClock(time: string, serverOffset: string): string {
  const t = toServerTime(time, serverOffset);
  return `${t.time}${t.dayShift > 0 ? ' (+1 hari)' : t.dayShift < 0 ? ' (−1 hari)' : ''}`;
}

export interface SshRunner {
  (settings: Pick<ReportSettings, 'host' | 'user' | 'port'>, script: string, stdin?: string): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** `bash -s` on the VPS with the script on stdin (and an optional payload after a marker line). */
export const runSsh: SshRunner = (s, script, stdin) =>
  new Promise((resolveRun) => {
    const child = execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', '-p', String(s.port), `${s.user}@${s.host}`, 'bash -s'],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolveRun({ stdout: String(stdout), stderr: String(stderr), code: err ? ((err as { code?: number }).code ?? 1) : 0 }),
    );
    child.stdin?.end(stdin === undefined ? script : `${script}\n${stdin}`);
  });

/** Remote shell prelude: strict mode, paths, hermes + node lookup. */
const PRELUDE = `set -euo pipefail
umask 077
D="$HOME/${REMOTE_DIR}"
mkdir -p "$D"
HERMES="$(command -v hermes || echo "$HOME/.local/bin/hermes")"
NODE="$(command -v node || ls -d "$HOME"/.hermes/tools/node-*/bin/node 2>/dev/null | tail -1)"`;

/**
 * Uploads a file through stdin. The commands sit in one `{ … }` block so bash has read all of
 * them before `cat` consumes the rest of stdin (the payload); `exit` keeps bash from running it.
 */
export function uploadScript(remotePath: string): string {
  if (!/^[\w./-]+$/.test(remotePath) || remotePath.includes('..')) throw new ReportInputError('Path remote tidak valid.');
  return `{
${PRELUDE}
F="$HOME/${remotePath}"
mkdir -p "$(dirname "$F")"
# Unique temp name: two Cockpits (desktop app + dev server) may upload at the same time.
TMP="$F.tmp.$$.$RANDOM"
cat > "$TMP"
mv -f "$TMP" "$F"
echo "uploaded $(wc -c < "$F") bytes"
exit 0
}`;
}

export function installScript(jobs: InstalledJob[], deliver: string, removeNames: string[] = []): string {
  if (!jobs.length) throw new ReportInputError('Tidak ada jam kirim.');
  for (const j of jobs) {
    if (!JOB.test(j.name) || !/^[\d*,]+ [\d*,]+ \* \* [\d*,]+$/.test(j.cron)) throw new ReportInputError('Cron tidak valid.');
  }
  if (removeNames.some((n) => !JOB.test(n))) throw new ReportInputError('Nama job tidak valid.');
  if (!DELIVER.test(deliver)) throw new ReportInputError('Tujuan tidak valid.');
  const target =
    deliver === 'allowlist'
      ? `NUM="$(grep -E '^WHATSAPP_ALLOWED_USERS=' "$HOME/.hermes/.env" | cut -d= -f2- | cut -d, -f1 | tr -dc '0-9')"
[ -n "$NUM" ] || { echo "WHATSAPP_ALLOWED_USERS kosong di ~/.hermes/.env" >&2; exit 3; }
TARGET="whatsapp:$NUM"`
      : `TARGET="${deliver}"`;
  // Remove every job this report ever had (old send times included), then create the current ones.
  const remove = [...new Set([JOB_NAME, ...removeNames, ...jobs.map((j) => j.name)])];
  return `${PRELUDE}
[ -x "$HERMES" ] || { echo "hermes tidak ditemukan di VPS" >&2; exit 3; }
[ -n "$NODE" ] || { echo "node tidak ditemukan di VPS" >&2; exit 3; }
[ -f "$D/tad-progress.mjs" ] || { echo "tad-progress.mjs belum terunggah" >&2; exit 3; }
mkdir -p "$HOME/.hermes/scripts"
cat > "$HOME/.hermes/scripts/${JOB_NAME}.sh" <<WRAPPER
#!/usr/bin/env bash
# Dibuat oleh Tech Lead Cockpit: laporan progres terjadwal (jangan diedit manual).
exec "$NODE" "\\$HOME/${REMOTE_DIR}/tad-progress.mjs" "\\$@"
WRAPPER
chmod 700 "$HOME/.hermes/scripts/${JOB_NAME}.sh"
${target}
for J in ${remove.join(' ')}; do "$HERMES" cron remove "$J" >/dev/null 2>&1 || true; done
${jobs.map((j) => `"$HERMES" cron create "${j.cron}" --no-agent --script ${JOB_NAME}.sh --deliver "$TARGET" --name ${j.name}`).join('\n')}
T="\${TARGET%%@*}"; echo "__TLC_TARGET__ \${T%%:*}:…\${T: -4}"
"$HERMES" cron list 2>&1 | grep -A3 -i ${JOB_NAME} || true`;
}

/**
 * Where the built reporter lives: next to the bundled connector in the desktop app
 * (Resources/connector/tad-progress.mjs), else dist-reporter/ in a dev checkout.
 */
function defaultBundlePath(): string {
  const candidates = [
    process.env.TLC_REPORTER_BUNDLE,
    process.argv[1] ? join(dirname(process.argv[1]), 'tad-progress.mjs') : undefined,
    resolve(process.cwd(), 'dist-reporter', 'tad-progress.mjs'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];
}

export class ReportVps {
  private readonly dir: string;
  private readonly ssh: SshRunner;
  private readonly bundlePath: string;

  constructor(ssh: SshRunner = runSsh, dir?: string, bundlePath = defaultBundlePath()) {
    this.ssh = ssh;
    this.dir = dir ?? join(DATA_DIR, 'report');
    this.bundlePath = bundlePath;
  }

  private file = (name: string) => join(this.dir, name);

  async settings(): Promise<ReportSettings> {
    try {
      return { ...DEFAULT_SETTINGS, ...migrateSettings(JSON.parse(await readFile(this.file('settings.json'), 'utf8'))) } as ReportSettings;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private async store(s: ReportSettings) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.file('settings.json'), JSON.stringify(s, null, 2), { mode: 0o600 });
    return s;
  }

  async saveSettings(raw: Partial<ReportSettings>): Promise<ReportSettings> {
    const current = await this.settings();
    const { lastSync, installed } = current;
    return this.store({ ...validateSettings(raw, current), lastSync, installed });
  }

  private async target(): Promise<ReportSettings> {
    const s = await this.settings();
    if (!s.host) throw new ReportInputError('Alamat VPS belum diatur.');
    return s;
  }

  private fail(what: string, r: { stdout: string; stderr: string; code: number }): never {
    const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ');
    if (/Permission denied|publickey/i.test(why)) throw new ReportInputError(`${what}: SSH ditolak. Pasang SSH key laptop ini ke VPS (ssh-copy-id).`);
    if (/timed out|Could not resolve|Connection refused|No route/i.test(why)) throw new ReportInputError(`${what}: VPS tidak bisa dihubungi (${why}).`);
    throw new ReportInputError(`${what} gagal: ${why || `exit ${r.code}`}`);
  }

  /** Saves the snapshot locally and uploads it as latest.json on the VPS. */
  async sync(snapshot: unknown): Promise<ReportSettings> {
    if (!isSnapshot(snapshot)) throw new ReportInputError('Snapshot tidak valid.');
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body) > MAX_SNAPSHOT_BYTES) throw new ReportInputError('Snapshot terlalu besar.');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFile(this.file('latest.json'), body, { mode: 0o600 });
    const s = await this.target();
    const r = await this.ssh(s, uploadScript(`${REMOTE_DIR}/latest.json`), body);
    const lastSync = { at: new Date().toISOString(), ok: r.code === 0, generatedAt: (snapshot as ProgressSnapshot).generatedAt, ...(r.code === 0 ? {} : { error: (r.stderr || r.stdout).trim().slice(-300) }) };
    await this.store({ ...(await this.settings()), lastSync });
    if (r.code !== 0) this.fail('Sinkron', r);
    return this.settings();
  }

  /** Uploads the reporter, writes the wrapper script and (re)creates the Hermes cron job. */
  async install(): Promise<{ settings: ReportSettings; output: string }> {
    const s = await this.target();
    if (!existsSync(this.bundlePath)) throw new ReportInputError('Bundle reporter belum ada. Jalankan `npm run build:reporter`.');
    const up = await this.ssh(s, uploadScript(`${REMOTE_DIR}/tad-progress.mjs`), await readFile(this.bundlePath, 'utf8'));
    if (up.code !== 0) this.fail('Unggah reporter', up);
    const tz = await this.ssh(s, 'date +%z');
    if (tz.code !== 0) this.fail('Membaca zona waktu VPS', tz);
    const serverOffset = tz.stdout.trim();
    const jobs = jobsFor(s.days, s.times, serverOffset);
    const r = await this.ssh(s, installScript(jobs, s.deliver, s.installed?.jobs.map((j) => j.name) ?? []));
    if (r.code !== 0) this.fail('Memasang cron', r);
    const deliver = r.stdout.match(/__TLC_TARGET__ (\S+)/)?.[1] ?? s.deliver;
    const settings = await this.store({ ...(await this.settings()), installed: { at: new Date().toISOString(), jobs, days: s.days, times: s.times, serverOffset, deliver, deliverSetting: s.deliver } });
    return { settings, output: r.stdout.replace(/__TLC_TARGET__.*\n?/, '').trim() };
  }

  /** Renders the report on the VPS without sending or changing its state. */
  async preview(): Promise<{ text: string; meta: Record<string, unknown> }> {
    const s = await this.target();
    const r = await this.ssh(s, `${PRELUDE}\n[ -f "$D/tad-progress.mjs" ] || { echo "Reporter belum terpasang di VPS" >&2; exit 3; }\nexec "$NODE" "$D/tad-progress.mjs" --preview --json`);
    if (r.code !== 0) this.fail('Pratinjau', r);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
    } catch {
      throw new ReportInputError('Output pratinjau tidak terbaca.');
    }
  }

  /** Runs the cron job now: Hermes renders and delivers it like the scheduled run. */
  async sendNow(): Promise<string> {
    const s = await this.target();
    const job = s.installed?.jobs[0]?.name ?? JOB_NAME;
    if (!JOB.test(job)) throw new ReportInputError('Nama job tidak valid.');
    const r = await this.ssh(s, `${PRELUDE}\n"$HERMES" cron run ${job} 2>&1 | tail -5`);
    if (r.code !== 0) this.fail('Kirim sekarang', r);
    return r.stdout.trim();
  }

  /** The job as Hermes lists it (next run, last status). */
  async status(): Promise<string> {
    const s = await this.target();
    const r = await this.ssh(s, `${PRELUDE}\n"$HERMES" cron list 2>&1 | grep -B1 -A6 -i ${JOB_NAME} || echo "Laporan terjadwal belum terpasang."`);
    if (r.code !== 0) this.fail('Status', r);
    return r.stdout.trim();
  }
}
