import { describe, expect, it } from 'vitest';
import type { CoderRun } from '../coder/types';
import { latestResults } from './latest';
import { buildTadUpdatePrompt, collectFindings, likelyTad } from './tad-findings';
import type { QAFlow, QARun } from './types';

const flow = (id: string, extra: Partial<QAFlow> = {}): QAFlow => ({ id, name: `Flow ${id}`, description: '', category: 'happy-path', taskTitles: ['Task A'], variables: {}, enabled: true, steps: [], ...extra });

const run: QARun = {
  id: 'r1',
  projectId: 'p',
  projectName: 'P',
  environment: { id: 'dev', name: 'Development', readOnly: false },
  status: 'done',
  startedAt: '2026-10-22T08:00:00Z',
  flows: [
    {
      flowId: 'f4',
      name: 'Flow f4',
      category: 'happy-path',
      taskTitles: ['Task B'],
      status: 'failed',
      steps: [
        {
          stepId: 's',
          name: 'Upload dokumen',
          status: 'failed',
          request: { method: 'POST', url: 'http://dev:8080/v1/docs', headers: {} },
          response: { status: 413, headers: {}, body: '{"code":"FILE_TOO_LARGE"}' },
          assertions: [{ assertion: { type: 'status', op: 'equals', expected: 200 }, passed: false, message: 'Status 413, harusnya 200' }],
        },
      ],
    },
    { flowId: 'f1', name: 'Flow f1', category: 'happy-path', taskTitles: ['Task A'], status: 'passed', steps: [] },
  ],
  summary: { flows: 2, passedFlows: 1, failedFlows: 1, steps: 1, passedSteps: 0, failedSteps: 1 },
};

describe('E2E findings for the TAD', () => {
  const suite = {
    notes: 'Kuota harian per user belum jelas di TAD.',
    flows: [
      flow('f1', { repairNote: 'Test diperbaiki: field msisdn bertipe string di struct ReserveRequest' }),
      flow('f2', { warnings: ['Step "x": GET /v1/ghost tidak ada di peta journey (cek router).'] }),
      flow('f3', { repairNote: 'Lingkungan: server dev down' }),
      flow('f5', { repairNote: 'Diperbaiki AI: tanggal promo disesuaikan dengan hari ini' }),
      flow('f4', { taskTitles: ['Task B'] }),
    ],
    suspects: [{ flowId: 'f3', flowName: 'Flow f3', title: 'Reserve tidak mengurangi kuota', detail: 'kuota tetap 10', runId: 'r1', at: '' }],
  };
  const coderRuns = [{ id: 'c1', status: 'needs-input', reply: 'Analisa...\nBUTUH KLARIFIKASI: TAD tidak menyebut batas ukuran file.', source: { kind: 'e2e', projectId: 'p', flowId: 'f4', flowName: 'Flow f4', qaRunId: 'r1' } }] as unknown as CoderRun[];

  it('collects notes, test repairs, unplanned endpoints, agent questions, suspects and failures', () => {
    const found = collectFindings({ suite, runs: [run], latest: latestResults([run], 'dev'), coderRuns });
    expect(found.map((f) => [f.kind, f.suggested])).toEqual([
      ['note', true],
      ['repair', true],
      ['warning', false],
      ['edited', false],
      ['clarify', true],
      ['suspect', false],
      ['failed', false],
    ]);
    // An environment problem is not a TAD finding.
    expect(found.some((f) => f.id === 'repair-f3')).toBe(false);
    expect(found.find((f) => f.kind === 'clarify')?.detail).toBe('BUTUH KLARIFIKASI: TAD tidak menyebut batas ukuran file.');
    expect(found.find((f) => f.kind === 'failed')?.detail).toContain('Step "Upload dokumen" POST /v1/docs → HTTP 413: Status 413, harusnya 200');
  });

  it('picks the TAD most findings are about, and writes the instruction', () => {
    const found = collectFindings({ suite, runs: [run], latest: latestResults([run], 'dev'), coderRuns });
    const tads = [
      { draftId: 'tad-a', taskTitles: ['Task A'] },
      { draftId: 'tad-b', taskTitles: ['Task B'] },
    ];
    expect(likelyTad(found.filter((f) => f.suggested), tads)).toBe('tad-a');
    const prompt = buildTadUpdatePrompt(found.filter((f) => f.suggested), 'cek juga batas dokumen');
    expect(prompt).toContain('KELEWAT atau AMBIGU');
    expect(prompt).toContain('JANGAN ubah TAD untuk menyesuaikan kode');
    expect(prompt).toContain('Catatan Tech Lead:\ncek juga batas dokumen');
    expect(prompt).toContain('2. [Test diperbaiki karena beda dengan kode] Flow f1\n   Task TAD: Task A\n   Test diperbaiki: field msisdn');
    expect(prompt).toContain('3. [Pertanyaan coder agent] Flow f4');
  });
});
