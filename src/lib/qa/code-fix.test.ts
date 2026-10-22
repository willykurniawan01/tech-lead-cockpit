import { describe, expect, it } from 'vitest';
import { buildCodeFixSpec, codeFixTitle, e2eDraftId, failedStep, failingService } from './code-fix';
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
});
