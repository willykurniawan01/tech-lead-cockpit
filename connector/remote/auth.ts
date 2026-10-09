import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteDevice } from '../../src/lib/remote/types.ts';

/**
 * Who may talk to the Remote listener.
 *
 * - Pairing: the laptop shows a one-time code (QR + typed), valid 2 minutes, only while Remote
 *   is on. The phone trades it for a device id + device secret, which only the phone keeps; the
 *   laptop stores the secret's SHA-256.
 * - Sessions: per activation the connector draws a random key. A phone proves its device secret
 *   and gets a session token = HMAC(activation key, device id, nonce, secret), valid 15 minutes
 *   and never past the activation. Turning Remote off drops the key and every token with it.
 * - Failures (bad codes, bad secrets) are counted per activation; too many and Remote shuts down.
 */

export const PAIR_CODE_TTL_MS = 2 * 60_000;
export const SESSION_TTL_MS = 15 * 60_000;
export const MAX_DEVICES = 5;
const MAX_PAIR_FAILURES = 5;
export const MAX_AUTH_FAILURES = 10;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export class RemoteAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'bad-code' | 'expired' | 'unauthorized' | 'revoked' | 'inactive' | 'limit',
  ) {
    super(message);
  }
}

interface StoredDevice {
  id: string;
  name: string;
  secretHash: string;
  pairedAt: string;
  lastSeenAt?: string;
}

interface Session {
  deviceId: string;
  expiresAt: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Uppercase, no separators: what the user may type as "abcd-efgh". */
export function normalizeCode(input: unknown): string {
  return typeof input === 'string' ? input.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export function sanitizeDeviceName(input: unknown): string {
  const name = typeof input === 'string' ? input.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) : '';
  return name || 'Perangkat';
}

export class RemoteAuth {
  private activationKey: Buffer | null = null;
  private activeUntil = 0;
  private pending: { hash: string; expiresAt: number } | null = null;
  private sessions = new Map<string, Session>();
  private pairFailures = 0;
  private authFailures = 0;
  private devices: StoredDevice[] | null = null;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
    /** Called once failures pass the limit; the manager turns Remote off. */
    private readonly onTooManyFailures: () => void = () => {},
  ) {}

  get active(): boolean {
    return this.activationKey !== null;
  }

  /** New activation: fresh key, no codes, no sessions. */
  begin(activeUntil: number) {
    this.end();
    this.activationKey = randomBytes(32);
    this.activeUntil = activeUntil;
  }

  /** Remote off: every code and session token stops working. */
  end() {
    this.activationKey?.fill(0);
    this.activationKey = null;
    this.activeUntil = 0;
    this.pending = null;
    this.sessions.clear();
    this.pairFailures = 0;
    this.authFailures = 0;
  }

  private file = () => join(this.dir, 'devices.json');

  private async load(): Promise<StoredDevice[]> {
    if (this.devices) return this.devices;
    try {
      const raw = JSON.parse(await readFile(this.file(), 'utf8'));
      this.devices = Array.isArray(raw) ? raw.filter((d) => d && typeof d.id === 'string' && typeof d.secretHash === 'string') : [];
    } catch {
      this.devices = [];
    }
    return this.devices;
  }

  private async save() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file()}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.devices ?? [], null, 2), { mode: 0o600 });
    await rename(tmp, this.file());
  }

  private fail(kind: 'pair' | 'auth') {
    if (kind === 'pair' && ++this.pairFailures >= MAX_PAIR_FAILURES) this.pending = null;
    if (++this.authFailures >= MAX_AUTH_FAILURES) this.onTooManyFailures();
  }

  private requireActive() {
    if (!this.activationKey) throw new RemoteAuthError('Remote Cockpit sedang nonaktif.', 503, 'inactive');
  }

  /** A new one-time code; any earlier code stops working. */
  createPairCode(): { code: string; expiresAt: number } {
    this.requireActive();
    const bytes = randomBytes(8);
    const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    const expiresAt = Math.min(this.now() + PAIR_CODE_TTL_MS, this.activeUntil);
    this.pending = { hash: sha256(code), expiresAt };
    this.pairFailures = 0;
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  async pair(codeInput: unknown, nameInput: unknown): Promise<{ device: StoredDevice; secret: string }> {
    this.requireActive();
    const code = normalizeCode(codeInput);
    const pending = this.pending;
    if (!pending || code.length !== 8 || !sameHex(sha256(code), pending.hash)) {
      this.fail('pair');
      throw new RemoteAuthError('Kode pairing salah atau sudah dipakai. Buat kode baru di laptop.', 401, 'bad-code');
    }
    // Single use, right away, whatever happens next.
    this.pending = null;
    if (this.now() > pending.expiresAt) throw new RemoteAuthError('Kode pairing kedaluwarsa. Buat kode baru di laptop.', 401, 'expired');
    const devices = await this.load();
    if (devices.length >= MAX_DEVICES) throw new RemoteAuthError(`Maksimal ${MAX_DEVICES} perangkat. Cabut perangkat lama di laptop dulu.`, 409, 'limit');
    const secret = b64url(randomBytes(32));
    const device: StoredDevice = { id: randomUUID(), name: sanitizeDeviceName(nameInput), secretHash: sha256(secret), pairedAt: new Date(this.now()).toISOString() };
    devices.push(device);
    await this.save();
    return { device, secret };
  }

  /** Trades the device secret for a session token. `isNew` = the device had no live session. */
  async createSession(deviceId: unknown, secret: unknown): Promise<{ token: string; expiresAt: number; device: StoredDevice; isNew: boolean }> {
    this.requireActive();
    const devices = await this.load();
    const device = typeof deviceId === 'string' ? devices.find((d) => d.id === deviceId) : undefined;
    if (!device) {
      this.fail('auth');
      throw new RemoteAuthError('Perangkat tidak dikenal atau sudah dicabut. Pasangkan ulang.', 401, 'revoked');
    }
    if (typeof secret !== 'string' || !sameHex(sha256(secret), device.secretHash)) {
      this.fail('auth');
      throw new RemoteAuthError('Kredensial perangkat salah.', 401, 'unauthorized');
    }
    this.prune();
    const isNew = ![...this.sessions.values()].some((s) => s.deviceId === device.id);
    const nonce = b64url(randomBytes(16));
    const token = b64url(createHmac('sha256', this.activationKey!).update(`${device.id}.${nonce}.${secret}`).digest());
    const expiresAt = Math.min(this.now() + SESSION_TTL_MS, this.activeUntil);
    this.sessions.set(sha256(token), { deviceId: device.id, expiresAt });
    device.lastSeenAt = new Date(this.now()).toISOString();
    await this.save();
    return { token, expiresAt, device, isNew };
  }

  /** The device behind a bearer token, or null (expired, revoked, Remote off). */
  async authenticate(token: unknown): Promise<StoredDevice | null> {
    if (!this.activationKey || typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const session = this.sessions.get(sha256(token));
    if (!session) return null;
    if (this.now() >= session.expiresAt) {
      this.sessions.delete(sha256(token));
      return null;
    }
    const device = (await this.load()).find((d) => d.id === session.deviceId);
    return device ?? null;
  }

  private prune() {
    const now = this.now();
    for (const [k, s] of this.sessions) if (now >= s.expiresAt) this.sessions.delete(k);
  }

  async listDevices(): Promise<RemoteDevice[]> {
    this.prune();
    const live = new Set([...this.sessions.values()].map((s) => s.deviceId));
    return (await this.load()).map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt, connected: live.has(d.id) }));
  }

  /** Removes the device and kills its sessions immediately. */
  async revoke(deviceId: string): Promise<StoredDevice | undefined> {
    const devices = await this.load();
    const device = devices.find((d) => d.id === deviceId);
    if (!device) return undefined;
    this.devices = devices.filter((d) => d.id !== deviceId);
    for (const [k, s] of this.sessions) if (s.deviceId === deviceId) this.sessions.delete(k);
    await this.save();
    return device;
  }
}
