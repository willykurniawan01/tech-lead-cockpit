import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { QAEnvironment } from '../../src/lib/qa/types.ts';
import { storableEnvironment } from './store.ts';

/**
 * Environments to and from a file, between laptops and between Tech Lead Cockpit and QA Cockpit.
 * Configuration is plain JSON; Keychain secrets (token, secret variables, database passwords)
 * travel only encrypted with a passphrase the user types (scrypt + AES-256-GCM), and land in the
 * Keychain again on import. Pure apart from crypto, so tests run without a Keychain.
 */

export const ENV_FILE_FORMAT = 'cockpit-environments';

export class EnvTransferError extends Error {}

/** One environment's Keychain values. */
export interface EnvSecrets {
  token?: string;
  variables?: Record<string, string>;
  dbServer?: string;
  databases?: Record<string, string>;
}

export interface EnvExportFile {
  format: typeof ENV_FILE_FORMAT;
  version: 1;
  exportedAt: string;
  exportedBy?: string;
  environments: QAEnvironment[];
  /** EnvSecrets per environment id, encrypted; absent when exported without secrets. */
  secrets?: { kdf: 'scrypt'; salt: string; iv: string; tag: string; data: string };
}

const KEY_LEN = 32;
const MIN_PASSPHRASE = 8;
const MAX_ENVS = 100;

function key(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encryptSecrets(secrets: Record<string, EnvSecrets>, passphrase: string): NonNullable<EnvExportFile['secrets']> {
  if (passphrase.length < MIN_PASSPHRASE) throw new EnvTransferError(`Passphrase minimal ${MIN_PASSPHRASE} karakter.`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  return { kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptSecrets(blob: NonNullable<EnvExportFile['secrets']>, passphrase: string): Record<string, EnvSecrets> {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(passphrase, Buffer.from(blob.salt, 'base64')), Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const text = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
    return parsed as Record<string, EnvSecrets>;
  } catch {
    throw new EnvTransferError('Passphrase salah atau file rusak: rahasia tidak bisa dibuka.');
  }
}

export function buildExport(environments: QAEnvironment[], secrets: Record<string, EnvSecrets> | undefined, passphrase: string | undefined, by?: string): EnvExportFile {
  return {
    format: ENV_FILE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    ...(by ? { exportedBy: by } : {}),
    environments: environments.map((e) => {
      const { updatedAt: _t, ...rest } = storableEnvironment(e);
      return rest as QAEnvironment;
    }),
    ...(secrets && passphrase !== undefined ? { secrets: encryptSecrets(secrets, passphrase) } : {}),
  };
}

/** The file's environments (not validated yet: the manager does that per environment). */
export function readExport(raw: unknown): EnvExportFile {
  const f = (raw ?? {}) as Partial<EnvExportFile>;
  if (f.format !== ENV_FILE_FORMAT || f.version !== 1 || !Array.isArray(f.environments)) throw new EnvTransferError('Bukan file environment Cockpit (format tidak dikenal).');
  if (f.environments.length > MAX_ENVS) throw new EnvTransferError(`Maksimal ${MAX_ENVS} environment per file.`);
  const s = f.secrets;
  if (s && !(s.kdf === 'scrypt' && [s.salt, s.iv, s.tag, s.data].every((x) => typeof x === 'string'))) throw new EnvTransferError('Bagian rahasia di file tidak valid.');
  return f as EnvExportFile;
}

/** Names of what an environment's secrets hold, for the preview ("token", "variabel rahasia apiKey", …). */
export function describeSecrets(s: EnvSecrets | undefined): string[] {
  if (!s) return [];
  return [
    ...(s.token ? ['token auth'] : []),
    ...Object.keys(s.variables ?? {}).map((k) => `variabel rahasia ${k}`),
    ...(s.dbServer ? ['password server DB'] : []),
    ...Object.keys(s.databases ?? {}).map((k) => `password DB ${k}`),
  ];
}
