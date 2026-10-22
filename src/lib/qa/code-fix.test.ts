import { describe, expect, it } from 'vitest';
import { buildCodeFixSpec, buildMultiCodeFixSpec, chunkFixes, codeFixTitle, describeAssertion, e2eDraftId, failedStep, failingService, multiCodeFixTitle } from './code-fix';
import type { QAFlow, QAFlowResult } from './types';

const flow: QAFlow = {
  id: 'f1',
  name: 'Reserve promo kuota habis',
  description: 'Reserve saat kuota 0 harus ditolak',
  category: 'business-edge-case',
  stage: '4. Reserve',
  taskTitles: ['Develop API Reserve'],
  variables: {},
  enabled: true,
  steps: [
    { id: 's1', name: 'Login', service: 'core-user-auth', request: { method: 'POST', path: '/login', headers: { Authorization: 'Bearer {{token}}' } }, assertions: [] },
    { id: 's2', name: 'Reserve', service: 'core-promo-ultimate', request: { method: 'POST', path: '/v1/promo/reserve', body: { promoId: '{{promoId}}' } }, assertions: [{ type: 'status', op: 'equals', expected: 422 }] },
  ],
};

const result: QAFlowResult = {
  flowId: 'f1',
  name: flow.name,
  category: flow.category,
  taskTitles: flow.taskTitles,
  status: 'failed',
  steps: [
    { stepId: 's1', name: 'Login', status: 'passed', assertions: [], request: { method: 'POST', url: 'http://dev/login', headers: { Authorization: 'Bearer ***' } } },
    {
      stepId: 's2',
      name: 'Reserve',
      status: 'failed',
      request: { method: 'POST', url: 'http://dev/v1/promo/reserve', headers: { Authorization: 'Bearer ***' }, body: '{"promoId":"P-1"}' },
      response: { status: 200, headers: {}, body: '{"code":"SUCCESS"}' },
      assertions: [{ assertion: { type: 'status', op: 'equals', expected: 422 }, passed: false, message: 'Status 200, harusnya 422' }],
    },
  ],
};

describe('code fix from a failed E2E test', () => {
  it('finds the failed step and its service', () => {
    expect(failedStep(result)?.stepId).toBe('s2');
    expect(failingService(flow, result)).toBe('core-promo-ultimate');
    expect(e2eDraftId('p1')).toBe('e2e-p1');
    expect(codeFixTitle(flow, 'core-promo-ultimate')).toBe('[BUGFIX][CORE-PROMO-ULTIMATE][E2E] - Reserve promo kuota habis');
  });

  it('writes a spec from the failure, the test and the TAD, without headers', () => {
    const spec = buildCodeFixSpec({
      flow,
      result,
      projectName: 'Promo Engine',
      envName: 'Development',
      runAt: '22/10/2026 14.15',
      repo: 'core-promo-ultimate',
      taskSpecs: [{ title: 'Develop API Reserve', spec: 'Kuota 0 → 422 QUOTA_EXHAUSTED' }],
      note: 'cek pengecekan kuota',
    });
    expect(spec).toContain('Test E2E gagal: Reserve promo kuota habis');
    expect(spec).toContain('Step yang gagal: Reserve (service core-promo-ultimate)');
    expect(spec).toContain('Request: POST http://dev/v1/promo/reserve');
    expect(spec).toContain('Response: HTTP 200\n{"code":"SUCCESS"}');
    expect(spec).toContain('- Status 200, harusnya 422');
    expect(spec).toContain('Step sebelumnya yang lulus: Login');
    expect(spec).toContain('Detail Task TAD "Develop API Reserve":\nKuota 0 → 422 QUOTA_EXHAUSTED');
    expect(spec).toContain('Catatan Tech Lead:\ncek pengecekan kuota');
    // Confirm the bug is in the code first; a wrong test is not "fixed" by changing the service.
    expect(spec).toContain('BUTUH KLARIFIKASI:');
    // Headers (auth) never go into the spec, neither from the run nor from the test definition.
    expect(spec).not.toContain('Authorization');
    expect(spec).not.toContain('Bearer');
  });

  // The case from the screen: step 1 fails, steps 2 and 3 are skipped and never checked.
  const gapFlow: QAFlow = {
    ...flow,
    id: 'g1',
    name: '[GAP] Aturan TAD yang belum ditegakkan kode di Create',
    stage: '1. Buat data promo (CMS)',
    steps: [
      { id: 'a', name: 'badge_enabled=true tanpa badge_text → 400', service: 'core-promo-ultimate', request: { method: 'POST', path: '/cms/promo', body: { badge_enabled: true } }, assertions: [{ type: 'status', op: 'equals', expected: 400 }, { type: 'json', path: '$.message_action', op: 'equals', expected: 'INVALID_PAYLOAD' }] },
      { id: 'b', name: 'full_day=false tanpa time_start/time_end → 400', service: 'core-promo-ultimate', request: { method: 'POST', path: '/cms/promo', body: { full_day: false } }, assertions: [{ type: 'status', op: 'equals', expected: 400 }] },
      { id: 'c', name: 'SPECIFIC_PARTNER tanpa partners → 400', service: 'core-promo-ultimate', request: { method: 'POST', path: '/cms/promo', body: { partner_type: 'SPECIFIC_PARTNER' } }, assertions: [{ type: 'status', op: 'equals', expected: 400 }] },
    ],
  };
  const gapResult: QAFlowResult = {
    flowId: 'g1',
    name: gapFlow.name,
    category: gapFlow.category,
    taskTitles: gapFlow.taskTitles,
    status: 'failed',
    steps: [
      { stepId: 'a', name: gapFlow.steps[0].name, status: 'failed', request: { method: 'POST', url: 'http://dev/cms/promo', headers: {}, body: '{"badge_enabled":true}' }, response: { status: 200, headers: {}, body: '{"message_action":"SUCCESS"}' }, assertions: [{ assertion: gapFlow.steps[0].assertions[0], passed: false, message: 'Status 200, harusnya 400' }] },
      { stepId: 'b', name: gapFlow.steps[1].name, status: 'skipped', assertions: [], error: 'Dilewati' },
      { stepId: 'c', name: gapFlow.steps[2].name, status: 'skipped', assertions: [], error: 'Dilewati' },
    ],
  };

  it('asks to fix the steps skipped after the failure in the same run', () => {
    const spec = buildCodeFixSpec({ flow: gapFlow, result: gapResult, projectName: 'Promo', envName: 'Development', runAt: 'x', repo: 'core-promo-ultimate' });
    expect(spec).toContain('Step yang gagal: badge_enabled=true tanpa badge_text → 400');
    expect(spec).toContain('BELUM DIUJI');
    expect(spec).toContain('- full_day=false tanpa time_start/time_end → 400: POST /cms/promo (service core-promo-ultimate)');
    expect(spec).toContain('  Body: {"partner_type":"SPECIFIC_PARTNER"}');
    expect(spec).toContain('  Diharapkan: status = 400');
    expect(spec).toContain('jangan berhenti di yang pertama');
    expect(describeAssertion({ type: 'json', path: '$.message_action', op: 'equals', expected: 'INVALID_PAYLOAD' })).toBe('$.message_action equals "INVALID_PAYLOAD"');
    expect(describeAssertion({ type: 'status', op: 'in', expected: [200, 201] })).toBe('status salah satu dari [200,201]');
  });

  it('fixes several test cases of one repo in one run, the TAD spec once', () => {
    const spec = buildMultiCodeFixSpec({
      items: [
        { flow, result, runAt: 'r1' },
        { flow: gapFlow, result: gapResult, runAt: 'r2' },
      ],
      projectName: 'Promo',
      envName: 'Development',
      repo: 'core-promo-ultimate',
      taskSpecs: [
        { title: 'Develop API Reserve', spec: 'Kuota 0 → 422' },
        { title: 'Develop API Reserve', spec: 'Kuota 0 → 422' },
      ],
    });
    expect(spec).toContain('2 test E2E gagal di core-promo-ultimate');
    expect(spec).toContain('=== Test case 1: Reserve promo kuota habis (run r1) ===');
    expect(spec).toContain('=== Test case 2: [GAP] Aturan TAD yang belum ditegakkan kode di Create (run r2) ===');
    expect(spec.match(/Detail Task TAD "Develop API Reserve"/g)).toHaveLength(1);
    expect(spec).toContain('Ringkas per test case');
    expect(spec).not.toContain('Authorization');
    // One test case: the same spec as the single dialog.
    expect(buildMultiCodeFixSpec({ items: [{ flow, result, runAt: 'r1' }], projectName: 'Promo', envName: 'Development', repo: 'x' })).toContain('Test E2E gagal: Reserve promo kuota habis');
  });

  it('splits runs and names them by their shared group', () => {
    expect(chunkFixes([1, 2, 3, 4, 5, 6, 7, 8], 6)).toEqual([[1, 2, 3, 4, 5, 6], [7, 8]]);
    expect(multiCodeFixTitle([gapFlow, { ...gapFlow, id: 'g2' }], 'core-promo-ultimate')).toBe('[BUGFIX][CORE-PROMO-ULTIMATE][E2E] - Perbaikan Buat data promo (CMS)');
    expect(multiCodeFixTitle([gapFlow, flow], 'x')).toBe('[BUGFIX][X][E2E] - Perbaikan 2 test case');
    expect(multiCodeFixTitle([flow], 'x')).toBe(codeFixTitle(flow, 'x'));
  });
});

