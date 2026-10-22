// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataType, newDb } from 'pg-mem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QAEnvironment, QAPlan, QARun, QASuite } from '../../src/lib/qa/types.ts';
import { connectorMiddleware } from '../dev-connector.ts';
import { QaManager } from './manager.ts';
import { LATEST_SCHEMA, PgQaStore, QaStoreError, type PgPoolLike } from './pg-store.ts';
import { QaStoreSwitch } from './store-config.ts';
import { moveToCentral } from './store-migrate.ts';
import { FileQaStore, KEEP_RUNS, QaConflictError, type QaStore } from './store.ts';

/** A fresh in-memory PostgreSQL; `pool()` gives another connection to the same database. */
function memoryDb() {
  // CREATE TABLE IF NOT EXISTS on an existing table trips pg-mem's AST coverage check (not PostgreSQL).
  const db = newDb({ noAstCoverageCheck: true });
  db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.text, implementation: () => '' });
  const { Pool } = db.adapters.createPg();
  return { db, pool: () => new Pool() as unknown as PgPoolLike };
}

const suite = (projectId = 'p1', extra: Partial<QASuite> = {}): QASuite => ({ projectId, projectName: 'Promo', flows: [], updatedAt: '2026-10-01T00:00:00.000Z', ...extra });
const plan = (projectId = 'p1'): QAPlan => ({ projectId, projectName: 'Promo', createdAt: 'x', updatedAt: 'x', ai: { provider: 'claude', model: '' }, request: { projectId, projectName: 'Promo', tasks: [], categories: [] }, stages: [{ id: 's1', title: 'Setup', taskTitles: [], endpoints: [], rules: [] }], variables: [] }) as unknown as QAPlan;
const env = (id = 'dev', extra: Partial<QAEnvironment> = {}): QAEnvironment => ({ id, name: 'Dev', baseUrl: 'https://api.dev.test', services: {}, headers: {}, variables: {}, auth: { type: 'bearer' }, readOnly: false, timeoutMs: 5_000, ...extra });
const run = (i: number, projectId = 'p1'): QARun => ({
  id: `2026-10-01T00-${String(i).padStart(2, '0')}-00-000Z-r${i}`,
  projectId,
  projectName: 'Promo',
  environment: { id: 'dev', name: 'Dev', readOnly: false },
  status: 'done',
  startedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  finishedAt: new Date(Date.UTC(2026, 9, 1, 0, i, 30)).toISOString(),
  flows: [],
  summary: { flows: 0, passedFlows: 0, failedFlows: 0, steps: 0, passedSteps: 0, failedSteps: 0, skippedSteps: 0 } as QARun['summary'],
});

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tlc-qa-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The same contract for both stores. */
function contract(name: string, make: () => Promise<QaStore>) {
  describe(`${name} store`, () => {
    it('versions suites and refuses a save over a newer one', async () => {
      const store = await make();
      const a = await store.saveSuite(suite(), 'tl@example.test');
      expect(a.version).toBe(1);
      const b = await store.saveSuite({ ...a, notes: 'TL' }, 'tl@example.test');
      expect(b.version).toBe(2);
      // QA loaded version 1 before the TL saved: refused, with who and when.
      const stale = store.saveSuite({ ...a, notes: 'QA' }, 'qa@example.test');
      await expect(stale).rejects.toBeInstanceOf(QaConflictError);
      await expect(stale).rejects.toThrow(/sudah diubah oleh tl@example\.test/);
      const now = await store.getSuite('p1');
      expect(now).toMatchObject({ notes: 'TL', version: 2, updatedBy: 'tl@example.test' });
      // A second "create" of the same project is a conflict too, not an overwrite.
      await expect(store.saveSuite(suite(), 'qa@example.test')).rejects.toBeInstanceOf(QaConflictError);
    });

    it('versions plans and environments; environments keep no connector fields', async () => {
      const store = await make();
      const p = await store.savePlan(plan(), 'a');
      await expect(store.savePlan({ ...plan(), version: 0 }, 'b')).rejects.toThrow(/Rencana journey/);
      expect((await store.savePlan(p, 'a')).version).toBe(2);

      const e = await store.saveEnvironment({ ...env(), hasSecret: true, secretVariableNames: ['pin'], dbServerPassword: true }, 'a');
      expect(e.version).toBe(1);
      const [listed] = await store.listEnvironments();
      expect(listed).not.toHaveProperty('hasSecret');
      expect(listed).not.toHaveProperty('secretVariableNames');
      expect(listed.updatedBy).toBe('a');
      await expect(store.saveEnvironment({ ...env(), version: 0 }, 'b')).rejects.toThrow(/Environment ini/);
      await store.deleteEnvironment('dev');
      expect(await store.listEnvironments()).toEqual([]);
    });

    it('keeps the newest runs only', async () => {
      const store = await make();
      for (let i = 0; i < KEEP_RUNS + 3; i++) await store.saveRun(run(i), 'a');
      const runs = await store.listRuns('p1');
      expect(runs).toHaveLength(KEEP_RUNS);
      expect(runs[0].id).toBe(run(KEEP_RUNS + 2).id);
      expect(await store.getRun('p1', run(0).id)).toBeUndefined();
      expect((await store.getRun('p1', run(10).id))?.startedAt).toBe(run(10).startedAt);
      expect(await store.listRuns('other')).toEqual([]);
    });

    it('stores projects with their TADs', async () => {
      const store = await make();
      await store.upsertProject({ id: 'p1', name: 'Promo', tads: [{ title: 'TAD Promo', confluencePageId: '123', jiraKeys: ['PRM-1'] }] }, 'tl');
      await store.upsertProject({ id: 'p1', name: 'Promo Engine', tads: [] }, 'tl');
      expect(await store.listProjects()).toEqual([expect.objectContaining({ id: 'p1', name: 'Promo Engine', tads: [], updatedBy: 'tl' })]);
    });
  });
}

contract('file', async () => new FileQaStore(dir));
contract('postgres', async () => new PgQaStore(memoryDb().pool()));

describe('PgQaStore', () => {
  it('creates the tables once, records the schema version, and lists a suite\'s project', async () => {
    const mem = memoryDb();
    const first = new PgQaStore(mem.pool());
    await first.saveSuite(suite(), 'tl');
    // A second app on the same database finds the schema in place.
    const second = new PgQaStore(mem.pool());
    expect(await second.migrate()).toBe(LATEST_SCHEMA);
    expect(mem.db.public.many('SELECT version FROM schema_version')).toEqual([{ version: LATEST_SCHEMA }]);
    expect(await second.listProjects()).toEqual([expect.objectContaining({ id: 'p1', name: 'Promo' })]);
    expect(await second.probe()).toEqual({ server: expect.any(String), schemaVersion: LATEST_SCHEMA });
  });

  it('refuses a schema newer than the app', async () => {
    const mem = memoryDb();
    await new PgQaStore(mem.pool()).migrate();
    mem.db.public.none(`INSERT INTO schema_version (version, name) VALUES (${LATEST_SCHEMA + 1}, 'future')`);
    await expect(new PgQaStore(mem.pool()).getSuite('p1')).rejects.toThrow(/lebih baru dari app ini/);
  });

  it('turns driver errors into messages a user can act on', async () => {
    const broken = { query: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), connect: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), end: async () => {} };
    const store = new PgQaStore(broken as PgPoolLike, { host: 'db.test', port: 5432, database: 'tlc_qa', user: 'u' });
    await expect(store.getSuite('p1')).rejects.toThrow(QaStoreError);
    await expect(store.getSuite('p1')).rejects.toThrow(/db\.test:5432\/tlc_qa tidak terjangkau/);
  });
});

describe('QaStoreSwitch', () => {
  it('uses files by default, one pool per connection, and never falls back silently', async () => {
    let pools = 0;
    const sw = new QaStoreSwitch({ readPassword: async () => 'pw', createPool: () => (pools++, memoryDb().pool()) });
    await sw.apply({ mode: 'file', host: '', port: 5432, database: 'tlc_qa', user: '', ssl: false });
    expect(sw.current()).toBeUndefined();
    expect(sw.status()).toEqual({ mode: 'file' });

    await sw.apply({ mode: 'postgres', host: '', port: 5432, database: 'tlc_qa', user: '', ssl: false });
    await expect(sw.current()!.getSuite('p1')).rejects.toThrow(/host\/user belum diisi/);

    const cfg = { mode: 'postgres' as const, host: 'db.test', port: 5432, database: 'tlc_qa', user: 'tlc', ssl: false };
    await sw.apply(cfg);
    await sw.apply(cfg);
    expect(pools).toBe(1);
    expect(sw.current()?.kind).toBe('postgres');
    expect(sw.status()).toEqual({ mode: 'postgres', target: 'db.test:5432/tlc_qa' });
  });
});

describe('QaManager on the shared database', () => {
  const secrets = new Map<string, string>();
  const manager = (store: QaStore, actor = 'tl@example.test') =>
    new QaManager({
      dir,
      store: () => store,
      actor: async () => actor,
      readSecret: async (k) => secrets.get(k) ?? null,
      writeSecret: async (k, v) => (secrets.set(k, v), true),
      deleteSecret: async (k) => secrets.delete(k),
      runAi: () => ({ done: Promise.resolve({ reply: '' }), cancel: () => {} }),
    });

  it('records who saved, refuses a stale suite, and leaves secrets alone on a stale environment', async () => {
    const store = new PgQaStore(memoryDb().pool());
    const tl = manager(store);
    const qa = manager(store, 'qa@example.test');
    const loaded = await tl.saveSuite(suite());
    expect(loaded.updatedBy).toBe('tl@example.test');
    await qa.saveSuite({ ...loaded, notes: 'QA' });
    await expect(tl.saveSuite({ ...loaded, notes: 'TL' })).rejects.toThrow(/oleh qa@example\.test/);

    const [e] = await tl.saveEnvironment(env('', { name: 'Staging' }), 'token-1');
    await qa.saveEnvironment(e);
    await expect(tl.saveEnvironment(e, 'token-2')).rejects.toBeInstanceOf(QaConflictError);
    expect(secrets.get(e.id)).toBe('token-1');
    // Each user's Keychain answers for the shared environment.
    expect((await qa.listEnvironments())[0]).toMatchObject({ id: e.id, hasSecret: true, version: 2 });
  });

  it('upserts a project only when it changed', async () => {
    const store = new PgQaStore(memoryDb().pool());
    const tl = manager(store);
    const tads = [{ title: 'TAD Promo', draftId: 'd1', confluencePageId: '42', confluenceUrl: 'https://wiki.example.test/x', jiraKeys: ['PRM-1', 'bad key'] }];
    const first = await tl.upsertProject({ id: 'p1', name: 'Promo', tads });
    expect(first.tads[0].jiraKeys).toEqual(['PRM-1']);
    const again = await tl.upsertProject({ id: 'p1', name: 'Promo', tads });
    expect(again.updatedAt).toBe(first.updatedAt);
    await expect(tl.upsertProject({ id: '../x', name: 'X' })).rejects.toThrow(/Id proyek/);
  });

  it('answers a stale save over HTTP with 409 and who saved first', async () => {
    const store = new PgQaStore(memoryDb().pool());
    const tl = manager(store);
    const loaded = await tl.saveSuite(suite());
    await manager(store, 'qa@example.test').saveSuite({ ...loaded, notes: 'QA' });
    const handler = connectorMiddleware({}, { readToken: async () => null, appendAudit: async () => {}, readAudit: async () => [], logError: () => {}, qa: () => tl });
    const app: Server = createServer((req, res) => handler(req, res, () => ((res.statusCode = 404), res.end())));
    const url = await new Promise<string>((resolve) => app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(app.address() as AddressInfo).port}`)));
    try {
      const res = await fetch(`${url}/api/connector/qa/suite`, {
        method: 'POST',
        headers: { 'X-TLC-Client': '1', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
        body: JSON.stringify({ suite: { ...loaded, notes: 'TL' } }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'conflict', updatedBy: 'qa@example.test' });
      const store = await fetch(`${url}/api/connector/qa/store`, { headers: { 'X-TLC-Client': '1', Origin: 'http://127.0.0.1:5173' } });
      expect(await store.json()).toMatchObject({ mode: 'postgres' });
    } finally {
      app.close();
    }
  });
});

describe('moveToCentral', () => {
  it('backs up first, copies everything once, and never overwrites', async () => {
    const qaDir = join(dir, 'qa');
    const local = new FileQaStore(qaDir);
    await local.saveSuite(suite('p1', { notes: 'lokal' }));
    await local.savePlan(plan('p1'));
    await local.saveEnvironment(env());
    for (let i = 0; i < 3; i++) await local.saveRun(run(i));
    await local.saveSuite(suite('p2', { projectName: 'Lain' }));
    // Already central with other content: left alone and reported.
    const central = new PgQaStore(memoryDb().pool());
    await central.saveSuite(suite('p2', { projectName: 'Lain', notes: 'dari QA' }), 'qa');

    const backupRoot = join(dir, 'qa-backups');
    const result = await moveToCentral(local, central, { backupRoot, by: 'tl', now: new Date('2026-10-22T05:00:00Z') });
    expect(result).toMatchObject({ suites: 1, plans: 1, environments: 1, runs: 3, projects: 1 });
    expect(result.skipped).toEqual([expect.stringMatching(/Test case Lain: sudah ada di DB pusat/)]);
    expect(result.backupDir).toBe(join(backupRoot, '2026-10-22T05-00-00-000Z-before-central'));
    expect(await readdir(join(result.backupDir, 'suites'))).toEqual(expect.arrayContaining(['p1.json', 'p2.json']));
    expect((await central.getSuite('p1'))?.notes).toBe('lokal');
    expect((await central.getSuite('p2'))?.notes).toBe('dari QA');
    expect(await central.listRuns('p1')).toHaveLength(3);
    // Local files stay.
    expect(JSON.parse(await readFile(local.suiteFile('p1'), 'utf8')).notes).toBe('lokal');

    // Again: nothing new to copy, the same content is not reported.
    const again = await moveToCentral(local, central, { backupRoot, by: 'tl', now: new Date('2026-10-22T06:00:00Z') });
    expect(again).toMatchObject({ suites: 0, plans: 0, environments: 0, runs: 0, projects: 0 });
    expect(again.skipped).toHaveLength(1);
  });

  it('says so when there is no local data', async () => {
    await expect(moveToCentral(new FileQaStore(join(dir, 'none')), new PgQaStore(memoryDb().pool()), { backupRoot: join(dir, 'b') })).rejects.toThrow(/Tidak ada data E2E lokal/);
  });

  it('moves nothing when the backup fails', async () => {
    const local = new FileQaStore(join(dir, 'qa'));
    await local.saveSuite(suite());
    const backupRoot = join(dir, 'qa-backups');
    const stamp = new Date('2026-10-22T05:00:00Z');
    await mkdir(join(backupRoot, '2026-10-22T05-00-00-000Z-before-central'), { recursive: true });
    await writeFile(join(backupRoot, '2026-10-22T05-00-00-000Z-before-central', 'suites'), 'x');
    const central = new PgQaStore(memoryDb().pool());
    await expect(moveToCentral(local, central, { backupRoot, now: stamp })).rejects.toThrow();
    expect(await central.getSuite('p1')).toBeNull();
  });
});
