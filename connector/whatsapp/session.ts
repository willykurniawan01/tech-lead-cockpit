import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from 'baileys';
import QRCode from 'qrcode';
import type { WaStatus, WaAttachmentInput } from '../../src/lib/whatsapp/types.ts';
import { WaStore, type RawMessage } from './store.ts';
import { DATA_DIR } from '../paths.ts';

/**
 * WhatsApp linked-device session (same protocol as WhatsApp Web, paired by QR).
 * Unofficial: WhatsApp may restrict numbers that behave like bots, so this module never
 * sends on its own — every send comes from an explicit user action and is rate limited.
 */

export const WA_AUTH_DIR = join(DATA_DIR, 'whatsapp-auth');
/** Held by the process that owns the socket, so the dev server and the desktop app never share one session. */
export const WA_LOCK_FILE = join(DATA_DIR, 'whatsapp.lock');

const MIN_SEND_GAP_MS = 3_000;
const MAX_SENDS_PER_MINUTE = 15;
const MAX_TEXT_LENGTH = 4_096;

type Socket = ReturnType<typeof makeWASocket>;

const silentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class WaSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

class WhatsAppSession {
  readonly store = new WaStore();
  private sock: Socket | null = null;
  private status: WaStatus = { connection: 'idle', hasSession: false };
  private reconnectDelay = 2_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private sendLog: number[] = [];

  async getStatus(): Promise<WaStatus> {
    return { ...this.status, hasSession: await hasSavedSession() };
  }

  /** Starts (or resumes) the session. Without saved credentials this produces a QR to scan. */
  async connect() {
    if (this.sock && ['connecting', 'qr', 'open', 'reconnecting'].includes(this.status.connection)) return;
    this.stopped = false;
    await this.open();
  }

  /** Unlinks this device from the phone and deletes the local credentials. */
  async logout() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    try {
      await this.sock?.logout();
    } catch {
      // Already disconnected: removing local credentials is enough.
    }
    this.sock = null;
    await rm(WA_AUTH_DIR, { recursive: true, force: true });
    releaseWaLock();
    this.store.clear();
    this.status = { connection: 'logged-out', hasSession: false };
  }

  async send(jid: string, text: string, attachment?: WaAttachmentInput) {
    if (this.status.connection !== 'open' || !this.sock) throw new WaSendError('WhatsApp belum terhubung.', 409);
    const body = text.trim();
    if (!body && !attachment) throw new WaSendError('Pesan atau lampiran kosong.', 400);
    if (body.length > MAX_TEXT_LENGTH) throw new WaSendError(`Pesan melebihi ${MAX_TEXT_LENGTH} karakter.`, 400);

    const now = Date.now();
    this.sendLog = this.sendLog.filter((t) => now - t < 60_000);
    const last = this.sendLog.at(-1);
    if (last && now - last < MIN_SEND_GAP_MS) throw new WaSendError('Terlalu cepat. Tunggu beberapa detik sebelum mengirim lagi.', 429);
    if (this.sendLog.length >= MAX_SENDS_PER_MINUTE) throw new WaSendError('Batas kirim per menit tercapai. Coba lagi sebentar lagi.', 429);
    this.sendLog.push(now);

    let sent: any;
    if (attachment) {
      const buffer = Buffer.from(attachment.data, 'base64');
      const mime = attachment.mimetype || 'application/octet-stream';
      if (mime.startsWith('image/')) {
        sent = await this.sock.sendMessage(jid, {
          image: buffer,
          caption: body || undefined,
          mimetype: mime,
        });
      } else if (mime.startsWith('video/')) {
        sent = await this.sock.sendMessage(jid, {
          video: buffer,
          caption: body || undefined,
          mimetype: mime,
        });
      } else if (mime.startsWith('audio/')) {
        sent = await this.sock.sendMessage(jid, {
          audio: buffer,
          mimetype: mime,
        });
      } else {
        sent = await this.sock.sendMessage(jid, {
          document: buffer,
          fileName: attachment.filename || 'Dokumen',
          mimetype: mime,
          caption: body || undefined,
        });
      }
    } else {
      sent = await this.sock.sendMessage(jid, { text: body });
    }

    if (sent) this.store.addMessage(sent as RawMessage, { countUnread: false });
    if (!this.store.hasChat(jid)) {
      this.store.upsertChat(jid, { timestamp: Math.floor(now / 1000) });
    }
  }

  private async open() {
    clearTimeout(this.reconnectTimer);
    const holder = await acquireWaLock();
    if (holder) {
      this.stopped = true;
      this.status = {
        connection: 'idle',
        hasSession: await hasSavedSession(),
        error: `WhatsApp sedang dipakai Cockpit lain (proses ${holder}: dev server atau aplikasi desktop). Tutup salah satunya dulu, lalu klik Hubungkan.`,
      };
      return;
    }
    await mkdir(WA_AUTH_DIR, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
    if (this.status.connection !== 'reconnecting') this.status = { connection: 'connecting', hasSession: true };

    const sock = makeWASocket({
      auth: state,
      logger: silentLogger,
      browser: Browsers.macOS('Tech Lead Cockpit'),
      // Stay "offline" so the phone keeps getting notifications and read receipts aren't implied.
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (sock !== this.sock) return;
      if (u.qr) {
        this.status = { connection: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }), hasSession: false };
      }
      if (u.connection === 'open') {
        this.reconnectDelay = 2_000;
        const me = sock.user;
        this.status = { connection: 'open', me: me ? { id: me.id, name: me.name ?? me.notify ?? '' } : undefined, hasSession: true };
      }
      if (u.connection === 'close') this.onClose(u.lastDisconnect?.error);
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      for (const c of contacts) this.store.setName(c.id, c.name ?? c.notify ?? c.verifiedName, Boolean(c.name || c.verifiedName));
      for (const c of chats) if (c.id) this.store.upsertChat(c.id, { name: c.name, unread: c.unreadCount, timestamp: Number(c.conversationTimestamp ?? 0) });
      for (const m of messages) this.store.addMessage(m as RawMessage, { countUnread: false });
    });
    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) if (c.id) this.store.upsertChat(c.id, { name: c.name, unread: c.unreadCount, timestamp: Number(c.conversationTimestamp ?? 0) });
    });
    sock.ev.on('chats.update', (updates) => {
      for (const c of updates) if (c.id) this.store.upsertChat(c.id, { name: c.name, unread: c.unreadCount });
    });
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) this.store.setName(c.id, c.name ?? c.notify ?? c.verifiedName, Boolean(c.name || c.verifiedName));
    });
    sock.ev.on('contacts.update', (contacts) => {
      for (const c of contacts) if (c.id) this.store.setName(c.id, c.name ?? c.notify ?? c.verifiedName, Boolean(c.name || c.verifiedName));
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) this.store.addMessage(m as RawMessage, { countUnread: type === 'notify' });
    });
  }

  private onClose(error: unknown) {
    const code = (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    const wasPairing = this.status.connection === 'qr';
    this.sock = null;

    if (code === DisconnectReason.loggedOut) {
      void rm(WA_AUTH_DIR, { recursive: true, force: true });
      this.store.clear();
      this.status = { connection: 'logged-out', hasSession: false, error: 'Perangkat ini di-logout dari HP. Scan QR lagi untuk menghubungkan.' };
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      this.status = { connection: 'idle', hasSession: true, error: 'Sesi diambil alih oleh koneksi lain dengan perangkat yang sama.' };
      return;
    }
    if (wasPairing && code !== DisconnectReason.restartRequired) {
      // Nobody scanned the QR in time; don't keep generating codes in the background.
      this.status = { connection: 'idle', hasSession: false, error: 'QR kedaluwarsa. Klik Hubungkan untuk membuat QR baru.' };
      return;
    }
    if (this.stopped) {
      this.status = { connection: 'idle', hasSession: true };
      return;
    }
    // 515 right after pairing and transient network drops: reconnect with backoff.
    this.status = { connection: 'reconnecting', hasSession: true, error: code === DisconnectReason.restartRequired ? undefined : 'Koneksi terputus, menyambung ulang…' };
    const delay = code === DisconnectReason.restartRequired ? 0 : this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
    this.reconnectTimer = setTimeout(() => void this.open().catch(() => this.onClose(undefined)), delay);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the WhatsApp lock for this process. Returns the PID of another live holder, or null when acquired. */
export async function acquireWaLock(): Promise<number | null> {
  await mkdir(join(DATA_DIR), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(WA_LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const pid = Number((await readFile(WA_LOCK_FILE, 'utf8').catch(() => '')).trim());
    if (pid === process.pid) return null;
    if (pid > 0 && isAlive(pid)) return pid;
    // Left behind by a crashed process.
    await rm(WA_LOCK_FILE, { force: true });
  }
  return null;
}

export function releaseWaLock() {
  try {
    if (Number(readFileSync(WA_LOCK_FILE, 'utf8').trim()) === process.pid) unlinkSync(WA_LOCK_FILE);
  } catch {
    // No lock, or not ours.
  }
}

process.once('exit', releaseWaLock);

async function hasSavedSession(): Promise<boolean> {
  try {
    await stat(join(WA_AUTH_DIR, 'creds.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * One session per process. Vite re-imports this module when connector files change; reusing
 * the instance from globalThis prevents a second socket that would kick the first one off.
 */
const g = globalThis as typeof globalThis & { __tlcWhatsApp?: WhatsAppSession };
export function whatsapp(): WhatsAppSession {
  g.__tlcWhatsApp ??= new WhatsAppSession();
  return g.__tlcWhatsApp;
}

/** Resume a previously linked session when the connector starts, without prompting for a QR. */
export async function resumeWhatsAppIfLinked() {
  if (await hasSavedSession()) await whatsapp().connect();
}
