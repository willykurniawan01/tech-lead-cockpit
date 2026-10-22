// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { evidenceStorage, evidenceTitle } from '../../src/lib/qa/evidence.ts';
import type { QARun } from '../../src/lib/qa/types.ts';
import { ConfluenceQaStore } from './confluence-store.ts';
import { DraftedQaStore } from './drafts.ts';
import { QaManager } from './manager.ts';
import { fakeConfluence, TEST_LOCATION } from './test-store.ts';

const run = (extra: Partial<QARun> = {}): QARun => ({
  id: '2026-10-22T10-57-43-212Z-9ccb8b',
  projectId: 'promo',
  projectName: 'Promo Engine',
  environment: { id: 'dev', name: 'Development', readOnly: false },
  status: 'done',
  startedAt: '2026-10-22T10:57:43.212Z',
  finishedAt: '2026-10-22T10:58:13.212Z',
  summary: { flows: 2, passedFlows: 1, failedFlows: 1, steps: 2, passedSteps: 1, failedSteps: 1 },
  flows: [
    { flowId: 'a', name: 'Buat promo <cashback>', category: 'happy-path', taskTitles: ['[BACKEND] Create promo'], status: 'passed', steps: [{ stepId: 's1', name: 'Create', status: 'passed', durationMs: 120, request: { method: 'POST', url: 'https://api.dev.test/promo', headers: { Authorization: 'Bearer ••••' }, body: '{"name":"A"}' }, response: { status: 201, headers: {}, body: '{"id":1,"x":"]]>"}' }, assertions: [{ assertion: { type: 'status', op: 'equals', expected: 201 }, passed: true, actual: 201, message: 'Status 201' }], curl: "curl -X POST 'https://api.dev.test/promo'" }] },
    { flowId: 'b', name: 'Promo kedaluwarsa', category: 'validation', taskTitles: [], status: 'failed', steps: [{ stepId: 's1', name: 'Validate', status: 'failed', assertions: [{ assertion: { type: 'status', op: 'equals', expected: 400 }, passed: false, actual: 200, message: 'Status harus 400' }] }] },
  ],
  ...extra,
});

describe('evidence page', () => {
  it('renders a summary, a test case table and step details, escaped', () => {
    const html = evidenceStorage(run(), { by: 'qa@example.test', attachment: 'run-x.json' });
    expect(html).toContain('Buat promo &lt;cashback&gt;');
    expect(html).toContain('<ac:parameter ac:name="title">GAGAL</ac:parameter>');
    expect(html).toContain('Status harus 400');
    expect(html).toContain('Bearer ••••');
    expect(html).not.toMatch(/"x":"]]>"/);
    expect(html).toContain('qa@example.test');
    expect(evidenceTitle(run())).toMatch(/^Evidence Promo Engine · .* · Development \(1\/2 lulus\)$/);
  });

  it('cuts long bodies and keeps a huge run within page size', () => {
    const big = 'x'.repeat(50_000);
    const r = run();
    r.flows[0].steps[0].response!.body = big;
    expect(evidenceStorage(r, { attachment: 'a' })).toContain('dipotong');
  });

  it('creates the page under the run page, attaches the run, updates it when sent again', async () => {
    const cf = fakeConfluence();
    const store = new DraftedQaStore(() => new ConfluenceQaStore(cf, TEST_LOCATION), '/nonexistent-drafts');
    const qa = new QaManager({ dir: '/nonexistent', store: () => store, actor: async () => 'qa@example.test', readSecret: async () => null, writeSecret: async () => true, deleteSecret: async () => true, runAi: () => ({ done: Promise.resolve({ reply: '' }), cancel: () => {} }) });
    const r = run();
    await store.saveRun(r, 'qa');
    const first = await qa.publishEvidence('promo', r.id);
    const page = cf.pages.get(first.pageId)!;
    expect(page.title).toBe(evidenceTitle(r));
    expect(cf.pages.get(page.parent!)!.title).toBe('Promo Engine · API Testing · Run');
    expect(page.labels).toEqual(['qa-evidence-2026-10-22t10-57-43-212z-9ccb8b', 'qa-evidence']);
    expect(cf.files.get(first.pageId)?.has(`run-${r.id}.json`)).toBe(true);
    expect((await qa.getRun('promo', r.id))?.evidence).toMatchObject({ pageId: first.pageId, by: 'qa@example.test' });

    const again = await qa.publishEvidence('promo', r.id);
    expect(again.pageId).toBe(first.pageId);
    expect(cf.pages.get(first.pageId)!.version).toBe(2);
    expect(JSON.parse(cf.files.get(first.pageId)!.get(`run-${r.id}.json`)!.text)).not.toHaveProperty('evidence');
    await expect(qa.publishEvidence('promo', 'tidak-ada')).rejects.toThrow(/tidak ditemukan/);
  });
});
