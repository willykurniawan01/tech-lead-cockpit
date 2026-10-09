import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Antigravity CLI only reads files outside the active workspace when a read_file() rule allows
 * it, and those rules live in the user's global settings. The app adds them only when the user
 * clicks "Izinkan" — together with a write_file() deny so the agent can never edit the codebase.
 * See antigravity.google/docs/permissions.
 */

export const AGY_SETTINGS = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');

interface AgySettings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  [key: string]: unknown;
}

export function agyRules(root: string) {
  return { allow: `read_file(${root})`, deny: `write_file(${root})` };
}

async function readSettings(file: string): Promise<AgySettings> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as AgySettings;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Tidak bisa membaca ${file}: ${(e as Error).message}. Perbaiki file tersebut secara manual.`);
  }
}

export async function agyReadAccess(root: string, file = AGY_SETTINGS): Promise<{ granted: boolean; settingsFile: string }> {
  const s = await readSettings(file).catch(() => ({}) as AgySettings);
  const { allow, deny } = agyRules(root);
  return { granted: Boolean(s.permissions?.allow?.includes(allow) && s.permissions?.deny?.includes(deny)), settingsFile: file };
}

/** Adds the read-allow and write-deny rules, keeping every other setting untouched. */
export async function grantAgyReadAccess(root: string, file = AGY_SETTINGS): Promise<void> {
  const s = await readSettings(file);
  const { allow, deny } = agyRules(root);
  const permissions = { ...(s.permissions ?? {}) };
  permissions.allow = [...new Set([...(permissions.allow ?? []), allow])];
  permissions.deny = [...new Set([...(permissions.deny ?? []), deny])];
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // Write-then-rename so a crash never leaves a half-written settings file behind.
  const tmp = `${file}.tlc-tmp`;
  await writeFile(tmp, JSON.stringify({ ...s, permissions }, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}
