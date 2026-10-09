// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PdfPasswordError, unlockPdf } from './pdf-unlock.ts';
import { isPdfEncrypted, listDocs, saveDoc, unlockDoc, workspaceDir } from './workspace-docs.ts';

function plainPdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const ENCRYPT = `ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  const opts = $.NSMutableDictionary.dictionary;
  opts.setObjectForKey($(argv[2]), $.PDFDocumentUserPasswordOption);
  opts.setObjectForKey($(argv[3]), $.PDFDocumentOwnerPasswordOption);
  return doc.writeToURLWithOptions($.NSURL.fileURLWithPath(argv[1]), opts);
}`;

function pdfText(file: string): string {
  const script = `ObjC.import('PDFKit'); function run(a) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a[0])); return d.string.js; }`;
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', script, file], { encoding: 'utf8' }).trim();
}

describe.runIf(process.platform === 'darwin')('unlockPdf (macOS PDFKit)', () => {
  let dir = '';
  let locked: Buffer;
  let permissionOnly: Buffer;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-pdf-test-'));
    await writeFile(join(dir, 'plain.pdf'), plainPdf('Partner API Rahasia'));
    execFileSync('osascript', ['-l', 'JavaScript', '-e', ENCRYPT, join(dir, 'plain.pdf'), join(dir, 'locked.pdf'), 'p@ss w0rd!#', 'owner-pw']);
    execFileSync('osascript', ['-l', 'JavaScript', '-e', ENCRYPT, join(dir, 'plain.pdf'), join(dir, 'perm.pdf'), '', 'owner-pw']);
    locked = await readFile(join(dir, 'locked.pdf'));
    permissionOnly = await readFile(join(dir, 'perm.pdf'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('asks for a password, rejects a wrong one, and decrypts with the right one', async () => {
    expect(isPdfEncrypted(locked)).toBe(true);
    await expect(unlockPdf(locked, '', 'locked.pdf')).rejects.toMatchObject({ code: 'pdf-password-required' });
    await expect(unlockPdf(locked, 'salah', 'locked.pdf')).rejects.toBeInstanceOf(PdfPasswordError);
    await expect(unlockPdf(locked, 'salah', 'locked.pdf')).rejects.toMatchObject({ code: 'pdf-password-invalid' });

    const out = await unlockPdf(locked, 'p@ss w0rd!#', 'locked.pdf');
    expect(isPdfEncrypted(out)).toBe(false);
    await writeFile(join(dir, 'out.pdf'), out);
    expect(pdfText(join(dir, 'out.pdf'))).toBe('Partner API Rahasia');
  });

  it('removes permission-only protection without a password', async () => {
    expect(isPdfEncrypted(permissionOnly)).toBe(true);
    expect(isPdfEncrypted(await unlockPdf(permissionOnly, '', 'perm.pdf'))).toBe(false);
  });

  it('rejects data that is not a readable PDF', async () => {
    const fake = Buffer.from('%PDF-1.4\ntrailer\n<< /Encrypt 2 0 R >>\n%%EOF');
    await expect(unlockPdf(fake, 'x', 'fake.pdf')).rejects.toThrow('tidak dapat dibuka');
  });

  it('stores encrypted uploads unlocked and unlocks previously stored ones', async () => {
    const draftId = `tlc-test-pdfpw-${Date.now()}`;
    try {
      await expect(saveDoc(draftId, 'partner.pdf', locked.toString('base64'))).rejects.toMatchObject({ code: 'pdf-password-required' });
      const saved = await saveDoc(draftId, 'partner.pdf', locked.toString('base64'), 'p@ss w0rd!#');
      expect(saved.encrypted).toBe(false);
      expect(isPdfEncrypted(await readFile(join(workspaceDir(draftId), 'docs', 'partner.pdf')))).toBe(false);

      await writeFile(join(workspaceDir(draftId), 'docs', 'lama.pdf'), locked);
      expect((await listDocs(draftId)).find((d) => d.name === 'lama.pdf')?.encrypted).toBe(true);
      await expect(unlockDoc(draftId, 'lama.pdf', 'salah')).rejects.toMatchObject({ code: 'pdf-password-invalid' });
      await unlockDoc(draftId, 'lama.pdf', 'p@ss w0rd!#');
      expect((await listDocs(draftId)).every((d) => !d.encrypted)).toBe(true);
    } finally {
      await rm(workspaceDir(draftId), { recursive: true, force: true });
    }
  });
});
