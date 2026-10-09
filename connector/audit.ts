import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent } from '../src/lib/confluence/api-types.ts';
import { DATA_DIR } from './paths.ts';

const DIR = DATA_DIR;
export const AUDIT_FILE = join(DIR, 'audit.jsonl');

/** Metadata only — never page content, diffs, or tokens. */
export async function appendAudit(event: AuditEvent): Promise<void> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  await appendFile(AUDIT_FILE, JSON.stringify(event) + '\n', { mode: 0o600 });
}

export async function readAudit(limit = 50): Promise<AuditEvent[]> {
  try {
    const lines = (await readFile(AUDIT_FILE, 'utf8')).trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as AuditEvent);
  } catch {
    return [];
  }
}
