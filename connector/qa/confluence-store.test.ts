// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { QAEnvironment, QAFlow, QARun, QASuite } from '../../src/lib/qa/types.ts';
import { ConfluenceError } from '../confluence.ts';
import { ConfluenceQaStore, type ConfluenceApi } from './confluence-store.ts';
import { QaManager } from './manager.ts';
import { KEEP_RUNS, QaConflictError } from './store.ts';

/** An in-memory Confluence: pages with versions (409 on a stale update) and attachments. */
function fakeConfluence() {
  let seq = 100;
  const pages = new Map<string, { id: string; title: string; parent?: string; version: number; storage: string }>();
  const files = new Map<string, Map<string, { id: string; text: string }>>();
  pages.set('1', { id: '1', title: 'QA', version: 1, storage: '' });
  const page = (id: string) => {
    const p = pages.get(id);
    if (!p) throw new ConfluenceError('Tidak ditemukan (404).', 404, 'not-found');
    return p;
  };
  const api: ConfluenceApi & { pages: typeof pages; files: typeof files; calls: number } = {
    pages,
    files,
    calls: 0,
    async getPage(id) {
      api.calls++;
      const p = page(id);
      return { id: p.id, title: p.title, version: p.version, storage: p.storage };
    },
    async childPages(id) {
      api.calls++;
      return [...pages.values()].filter((p) => p.parent === id).map((p) => ({ id: p.id, title: p.title, version: p.version }));
    },
    async createPage(input) {
      if ([...pages.values()].some((p) => p.title === input.title)) throw new ConfluenceError('Judul sudah dipakai.', 400, 'bad-request');
      const id = String(seq++);
      pages.set(id, { id, title: input.title, parent: input.parentId, version: 1, storage: input.storage });
      return { id, version: 1 };
    },
    async updatePage(input) {
      const p = page(input.id);
      if (input.version !== p.version + 1) throw new ConfluenceError('Konflik versi di Confluence (409).', 409, 'conflict');
      p.version = input.version;
      p.storage = input.storage;
      return { version: p.version };
    },
    async attachments(id, filename) {
      return [...(files.get(id)?.entries() ?? [])].filter(([name]) => !filename || name === filename).map(([name, f]) => ({ id: f.id, title: name }));
    },
    async readAttachment(id, filename) {
      return files.get(id)?.get(filename)?.text ?? null;
    },
    async putAttachment(id, filename, data) {
      page(id);
      const map = files.get(id) ?? new Map();
      files.set(id, map);
      map.set(filename, { id: map.get(filename)?.id ?? `att-${seq++}`, text: data.toString('utf8') });
    },
    async deleteAttachment(attId) {
      for (const map of files.values()) for (const [name, f] of map) if (f.id === attId) map.delete(name);
    },
  };
  return api;
}

const at = { spaceKey: 'QA', parentPageId: '1' };
const flow = (id: string, extra: Partial<QAFlow> = {}): QAFlow => ({ id, name: `Flow ${id}`, description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [], ...extra });
const suite = (extra: Partial<QASuite> = {}): QASuite => ({ projectId: 'promo', projectName: 'Promo Engine', flows: [flow('a'), flow('b')], updatedAt: 'x', ...extra });
const run = (i: number): QARun => ({ id: `2026-10-01T00-${String(i).padStart(2, '0')}-r${i}`, projectId: 'promo', projectName: 'Promo Engine', environment: { id: 'dev', name: 'Dev', readOnly: false }, status: 'done', startedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), flows: [], summary: {} as QARun['summary'] });
const env = (id: string, extra: Partial<QAEnvironment> = {}): QAEnvironment => ({ id, name: id, baseUrl: 'https://api.dev.test', services: {}, headers: {}, variables: {}, auth: { type: 'none' }, readOnly: false, timeoutMs: 5_000, ...extra });

describe('ConfluenceQaStore', () => {
  it('keeps a project page with suite.json, locked by the page version', async () => {
    const cf = fakeConfluence();
    const store = new ConfluenceQaStore(cf, at);
    const a = await store.saveSuite(suite(), 'tl@example.test');
    expect(a.version).toBe(1);
    const projectPage = [...cf.pages.values()].find((p) => p.title === 'Promo Engine · API Testing [promo]')!;
    expect(projectPage.parent).toBe('1');
    expect(cf.files.get(projectPage.id)?.has('suite.json')).toBe(true);
    expect(projectPage.storage).toContain('2 test case');

    const b = await store.saveSuite({ ...a, notes: 'TL' }, 'tl@example.test');
    expect(b.version).toBe(2);
    // A second store (another laptop) reads the same thing.
    const other = new ConfluenceQaStore(cf, at);
    expect(await other.getSuite('promo')).toMatchObject({ notes: 'TL', version: 2, updatedBy: 'tl@example.test' });
    // QA saved over version 1: refused, with who saved first.
    await expect(other.saveSuite({ ...a, notes: 'QA' }, 'qa@example.test')).rejects.toThrow(/oleh tl@example\.test/);
    await expect(other.saveSuite(suite(), 'qa')).rejects.toBeInstanceOf(QaConflictError);
  });

  it('starts a suite on a project page Tech Lead Cockpit registered first', async () => {
    const cf = fakeConfluence();
    const store = new ConfluenceQaStore(cf, at);
    await store.upsertProject({ id: 'promo', name: 'Promo Engine', tads: [{ title: 'TAD Promo', confluencePageId: '42' }] }, 'tl');
    expect(await store.getSuite('promo')).toBeNull();
    expect(await store.listProjects()).toEqual([expect.objectContaining({ id: 'promo', name: 'Promo Engine', tads: [{ title: 'TAD Promo', confluencePageId: '42' }] })]);
    const saved = await store.saveSuite(suite(), 'qa');
    expect(saved.version).toBe(2);
  });

  it('keeps plans on their own page, so editing a plan never collides with test cases', async () => {
    const cf = fakeConfluence();
    const store = new ConfluenceQaStore(cf, at);
    const s = await store.saveSuite(suite(), 'tl');
    const p = await store.savePlan({ projectId: 'promo', projectName: 'Promo Engine', createdAt: 'x', updatedAt: 'x', ai: { provider: 'claude', model: '' }, request: { projectId: 'promo', projectName: 'Promo Engine', ai: { provider: 'claude', model: '' }, tasks: [], categories: [] }, stages: [{ id: 's1', title: 'Setup', goal: '', taskTitles: [], endpoints: [], produces: [], consumes: [], rules: [] }], variables: [] }, 'qa');
    expect((await store.getPlan('promo'))?.stages).toHaveLength(1);
    expect((await store.saveSuite({ ...s, notes: 'tetap' }, 'tl')).version).toBe(2);
    await expect(store.savePlan({ ...p, version: p.version! - 1 }, 'tl')).rejects.toThrow(/Rencana journey/);
  });

  it('writes runs as attachments without a lock and keeps the newest only', async () => {
    const cf = fakeConfluence();
    const store = new ConfluenceQaStore(cf, at);
    for (let i = 0; i < KEEP_RUNS + 2; i++) await store.saveRun(run(i), 'qa');
    const runs = await store.listRuns('promo');
    expect(runs).toHaveLength(KEEP_RUNS);
    expect(runs[0].id).toBe(run(KEEP_RUNS + 1).id);
    expect(await store.getRun('promo', run(0).id)).toBeUndefined();
    expect((await store.getRun('promo', run(10).id))?.id).toBe(run(10).id);
  });

  it('shares one environments page; a new environment never collides, a stale edit does', async () => {
    const cf = fakeConfluence();
    const tl = new ConfluenceQaStore(cf, at);
    const qa = new ConfluenceQaStore(cf, at);
    const dev = await tl.saveEnvironment({ ...env('dev'), hasSecret: true }, 'tl');
    await qa.saveEnvironment(env('stg'), 'qa');
    const listed = await tl.listEnvironments();
    expect(listed.map((e) => e.id)).toEqual(['dev', 'stg']);
    expect(listed[0]).not.toHaveProperty('hasSecret');
    await expect(tl.saveEnvironment({ ...dev, name: 'Dev lama' }, 'tl')).rejects.toBeInstanceOf(QaConflictError);
    await tl.deleteEnvironment('stg');
    expect((await qa.listEnvironments()).map((e) => e.id)).toEqual(['dev']);
  });
});

describe('QaManager merges saves per test case', () => {
  const manager = (store: ConfluenceQaStore, actor: string) =>
    new QaManager({ dir: '/nonexistent', store: () => store, actor: async () => actor, readSecret: async () => null, writeSecret: async () => true, deleteSecret: async () => true, runAi: () => ({ done: Promise.resolve({ reply: '' }), cancel: () => {} }) });

  it('combines edits to different test cases, refuses the same one', async () => {
    const cf = fakeConfluence();
    const tl = manager(new ConfluenceQaStore(cf, at), 'tl@example.test');
    const qa = manager(new ConfluenceQaStore(cf, at), 'qa@example.test');
    await tl.saveSuite(suite());
    const tlCopy = (await tl.getSuite('promo'))!;
    const qaCopy = (await qa.getSuite('promo'))!;
    await tl.saveSuite({ ...tlCopy, flows: [flow('a', { name: 'A oleh TL' }), flow('b')] });
    // QA edited another test case on the older copy: merged, not refused.
    const merged = await qa.saveSuite({ ...qaCopy, flows: [flow('a'), flow('b', { name: 'B oleh QA' })] });
    expect(merged.flows.map((f) => f.name)).toEqual(['A oleh TL', 'B oleh QA']);
    // Now both change test case a on stale copies: a real conflict, named.
    await expect(qa.saveSuite({ ...qaCopy, flows: [flow('a', { name: 'A oleh QA' }), flow('b')] })).rejects.toThrow(/Test case "A oleh QA" sudah diubah oleh qa@example\.test/);
  });
});
