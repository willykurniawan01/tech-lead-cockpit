import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidDraftId } from './generator-runner.ts';
import { unlockPdf } from './pdf-unlock.ts';
import { DATA_DIR } from './paths.ts';

/**
 * Supporting documents (partner API docs, Figma exports, notes) live in the draft's AI
 * workspace under docs/, so the CLI can read them next to PRD.md and TAD.md.
 */

export const MAX_DOC_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXT = /\.(md|markdown|txt|json|ya?ml|csv|pdf|png|jpe?g|webp|html?|xml|proto|graphql|sql)$/i;

export interface WorkspaceDoc {
  name: string;
  size: number;
  encrypted?: boolean;
}

export function isPdfEncrypted(data: Buffer): boolean {
  if (data.length < 5 || data.subarray(0, 5).toString('latin1') !== '%PDF-') return false;
  return /\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(data.toString('latin1'));
}

export function workspaceDir(draftId: string): string {
  if (!isValidDraftId(draftId)) throw new Error('draftId tidak valid.');
  return join(DATA_DIR, 'workspaces', draftId);
}

/** Keeps the original name readable but impossible to use for path traversal. */
export function safeDocName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\- ()&]+/g, '_').replace(/^\.+/, '').slice(0, 120).trim();
  if (!cleaned || !ALLOWED_EXT.test(cleaned)) throw new Error(`Tipe file tidak didukung: ${name}. Gunakan md, txt, json, yaml, pdf, png, jpg, html, xml, csv, sql, proto, atau graphql.`);
  return cleaned;
}

export async function listDocs(draftId: string): Promise<WorkspaceDoc[]> {
  const dir = join(workspaceDir(draftId), 'docs');
  try {
    const names = await readdir(dir);
    const docs = await Promise.all(
      names.map(async (name) => {
        const filePath = join(dir, name);
        const s = await stat(filePath);
        let encrypted = false;
        if (name.toLowerCase().endsWith('.pdf') && s.size <= MAX_DOC_BYTES) {
          try {
            const buf = await readFile(filePath);
            encrypted = isPdfEncrypted(buf);
          } catch {
            /* ignore */
          }
        }
        return { name, size: s.size, encrypted };
      }),
    );
    return docs.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Encrypted PDFs are stored unlocked: the AI CLI cannot read them otherwise. Permission-only
 * protection is removed without asking; a user password must come from `password` and is not kept.
 */
export async function saveDoc(draftId: string, name: string, base64: string, password = ''): Promise<WorkspaceDoc> {
  const safe = safeDocName(name);
  let data: Buffer = Buffer.from(base64, 'base64');
  if (!data.length) throw new Error('File kosong.');
  if (data.length > MAX_DOC_BYTES) throw new Error(`File melebihi ${MAX_DOC_BYTES / 1024 / 1024} MB.`);
  if (safe.toLowerCase().endsWith('.pdf') && isPdfEncrypted(data)) data = await unlockPdf(data, password, safe);
  const dir = join(workspaceDir(draftId), 'docs');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, safe), data, { mode: 0o600 });
  return { name: safe, size: data.length, encrypted: false };
}

/** Unlocks a PDF that was stored encrypted (uploaded before unlocking existed). */
export async function unlockDoc(draftId: string, name: string, password: string): Promise<WorkspaceDoc> {
  const safe = safeDocName(name);
  const filePath = join(workspaceDir(draftId), 'docs', safe);
  const data = await readFile(filePath);
  if (!isPdfEncrypted(data)) return { name: safe, size: data.length, encrypted: false };
  const unlocked = await unlockPdf(data, password, safe);
  await writeFile(filePath, unlocked, { mode: 0o600 });
  return { name: safe, size: unlocked.length, encrypted: false };
}

export async function deleteDoc(draftId: string, name: string): Promise<void> {
  await rm(join(workspaceDir(draftId), 'docs', safeDocName(name)), { force: true });
}
