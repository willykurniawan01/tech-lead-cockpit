// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QAFlow, QASuite } from '../../src/lib/qa/types.ts';
import { DraftedQaStore } from './drafts.ts';
import { QaManager } from './manager.ts';
import { QaConflictError } from './store.ts';
import { memoryStore } from './test-store.ts';

const flow = (id: string, extra: Partial<QAFlow> = {}): QAFlow => ({ id, name: `Flow ${id}`, description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [], ...extra });
const suite = (flows: QAFlow[], extra: Partial<QASuite> = {}): QASuite => ({ projectId: 'promo', projectName: 'Promo Engine', flows, updatedAt: 'x', ...extra });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qa-drafts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A shared Confluence with one published suite (a, b), and a laptop with drafts on top of it. */
async function setup() {
  const shared = memoryStore();
  await shared.store().saveSuite(suite([flow('a'), flow('b')]), 'tl');
  const laptop = (sub = 'qa') => new DraftedQaStore(() => shared.store(), join(dir, sub));
  return { shared, laptop };
}

describe('DraftedQaStore', () => {
  it('keeps saves local until they are reviewed and sent', async () => {
    const { shared, laptop } = await setup();
    const qa = laptop();
    const loaded = (await qa.getSuite('promo'))!;
    const saved = await qa.saveSuite({ ...loaded, flows: [flow('a', { name: 'A oleh QA' }), flow('b'), flow('c')] }, 'qa');
    expect(saved.draft).toMatchObject({ changes: 2 });
    expect((await shared.store().getSuite('promo'))!.flows.map((f) => f.name)).toEqual(['Flow a', 'Flow b']);

    const review = await qa.reviewSuite('promo');
    expect(review.changes.map((c) => [c.key, c.kind])).toEqual([
      ['a', 'changed'],
      ['c', 'added'],
    ]);
    expect(review.conflicts).toEqual([]);

    const { suite: sent, sent: n } = await qa.publishSuite('promo', undefined, 'qa');
    expect(n).toBe(2);
    expect(sent.draft).toBeUndefined();
    expect((await shared.store().getSuite('promo'))).toMatchObject({ version: 2, updatedBy: 'qa' });
    expect(await readdir(join(dir, 'qa'))).toEqual([]);
  });

  it('sends part of a draft and keeps the rest; throws away chosen changes', async () => {
    const { shared, laptop } = await setup();
    const qa = laptop();
    const loaded = (await qa.getSuite('promo'))!;
    await qa.saveSuite({ ...loaded, flows: [flow('a', { name: 'A oleh QA' }), flow('c')], notes: 'catatan' }, 'qa');
    const { suite: left } = await qa.publishSuite('promo', ['c'], 'qa');
    expect((await shared.store().getSuite('promo'))!.flows.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(left.draft?.changes).toBe(3);
    expect((await qa.reviewSuite('promo')).changes.map((c) => c.key)).toEqual(['a', 'b', 'suite:notes']);

    const kept = (await qa.discardSuite('promo', ['b']))!;
    expect(kept.flows.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect((await qa.reviewSuite('promo')).changes.map((c) => c.key)).toEqual(['a', 'suite:notes']);
    expect((await qa.discardSuite('promo'))!.draft).toBeUndefined();
    expect((await qa.reviewSuite('promo')).changes).toEqual([]);
  });

  it('takes in what others sent on other test cases; the same test case waits for a decision', async () => {
    const { laptop } = await setup();
    const qa = laptop('qa');
    const tl = laptop('tl');
    const mine = (await qa.getSuite('promo'))!;
    await qa.saveSuite({ ...mine, flows: [flow('a', { name: 'A oleh QA' }), flow('b')] }, 'qa');
    const theirs = (await tl.getSuite('promo'))!;
    await tl.saveSuite({ ...theirs, flows: [flow('a'), flow('b', { name: 'B oleh TL' })] }, 'tl');
    await tl.publishSuite('promo', undefined, 'tl');

    // QA's draft now shows TL's change too, and still only QA's change to review.
    const now = (await qa.getSuite('promo'))!;
    expect(now.flows.map((f) => f.name)).toEqual(['A oleh QA', 'B oleh TL']);
    expect((await qa.reviewSuite('promo')).changes.map((c) => c.key)).toEqual(['a']);

    // TL changes a too, and sends it: QA's a collides.
    const t2 = (await tl.getSuite('promo'))!;
    await tl.saveSuite({ ...t2, flows: [flow('a', { name: 'A oleh TL' }), ...t2.flows.slice(1)] }, 'tl');
    await tl.publishSuite('promo', undefined, 'tl');
    const review = await qa.reviewSuite('promo');
    expect(review.conflicts).toEqual(['a']);
    expect(review.published).toMatchObject({ updatedBy: 'tl' });
    expect((await qa.getSuite('promo'))!.draft?.behind).toBe(true);
    await expect(qa.publishSuite('promo', undefined, 'qa')).rejects.toBeInstanceOf(QaConflictError);
    expect((await qa.discardSuite('promo', ['a']))!.flows[0].name).toBe('A oleh TL');
  });

  it('refuses a save over an older draft revision; the manager merges it per test case', async () => {
    const { laptop } = await setup();
    const store = laptop();
    const qa = new QaManager({ dir: '/nonexistent', store: () => store, actor: async () => 'qa', readSecret: async () => null, writeSecret: async () => true, deleteSecret: async () => true, runAi: () => ({ done: Promise.resolve({ reply: '' }), cancel: () => {} }) });
    const ui = (await qa.getSuite('promo'))!;
    const agent = (await qa.getSuite('promo'))!;
    await qa.saveSuite({ ...agent, flows: [flow('a', { name: 'A oleh AI' }), flow('b')] });
    const merged = await qa.saveSuite({ ...ui, flows: [flow('a'), flow('b', { name: 'B oleh QA' })] });
    expect(merged.flows.map((f) => f.name)).toEqual(['A oleh AI', 'B oleh QA']);
    await expect(store.saveSuite({ ...merged, draftRev: 0 })).rejects.toBeInstanceOf(QaConflictError);
    expect((await qa.reviewSuite('promo')).changes).toHaveLength(2);
  });
});
