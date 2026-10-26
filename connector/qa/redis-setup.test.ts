// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QAEnvironment, QAFlow, QARedis } from '../../src/lib/qa/types.ts';
import { flowVariables } from '../../src/lib/qa/requirements.ts';
import { normalizeEditedFlow, redisSection } from './generator.ts';
import { QaManager, validateEnvironment } from './manager.ts';
import { runFlow } from './runner.ts';

const env: QAEnvironment = { id: 'dev', name: 'Dev', baseUrl: 'http://api.dev', services: {}, headers: {}, variables: { svc: 'BILLER' }, auth: { type: 'none' }, readOnly: false, timeoutMs: 5_000 };

const flow = (step: Partial<QAFlow['steps'][number]>): QAFlow =>
  ({
    id: 'f',
    name: 'Inquiry berpromo',
    description: '',
    category: 'happy-path',
    taskTitles: [],
    enabled: true,
    steps: [{ id: 's', name: 'Inquiry', request: { method: 'GET', path: '/inquiry' }, assertions: [{ type: 'status', op: 'equals', expected: 200 }], ...step }],
  }) as QAFlow;

describe('Redis key deletion before a step', () => {
  it('deletes the keys after the DB setup and before the request, only where allowed', async () => {
    const order: string[] = [];
    const f = flow({ setup: [{ db: 'promo', sql: "UPDATE promo SET start_date = now() WHERE uuid = 'p'" }], redisDel: [{ redis: 'promo', keys: ['promo:active:{{svc}}', 'promo:active:ver:{{svc}}'] }] });
    const fetch = (async () => (order.push('request'), new Response('{}', { status: 200 }))) as unknown as typeof globalThis.fetch;
    const execute = async (db: string, sql: string) => (order.push(`setup ${db}`), { db, sql, columns: [], rows: [], rowCount: 1, durationMs: 1 });
    const redisDel = async (redis: string, keys: string[]) => (order.push(`del ${redis}: ${keys.join(' ')}`), 1);
    const ok = await runFlow(f, 0, { env, fetch, execute, redisDel });
    expect(ok.status).toBe('passed');
    expect(order).toEqual(['setup promo', 'del promo: promo:active:BILLER promo:active:ver:BILLER', 'request']);
    expect(ok.steps[0].dbSetup?.[1]).toMatchObject({ kind: 'setup', redis: true, ok: true, db: 'promo', sql: 'DEL promo:active:BILLER promo:active:ver:BILLER', value: '1 dari 2 key dihapus' });

    // Not allowed on this environment: the step fails and sends nothing.
    order.length = 0;
    const refused = await runFlow(flow({ redisDel: [{ redis: 'promo', keys: ['k'] }] }), 0, { env, fetch });
    expect(refused.steps[0].status).toBe('error');
    expect(refused.steps[0].error).toContain('Hapus key Redis tidak dijalankan');
    expect(order).toEqual([]);
  });

  it('stops on a key with a missing variable or a failed deletion', async () => {
    const fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch;
    const missing = await runFlow(flow({ redisDel: [{ redis: 'promo', keys: ['promo:active:{{nope}}'] }] }), 0, { env, fetch, redisDel: async () => 1 });
    expect(missing.steps[0].error).toContain('{{nope}}');
    const failed = await runFlow(flow({ redisDel: [{ redis: 'promo', keys: ['k'] }] }), 0, { env, fetch, redisDel: async () => Promise.reject(new Error('Redis "promo": WRONGPASS')) });
    expect(failed.steps[0].error).toContain('WRONGPASS');
  });

  it('keeps valid Redis entries in saved flows, counts their variables and tells agents about them', () => {
    const f = normalizeEditedFlow({ id: 'f', name: 'x', steps: [{ id: 's', name: 's', request: { method: 'GET', path: '/x' }, redisDel: [{ redis: 'promo', keys: ['promo:active:{{svc}}'] }, { redis: 'promo', keys: ['promo:*'] }, { redis: '', keys: ['k'] }] }] });
    expect(f.steps[0].redisDel).toEqual([{ redis: 'promo', keys: ['promo:active:{{svc}}'] }]);
    expect([...flowVariables(f)]).toContain('svc');
    expect(redisSection([{ name: 'CORE-PROMO-ULTIMATE' }])).toContain('"redisDel"');
    expect(redisSection([])).toBe('');
  });

  it('validates Redis per service on the environment', () => {
    expect(validateEnvironment({ name: 'Dev', baseUrl: 'http://dev', redis: [{ name: '', service: 'core-promo-ultimate', host: 'redis.dev', db: 2 }] }).redis).toEqual([{ name: 'core-promo-ultimate', service: 'core-promo-ultimate', host: 'redis.dev', port: 6379, db: 2 }]);
    expect(validateEnvironment({ name: 'Dev', baseUrl: 'http://dev' }).redis).toBeUndefined();
    expect(() => validateEnvironment({ name: 'Dev', baseUrl: 'http://dev', redis: [{ name: 'promo', host: 'bad host' }] })).toThrow('host');
    expect(() => validateEnvironment({ name: 'Dev', baseUrl: 'http://dev', redis: [{ name: 'promo', host: 'r', db: 16 }] })).toThrow('0–15');
  });
});

describe('QaManager Redis', () => {
  let dir = '';
  const secrets = new Map<string, string>();
  const calls: { conn: QARedis; password?: string; keys: string[] }[] = [];
  const manager = () =>
    new QaManager({
      dir,
      readSecret: async (k) => secrets.get(k) ?? null,
      writeSecret: async (k, v) => (secrets.set(k, v), true),
      deleteSecret: async (k) => secrets.delete(k),
      runAi: () => ({ done: Promise.resolve({ reply: '{}' }), cancel: () => {} }),
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch,
      redis: {
        del: async (conn, password, keys) => (calls.push({ conn, password, keys }), keys.length),
        test: async (conn, password) => `Redis 7 (${conn.host}, pw:${password ? 'yes' : 'no'})`,
      },
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-qa-redis-'));
    secrets.clear();
    calls.length = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const base = { ...env, id: '', dbWrites: true, redis: [{ name: 'CORE-PROMO-ULTIMATE', service: 'CORE-PROMO-ULTIMATE', host: 'redis.dev', port: 6379 }] };

  it('keeps Redis passwords in the Keychain, tests the connection and deletes keys during a run', async () => {
    const m = manager();
    const [saved] = await m.saveEnvironment(base, undefined, undefined, undefined, undefined, { 'CORE-PROMO-ULTIMATE': 'r3dis' });
    expect(saved.redisPasswords).toEqual({ 'CORE-PROMO-ULTIMATE': true });
    expect(await readFile(join(dir, 'environments.json'), 'utf8')).not.toContain('r3dis');
    expect(await m.testRedisConnection(saved.id, 'core-promo-ultimate')).toBe('Redis 7 (redis.dev, pw:yes)');

    await m.saveSuite({ projectId: 'proj', projectName: 'P', updatedAt: '', flows: [flow({ redisDel: [{ redis: 'CORE-PROMO-ULTIMATE', keys: ['promo:active:{{svc}}'] }] })] });
    const run = await m.startRun({ projectId: 'proj', environmentId: saved.id });
    for (let i = 0; i < 500 && (await m.getRun('proj', run.id))?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([{ conn: expect.objectContaining({ host: 'redis.dev' }), password: 'r3dis', keys: ['promo:active:BILLER'] }]);

    // A removed Redis loses its password.
    await m.saveEnvironment({ ...saved, redis: [] });
    expect(secrets.has(`${saved.id}:redis:CORE-PROMO-ULTIMATE`)).toBe(false);
  });

  it('does not delete keys without dbWrites', async () => {
    const m = manager();
    const [saved] = await m.saveEnvironment({ ...base, dbWrites: false });
    await m.saveSuite({ projectId: 'proj', projectName: 'P', updatedAt: '', flows: [flow({ redisDel: [{ redis: 'CORE-PROMO-ULTIMATE', keys: ['k'] }] })] });
    const run = await m.startRun({ projectId: 'proj', environmentId: saved.id });
    for (let i = 0; i < 500 && (await m.getRun('proj', run.id))?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
    expect((await m.getRun('proj', run.id))?.flows[0].steps[0].status).toBe('error');
  });
});
