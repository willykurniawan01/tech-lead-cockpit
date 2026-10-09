import { describe, expect, it } from 'vitest';
import {
  buildCoderReviewPrompt,
  extractRecommendations,
  extractReviewVerdict,
} from './agent-review';
import type { CoderRun } from './types';

describe('extractReviewVerdict', () => {
  it('parses APPROVE verdict', () => {
    const text = `## Ringkasan Perubahan\nSemua berjalan lancar.\n## Kesimpulan\nKode siap merge.\nVERDICT: APPROVE`;
    expect(extractReviewVerdict(text)).toBe('APPROVE');
  });

  it('parses APPROVE WITH COMMENTS verdict', () => {
    const text = `## Kesimpulan\nSecara umum bagus.\nVERDICT: APPROVE WITH COMMENTS`;
    expect(extractReviewVerdict(text)).toBe('APPROVE_WITH_COMMENTS');
  });

  it('parses REQUEST CHANGES verdict', () => {
    const text = `## Kesimpulan\nAda bug fatal di error handler.\nVERDICT: REQUEST CHANGES`;
    expect(extractReviewVerdict(text)).toBe('REQUEST_CHANGES');
  });

  it('handles lowercase or plain text variations in conclusion', () => {
    const text = `## Kesimpulan\nPerubahan ini request changes karena test gagal.`;
    expect(extractReviewVerdict(text)).toBe('REQUEST_CHANGES');
  });

  it('returns undefined if no verdict is present', () => {
    const text = `Belum selesai review.`;
    expect(extractReviewVerdict(text)).toBeUndefined();
  });
});

describe('extractRecommendations', () => {
  it('extracts recommendations section', () => {
    const text = `## Ringkasan Perubahan\nOK\n## Rekomendasi Perbaikan\n1. Tambahkan pengecekan nil pada ptr\n2. Gunakan context timeout\n## Kesimpulan\nVERDICT: REQUEST CHANGES`;
    const rec = extractRecommendations(text);
    expect(rec).toContain('1. Tambahkan pengecekan nil pada ptr');
    expect(rec).toContain('2. Gunakan context timeout');
    expect(rec).not.toContain('VERDICT');
  });

  it('falls back to bug findings if recommendations missing', () => {
    const text = `## Ringkasan\nOK\n## Temuan Bug\nQuery N+1 pada loop user.\n## Kesimpulan\nPerbaiki query.`;
    const rec = extractRecommendations(text);
    expect(rec).toContain('Query N+1 pada loop user.');
  });
});

describe('buildCoderReviewPrompt', () => {
  const dummyRun: CoderRun = {
    id: 'run-1',
    draftId: 'draft-1',
    tadTitle: 'TAD Super Feature',
    taskTitle: '[BACKEND] Implement Transfer SOF',
    jiraKey: 'MU-999',
    profile: 'backend',
    ai: { provider: 'claude', model: 'sonnet' },
    repo: 'core-tcico-ultimate',
    baseBranch: 'staging',
    targetBranch: 'staging',
    branch: 'feature/MU-999-transfer',
    worktree: '/tmp/worktree',
    spec: 'Spec detail',
    status: 'ready',
    createdAt: new Date().toISOString(),
    events: [],
    revisions: 0,
    test: { command: 'go test ./...', exitCode: 0, output: 'ok 0.2s' },
  };

  it('builds prompt and context with diff, spec, and test results', () => {
    const diffFiles = [
      {
        oldPath: 'app/service.go',
        newPath: 'app/service.go',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
        diff: '@@ -1,3 +1,5 @@\n+func Transfer() error { return nil }',
        additions: 1,
        deletions: 0,
      },
    ];

    const { prompt, context } = buildCoderReviewPrompt({
      run: dummyRun,
      diffFiles,
      spec: 'Detail task: Tambahkan fungsi Transfer',
      conformanceChecks: [{ label: 'File service.go', status: 'ok', detail: 'Ada perubahan' }],
      strictness: 'strict',
      customInstruction: 'Perhatikan validasi input transfer SOF.',
    });

    expect(prompt).toContain('Implement Transfer SOF');
    expect(prompt).toContain('core-tcico-ultimate');
    expect(prompt).toContain('LULUS (exit 0)');
    expect(prompt).toContain('Perhatikan validasi input transfer SOF.');
    expect(context).toContain('### SPESIFIKASI TASK DARI DOKUMEN TAD');
    expect(context).toContain('Tambahkan fungsi Transfer');
    expect(context).toContain('### HASIL CEK KESESUAIAN OTOMATIS');
    expect(context).toContain('func Transfer() error');
  });
});
