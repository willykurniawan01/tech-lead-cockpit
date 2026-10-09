// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agyReadAccess, grantAgyReadAccess } from './agy-settings.ts';
import { claudeReadOnlyDirArgs } from './ai-providers.ts';
import { diffSnapshots, resolveServicesRoot, snapshotRepos } from './services.ts';
import { prepareGeneratorWorkspace, readGeneratorResult } from './generator-runner.ts';
import { isPdfEncrypted, listDocs, saveDoc, safeDocName, workspaceDir } from './workspace-docs.ts';

describe('resolveServicesRoot', () => {
  it('rejects folders outside home and missing folders', async () => {
    await expect(resolveServicesRoot('/etc')).rejects.toThrow('di dalam folder home');
    await expect(resolveServicesRoot('~/definitely-not-here-tlc')).rejects.toThrow('tidak ditemukan');
    expect(await resolveServicesRoot('~')).toBe(homedir());
  });
});

describe('repo snapshots', () => {
  it('reports repos whose working tree changed', async () => {
    const root = await mkdtemp(join(homedir(), '.tlc-test-services-'));
    try {
      for (const name of ['svc-a', 'svc-b']) {
        await mkdir(join(root, name));
        execFileSync('git', ['init', '-q', join(root, name)]);
      }
      const before = await snapshotRepos(root);
      expect([...before.keys()].sort()).toEqual(['svc-a', 'svc-b']);
      await writeFile(join(root, 'svc-b', 'new.go'), 'package main');
      const changed = diffSnapshots(before, await snapshotRepos(root));
      expect(changed).toEqual([{ repo: 'svc-b', files: ['new.go'] }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('safeDocName', () => {
  it('strips paths and rejects unsupported types', () => {
    expect(safeDocName('../../etc/API Partner (v2).pdf')).toBe('API Partner (v2).pdf');
    expect(safeDocName('figma/screen.png')).toBe('screen.png');
    expect(() => safeDocName('run.sh')).toThrow('tidak didukung');
    expect(() => safeDocName('..')).toThrow();
  });
});

describe('PDF encryption and workspace docs', () => {
  const plainPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 1 >>\n%%EOF');
  const encryptedPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Size 2 /Encrypt 2 0 R >>\n%%EOF');

  it('detects encrypted vs unencrypted PDFs accurately', () => {
    expect(isPdfEncrypted(plainPdf)).toBe(false);
    expect(isPdfEncrypted(encryptedPdf)).toBe(true);
    expect(isPdfEncrypted(Buffer.from('not a pdf'))).toBe(false);
  });

  it('saves unencrypted PDFs as is', async () => {
    const draftId = `tlc-test-enc-${Date.now()}`;
    try {
      const saved = await saveDoc(draftId, 'open.pdf', plainPdf.toString('base64'));
      expect(saved.name).toBe('open.pdf');
      expect(saved.encrypted).toBe(false);
    } finally {
      await rm(workspaceDir(draftId), { recursive: true, force: true });
    }
  });

  it('flags encrypted PDFs in listDocs and excludes them from generator instructions', async () => {
    const draftId = `tlc-test-enc-ws-${Date.now()}`;
    const wsDir = workspaceDir(draftId);
    try {
      await mkdir(join(wsDir, 'docs'), { recursive: true });
      await writeFile(join(wsDir, 'docs', 'clean.pdf'), plainPdf);
      await writeFile(join(wsDir, 'docs', 'locked.pdf'), encryptedPdf);

      const docs = await listDocs(draftId);
      expect(docs).toHaveLength(2);
      expect(docs.find((d) => d.name === 'clean.pdf')?.encrypted).toBe(false);
      expect(docs.find((d) => d.name === 'locked.pdf')?.encrypted).toBe(true);

      const ws = await prepareGeneratorWorkspace({
        draftId,
        prompt: 'analisa',
        tadMarkdown: '# TAD',
        kind: 'brainstorm',
      });
      // Clean PDF is listed to be read
      expect(ws.instructions).toContain('clean.pdf');
      // Locked PDF is excluded from the normal reading list and warned about
      expect(ws.instructions).toContain('PERINGATAN DOKUMEN: File (locked.pdf)');
      expect(ws.instructions).toContain('JANGAN membuka atau memanggil tool view_file');
    } finally {
      await rm(wsDir, { recursive: true, force: true });
    }
  });
});

describe('Antigravity read access', () => {
  it('adds read-allow and write-deny rules while keeping other settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tlc-agy-'));
    const file = join(dir, 'settings.json');
    try {
      await writeFile(file, JSON.stringify({ theme: 'dark', permissions: { allow: ['command(git)'] } }));
      expect((await agyReadAccess('/Users/x/Services', file)).granted).toBe(false);
      await grantAgyReadAccess('/Users/x/Services', file);
      await grantAgyReadAccess('/Users/x/Services', file);
      const saved = JSON.parse(await readFile(file, 'utf8'));
      expect(saved.theme).toBe('dark');
      expect(saved.permissions.allow).toEqual(['command(git)', 'read_file(/Users/x/Services)']);
      expect(saved.permissions.deny).toEqual(['write_file(/Users/x/Services)']);
      expect((await agyReadAccess('/Users/x/Services', file)).granted).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a settings file it cannot parse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tlc-agy-'));
    const file = join(dir, 'settings.json');
    try {
      await writeFile(file, '{ not json');
      await expect(grantAgyReadAccess('/Users/x/Services', file)).rejects.toThrow('Tidak bisa membaca');
      expect(await readFile(file, 'utf8')).toBe('{ not json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('claudeReadOnlyDirArgs', () => {
  it('adds the folder for reading and denies writes there and shell access', () => {
    expect(claudeReadOnlyDirArgs(['/Users/me/MTN & FM/Services/'])).toEqual([
      '--add-dir',
      '/Users/me/MTN & FM/Services/',
      '--disallowedTools',
      'Bash',
      'Edit(//Users/me/MTN & FM/Services/**)',
      'Write(//Users/me/MTN & FM/Services/**)',
      'MultiEdit(//Users/me/MTN & FM/Services/**)',
      'NotebookEdit(//Users/me/MTN & FM/Services/**)',
    ]);
  });
});

describe('prepareGeneratorWorkspace', () => {
  it('tells the AI about the codebase, supporting docs and Figma links, and that only TAD.md may change', async () => {
    const draftId = `tlc-test-${Date.now()}`;
    try {
      await saveDoc(draftId, 'api-partner.pdf', Buffer.from('%PDF-1.4').toString('base64'));
      const ws = await prepareGeneratorWorkspace({
        draftId,
        prompt: 'Analisa',
        prdMarkdown: '# PRD - X',
        tadMarkdown: '# TAD - X',
        servicesRoot: '/Users/me/Services',
        figmaLinks: [{ title: 'Undang', url: 'https://www.figma.com/design/abc' }, { url: 'https://evil.example/x' }],
      });
      expect(ws.instructions).toContain('"/Users/me/Services"');
      expect(ws.instructions).toContain('HANYA untuk dibaca');
      expect(ws.instructions).toContain('docs/: dokumen pendukung (api-partner.pdf)');
      expect(ws.instructions).toContain('Satu-satunya file yang boleh kamu ubah adalah TAD.md');
      const figma = await readFile(join(ws.workspaceDir, 'figma-links.md'), 'utf8');
      expect(figma).toContain('Undang: https://www.figma.com/design/abc');
      expect(figma).not.toContain('evil.example');
    } finally {
      await rm(workspaceDir(draftId), { recursive: true, force: true });
    }
  });
});

describe('brainstorm phase', () => {
  it('only lets the AI maintain SCOPE.md and asks for a compact plan', async () => {
    const draftId = `tlc-test-bs-${Date.now()}`;
    try {
      const ws = await prepareGeneratorWorkspace({ draftId, prompt: 'Susun scope', tadMarkdown: '# TAD - X', kind: 'brainstorm', scopeMarkdown: '', servicesRoot: '/Users/me/Services' });
      expect(ws.instructions).toContain('FASE BRAINSTORMING');
      expect(ws.instructions).toContain('JANGAN mengubah TAD.md');
      expect(ws.instructions).toContain('Satu-satunya file yang boleh kamu ubah adalah SCOPE.md');
      expect(ws.instructions).toContain('## Pertanyaan Terbuka');
      expect(await readFile(ws.scopePath, 'utf8')).toContain('Belum ada');
    } finally {
      await rm(workspaceDir(draftId), { recursive: true, force: true });
    }
  });

  it('makes the TAD phase follow an agreed scope', async () => {
    const draftId = `tlc-test-ed-${Date.now()}`;
    try {
      const ws = await prepareGeneratorWorkspace({ draftId, prompt: 'Generate', tadMarkdown: '# TAD - X', kind: 'edit', scopeMarkdown: '# Rencana Scope\n\n| 1 | [BACKEND][A][X] - Task |', scopeAgreed: true });
      expect(ws.instructions).toContain('SCOPE.md sudah disetujui user');
      expect(ws.instructions).toContain('Satu-satunya file yang boleh kamu ubah adalah TAD.md');
      expect(await readFile(ws.scopePath, 'utf8')).toContain('[BACKEND][A][X] - Task');
    } finally {
      await rm(workspaceDir(draftId), { recursive: true, force: true });
    }
  });
});

describe('existing TAD (imported from Confluence)', () => {
  const tad = [
    '# TAD - Tabungan',
    '',
    '# Development Scope',
    '',
    '| No | Service Name | Task Name |',
    '|---|---|---|',
    '| 1 | `CORE-TCICO` | [BACKEND][CORE-TCICO][TM] - Get Transfer Sof |',
    '',
    '# Detail Task',
    '',
    '## [BACKEND][CORE-TCICO][TM] - Get Transfer Sof',
    '',
    '<table data-table-width="1579"><tbody><tr><th><h3>Description</h3></th><td><p>Ambil SOF</p><pre data-tlc-code="json"><code>{&#10;&#10;  &quot;a&quot;: 1&#10;}</code></pre></td></tr></tbody></table>',
    '',
  ].join('\n');

  it('continues the TAD: scope from Development Scope, tables spread out for editing', async () => {
    const draftId = `tlc-test-ex-${Date.now()}`;
    try {
      const ws = await prepareGeneratorWorkspace({ draftId, prompt: 'Tambah error 404', tadMarkdown: tad, kind: 'edit', existingTad: true, servicesRoot: '/Users/me/Services' });
      expect(ws.instructions).toContain('MELANJUTKAN, bukan menulis ulang');
      expect(ws.instructions).toContain('<pre data-tlc-code="json">');
      expect(ws.instructions).toContain('JANGAN memindai ulang seluruh codebase');
      expect(ws.instructions).not.toContain('Setiap requirement di PRD.md WAJIB');
      const scope = await readFile(ws.scopePath, 'utf8');
      expect(scope).toContain('## Scope Saat Ini');
      expect(scope).toContain('[BACKEND][CORE-TCICO][TM] - Get Transfer Sof');
      const onDisk = await readFile(ws.tadPath, 'utf8');
      expect(onDisk).toContain('<code>{\n\n  &quot;a&quot;: 1\n}</code>');

      // Untouched: no change reported, even though the file layout differs from the draft.
      expect((await readGeneratorResult(ws, { tad, scope: ws.initialScope }, { reply: 'ok' })).changed).toBe(false);

      // An AI edit inside the spread-out table comes back in the draft's single-line form.
      await writeFile(ws.tadPath, onDisk.replace('<p>Ambil SOF</p>', '<p>Ambil SOF aktif</p>\n<p>404 bila user tidak ada</p>'));
      const result = await readGeneratorResult(ws, { tad, scope: ws.initialScope }, { reply: 'ok' });
      expect(result.changed).toBe(true);
      const table = result.updatedTadMarkdown!.split('\n').find((l) => l.startsWith('<table'))!;
      expect(table).toContain('<td><p>Ambil SOF aktif</p><p>404 bila user tidak ada</p><pre data-tlc-code="json"><code>{&#10;&#10;  &quot;a&quot;: 1&#10;}</code></pre></td>');
      expect(result.updatedTadMarkdown!.split('\n').filter((l) => l.startsWith('<table'))).toHaveLength(1);
    } finally {
      await rm(workspaceDir(draftId), { recursive: true, force: true });
    }
  });

  it('brainstorms only the new changes on top of the current scope', async () => {
    const draftId = `tlc-test-exb-${Date.now()}`;
    try {
      const ws = await prepareGeneratorWorkspace({ draftId, prompt: 'Tambah refund', tadMarkdown: tad, kind: 'brainstorm', existingTad: true });
      expect(ws.instructions).toContain('Perubahan yang Diusulkan');
      expect(ws.instructions).toContain('Jangan menganalisa ulang service yang sudah ada');
      expect((await readGeneratorResult(ws, { tad, scope: ws.initialScope }, { reply: 'ok' })).scopeChanged).toBe(false);
    } finally {
      await rm(workspaceDir(draftId), { recursive: true, force: true });
    }
  });
});
