import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '../../src/lib/confluence/api-types.ts';
import { REMOTE_MAX_HOURS, type RemoteDuration, type RemotePairing, type RemoteReportTarget, type RemoteSettings, type RemoteStatus } from '../../src/lib/remote/types.ts';
import { RemoteAuth } from './auth.ts';
import { handleRemoteRequest, type MobileData } from './server.ts';
import { detectTailscale, isLoopback, isTailscaleIPv4, tailscaleCert, type TailscaleInfo, type TlsMaterial } from './tailscale.ts';
import { DATA_DIR } from '../paths.ts';

/**
 * Remote Access: off by default and never persisted as on. Turning it on (from the laptop UI,
 * after PIN/Touch ID) opens a second listener bound to this Mac's Tailscale address only; that
 * listener serves the mobile PWA and the whitelisted mobile API and nothing else (server.ts).
 * It closes when the chosen duration ends, when switched off from the laptop or the phone, and
 * when the connector stops; closing also revokes every session token and pairing code.
 */

export const REMOTE_DIR = join(DATA_DIR, 'remote');
export const DEFAULT_REMOTE_PORT = 5175;
const MIN_UNTIL_MS = 5 * 60_000;
const DRAFT_TTL_MS = 10 * 60_000;

export class RemoteInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface RemoteDeps {
  dir: string;
  port: number;
  appendAudit: (event: AuditEvent) => Promise<void>;
  data: MobileData;
  detect: () => Promise<TailscaleInfo>;
  /** HTTPS material for the MagicDNS name; throwing means plain HTTP on the Tailscale IP. */
  tls: (info: TailscaleInfo, dir: string) => Promise<TlsMaterial>;
  notify: (title: string, body: string) => void;
  now: () => number;
  /** Timer seam; returns a cancel function. */
  schedule: (fn: () => void, ms: number) => () => void;
  /** Tests and local PWA checks only: lets the listener bind to 127.0.0.1. */
  allowLoopback?: boolean;
  log: (message: string) => void;
}

interface Active {
  server: http.Server;
  startedAt: number;
  expiresAt: number;
  info: TailscaleInfo;
  baseUrl: string;
  https: boolean;
  httpsIssue?: string;
  cancelTimer: () => void;
}

export interface ReportDraftEntry {
  id: string;
  projectId: string;
  projectName: string;
  text: string;
  target?: RemoteReportTarget;
  deviceId: string;
  expiresAt: number;
}

/** macOS banner from the connector; arguments go through argv, never into the script text. */
export function macNotify(title: string, body: string) {
  if (process.platform !== 'darwin' || process.env.VITEST) return;
  execFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], { timeout: 5_000 }, () => {});
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  // setTimeout caps at ~24.8 days; activations are at most a day, but chunk anyway.
  let timer: NodeJS.Timeout;
  const due = Date.now() + ms;
  const arm = () => {
    timer = setTimeout(() => (Date.now() >= due ? fn() : arm()), Math.min(Math.max(0, due - Date.now()), 2 ** 31 - 1));
    timer.unref?.();
  };
  arm();
  return () => clearTimeout(timer);
}

export function resolveExpiry(duration: RemoteDuration | undefined, now: number): number {
  if (!duration || typeof duration !== 'object') throw new RemoteInputError('Pilih durasi Remote (2 jam, 8 jam, atau sampai jam tertentu).');
  if (duration.kind === '2h') return now + 2 * 3_600_000;
  if (duration.kind === '8h') return now + 8 * 3_600_000;
  if (duration.kind === 'until') {
    const until = Date.parse(String(duration.until ?? ''));
    if (Number.isNaN(until)) throw new RemoteInputError('Jam selesai tidak valid.');
    if (until < now + MIN_UNTIL_MS) throw new RemoteInputError('Jam selesai minimal 5 menit dari sekarang.');
    if (until > now + REMOTE_MAX_HOURS * 3_600_000) throw new RemoteInputError(`Remote paling lama ${REMOTE_MAX_HOURS} jam sekali aktif.`);
    return until;
  }
  throw new RemoteInputError('Durasi tidak dikenal. Tidak ada pilihan "selamanya".');
}

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }).replace('.', ':');

export class RemoteAccess {
  readonly auth: RemoteAuth;
  private active: Active | null = null;
  private starting = false;
  private connectionSeq = 0;
  private lastConnection?: { deviceName: string; at: string };
  private lastStop?: { reason: string; at: string };
  private drafts = new Map<string, ReportDraftEntry>();

  constructor(readonly deps: RemoteDeps) {
    this.auth = new RemoteAuth(deps.dir, deps.now, () => void this.disable('too-many-failures'));
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  get expiresAt(): number | undefined {
    return this.active?.expiresAt;
  }

  async status(): Promise<RemoteStatus> {
    this.checkExpiry();
    const a = this.active;
    return {
      active: Boolean(a),
      ...(a
        ? {
            startedAt: new Date(a.startedAt).toISOString(),
            expiresAt: new Date(a.expiresAt).toISOString(),
            baseUrl: a.baseUrl,
            address: a.info.ip,
            port: this.deps.port,
            https: a.https,
            httpsIssue: a.httpsIssue,
          }
        : {}),
      devices: await this.auth.listDevices(),
      connectionSeq: this.connectionSeq,
      lastConnection: this.lastConnection,
      lastStop: this.lastStop,
    };
  }

  audit(action: AuditEvent['action'], title: string, extra: Partial<AuditEvent> = {}) {
    return this.deps.appendAudit({ ts: new Date(this.deps.now()).toISOString(), action, result: 'success', spaceKey: 'remote', title, attachments: 0, ...extra }).catch((e) => this.deps.log(`[remote] audit: ${(e as Error).message}`));
  }

  async enable(duration: RemoteDuration | undefined): Promise<RemoteStatus> {
    if (this.active || this.starting) throw new RemoteInputError('Remote sudah aktif. Matikan dulu untuk mengganti durasi.', 409);
    const now = this.deps.now();
    const expiresAt = resolveExpiry(duration, now);
    this.starting = true;
    try {
      let info: TailscaleInfo;
      try {
        info = await this.deps.detect();
      } catch (e) {
        await this.audit('remote.enable', 'Remote gagal diaktifkan', { result: 'failure', error: (e as Error).message });
        throw new RemoteInputError((e as Error).message, 412);
      }
      if (!isTailscaleIPv4(info.ip) && !(this.deps.allowLoopback && isLoopback(info.ip))) {
        throw new RemoteInputError(`Alamat ${info.ip} bukan alamat Tailscale (100.64.0.0/10); Remote menolak bind ke alamat lain.`, 412);
      }

      let tls: TlsMaterial | undefined;
      let httpsIssue: string | undefined;
      try {
        tls = await this.deps.tls(info, join(this.deps.dir, 'tls'));
      } catch (e) {
        httpsIssue = (e as Error).message;
      }
      const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void handleRemoteRequest(req, res, this);
      const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler);
      server.headersTimeout = 15_000;
      server.requestTimeout = 30_000;
      await new Promise<void>((resolve, reject) => {
        const onError = (e: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          reject(new RemoteInputError(e.code === 'EADDRINUSE' ? `Port ${this.deps.port} di ${info.ip} sudah dipakai proses lain.` : `Listener Remote gagal dibuka: ${e.message}`, 409));
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.deps.port, info.ip);
      });
      server.on('error', (e) => this.deps.log(`[remote] ${e.message}`));

      const host = tls && info.dnsName ? info.dnsName : info.ip;
      const baseUrl = `${tls ? 'https' : 'http'}://${host}:${this.deps.port}`;
      this.auth.begin(expiresAt);
      this.active = {
        server,
        startedAt: now,
        expiresAt,
        info,
        baseUrl,
        https: Boolean(tls),
        httpsIssue,
        cancelTimer: this.deps.schedule(() => void this.disable('expired'), expiresAt - now),
      };
      await this.audit('remote.enable', `Remote aktif sampai ${fmtTime(expiresAt)} di ${baseUrl}`);
      return this.status();
    } finally {
      this.starting = false;
    }
  }

  /** Closes the listener and drops every token. Safe to call when already off. */
  async disable(reason: string, actor?: string): Promise<RemoteStatus> {
    const a = this.active;
    if (!a) return this.status();
    this.active = null;
    a.cancelTimer();
    this.auth.end();
    this.drafts.clear();
    this.lastStop = { reason, at: new Date(this.deps.now()).toISOString() };
    await new Promise<void>((resolve) => {
      a.server.close(() => resolve());
      a.server.closeAllConnections();
    });
    await this.audit('remote.disable', `Remote dimatikan (${reason})`, actor ? { actor } : {});
    if (reason === 'expired' || reason === 'too-many-failures') {
      this.deps.notify('Remote Cockpit nonaktif', reason === 'expired' ? 'Durasi Remote habis; listener ditutup.' : 'Terlalu banyak percobaan gagal; Remote dimatikan.');
    }
    return this.status();
  }

  /** Called on every remote request too, so an expired activation never serves one more. */
  checkExpiry() {
    if (this.active && this.deps.now() >= this.active.expiresAt) void this.disable('expired');
  }

  async pairStart(): Promise<RemotePairing> {
    if (!this.active) throw new RemoteInputError('Aktifkan Remote dulu sebelum memasangkan perangkat.', 409);
    const { code, expiresAt } = this.auth.createPairCode();
    await this.audit('remote.pair', 'Kode pairing dibuat');
    return { code, expiresAt: new Date(expiresAt).toISOString(), url: `${this.active.baseUrl}/m/#pair=${code}` };
  }

  async revoke(deviceId: string): Promise<RemoteStatus> {
    const device = await this.auth.revoke(deviceId);
    if (!device) throw new RemoteInputError('Perangkat tidak ditemukan.', 404);
    await this.audit('remote.revoke', `Perangkat dicabut: ${device.name}`);
    return this.status();
  }

  /** A phone opened a session: count it, banner on the laptop, audit. */
  noteConnection(deviceName: string, isNew: boolean) {
    if (!isNew) return;
    this.connectionSeq++;
    this.lastConnection = { deviceName, at: new Date(this.deps.now()).toISOString() };
    this.deps.notify('Remote Cockpit', `${deviceName} tersambung ke Cockpit.`);
    void this.audit('remote.connect', `Perangkat tersambung: ${deviceName}`, { actor: `remote:${deviceName}` });
  }

  private settingsFile = () => join(this.deps.dir, 'settings.json');

  async settings(): Promise<RemoteSettings> {
    try {
      const raw = JSON.parse(await readFile(this.settingsFile(), 'utf8')) as Partial<RemoteSettings>;
      return { reportTargets: raw.reportTargets && typeof raw.reportTargets === 'object' ? raw.reportTargets : {} };
    } catch {
      return { reportTargets: {} };
    }
  }

  /** Laptop only: which WhatsApp group each project's report goes to. */
  async saveSettings(raw: unknown): Promise<RemoteSettings> {
    const input = (raw ?? {}) as Partial<RemoteSettings>;
    const reportTargets: Record<string, RemoteReportTarget> = {};
    for (const [projectId, t] of Object.entries(input.reportTargets ?? {})) {
      if (!/^[\w-]{1,64}$/.test(projectId) || !t) continue;
      const jid = String((t as RemoteReportTarget).jid ?? '');
      if (!/^[0-9-]{5,40}@g\.us$/.test(jid)) throw new RemoteInputError('Tujuan laporan harus grup WhatsApp (…@g.us).');
      reportTargets[projectId] = { jid, name: String((t as RemoteReportTarget).name ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || jid };
    }
    await mkdir(this.deps.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.settingsFile()}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify({ reportTargets }, null, 2), { mode: 0o600 });
    await rename(tmp, this.settingsFile());
    return { reportTargets };
  }

  saveDraft(entry: Omit<ReportDraftEntry, 'id' | 'expiresAt'>): ReportDraftEntry {
    const now = this.deps.now();
    for (const [k, d] of this.drafts) if (now >= d.expiresAt) this.drafts.delete(k);
    const draft = { ...entry, id: randomUUID(), expiresAt: Math.min(now + DRAFT_TTL_MS, this.active?.expiresAt ?? now) };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  /** One use: a draft is sent at most once, by the device that made it. */
  takeDraft(id: unknown, deviceId: string): ReportDraftEntry | undefined {
    if (typeof id !== 'string') return undefined;
    const d = this.drafts.get(id);
    if (!d || d.deviceId !== deviceId) return undefined;
    this.drafts.delete(id);
    return this.deps.now() < d.expiresAt ? d : undefined;
  }

  /** Host header values the listener answers to (DNS rebinding guard). */
  allowedHosts(): Set<string> {
    const a = this.active;
    if (!a) return new Set();
    const port = this.deps.port;
    const names = [a.info.ip, ...(a.info.dnsName ? [a.info.dnsName] : []), ...(isLoopback(a.info.ip) ? ['localhost'] : [])];
    return new Set(names.flatMap((n) => [n.toLowerCase(), `${n.toLowerCase()}:${port}`]));
  }
}

let current: RemoteAccess | null = null;
const REGISTRY = Symbol.for('tlc.remote-access');

/**
 * Process-wide instance. A previous instance (Vite re-loading the connector on restart) is shut
 * down first, so a restart never leaves an old listener open.
 */
export function remoteAccess(overrides: Partial<RemoteDeps> & Pick<RemoteDeps, 'appendAudit' | 'data'>): RemoteAccess {
  if (current) return current;
  const g = globalThis as unknown as Record<symbol, RemoteAccess | undefined>;
  void g[REGISTRY]?.disable('connector-restart');
  const loopback = process.env.TLC_REMOTE_LOOPBACK === '1';
  current = new RemoteAccess({
    dir: REMOTE_DIR,
    port: Number(process.env.TLC_REMOTE_PORT) || DEFAULT_REMOTE_PORT,
    detect: loopback ? async () => ({ ip: '127.0.0.1' }) : detectTailscale,
    tls: loopback ? async () => Promise.reject(new Error('Mode uji loopback: HTTP saja.')) : tailscaleCert,
    notify: macNotify,
    now: Date.now,
    schedule: defaultSchedule,
    allowLoopback: loopback,
    log: (m) => console.error(m),
    ...overrides,
  });
  g[REGISTRY] = current;
  return current;
}

/** For the connector's shutdown paths (server close, Vite restart). */
export function shutdownRemote(reason = 'connector-stop') {
  return current?.disable(reason);
}
