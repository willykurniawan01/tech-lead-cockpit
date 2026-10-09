import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Removes the password/permission protection from a partner PDF so the AI CLI can read it.
 * Uses PDFKit through JXA (osascript ships with macOS, nothing to install). The password goes
 * over stdin, never argv, so it does not show up in `ps`, and it is never stored or logged.
 * PDFKit keeps the encryption when it rewrites an unlocked document, so the pages are copied
 * into a fresh, unencrypted document instead.
 */
const UNLOCK_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('PDFKit');
function run(argv) {
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const password = $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding).js || '';
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return 'unreadable';
  if (doc.isLocked) {
    if (!password) return 'password-required';
    if (!doc.unlockWithPassword(password)) return 'invalid-password';
  }
  const copy = $.PDFDocument.alloc.init;
  for (let i = 0; i < doc.pageCount; i++) copy.insertPageAtIndex(doc.pageAtIndex(i).copy, i);
  return copy.writeToURL($.NSURL.fileURLWithPath(argv[1])) ? 'ok' : 'write-failed';
}`;

const TIMEOUT_MS = 60_000;

export type PdfPasswordCode = 'pdf-password-required' | 'pdf-password-invalid';

export class PdfPasswordError extends Error {
  constructor(
    message: string,
    readonly code: PdfPasswordCode,
  ) {
    super(message);
  }
}

function runUnlock(input: string, output: string, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('osascript', ['-l', 'JavaScript', '-e', UNLOCK_SCRIPT, input, output], { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(new Error('Gagal membuka proteksi PDF lewat macOS PDFKit.'));
      else resolve(stdout.trim());
    });
    child.stdin?.end(password);
  });
}

/** Returns an unencrypted copy of `data`. `password` may be empty for permission-only PDFs. */
export async function unlockPdf(data: Buffer, password: string, name: string): Promise<Buffer> {
  if (process.platform !== 'darwin') throw new Error(`Membuka PDF berpassword hanya didukung di macOS (${name}).`);
  const dir = await mkdtemp(join(tmpdir(), 'tlc-pdf-'));
  try {
    const input = join(dir, 'in.pdf');
    const output = join(dir, 'out.pdf');
    await writeFile(input, data, { mode: 0o600 });
    const status = await runUnlock(input, output, password);
    if (status === 'password-required') throw new PdfPasswordError(`File "${name}" diproteksi password. Masukkan password untuk membukanya.`, 'pdf-password-required');
    if (status === 'invalid-password') throw new PdfPasswordError(`Password untuk "${name}" salah.`, 'pdf-password-invalid');
    if (status !== 'ok') throw new Error(`File "${name}" tidak dapat dibuka sebagai PDF.`);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
