// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QAEnvironment, QAFlow } from '../../src/lib/qa/types.ts';
import { buildQaPrompt, extractJson, normalizeEditedFlow, parseQaReply, repairJson } from './generator.ts';
import { QaManager, validateEnvironment } from './manager.ts';
import { checkAssertion, interpolate, jsonPath, runFlow } from './runner.ts';

const env: QAEnvironment = {
  id: 'dev',
  name: 'Dev',
  baseUrl: 'https://api.dev.test',
  services: { 'order-service': 'https://order.dev.test/api' },
  headers: { 'Content-Type': 'application/json' },
  variables: { username: 'qa-user' },
  auth: { type: 'bearer' },
  readOnly: false,
  timeoutMs: 5_000,
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(handler: (c: Call) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const call = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined };
    calls.push(call);
    const r = handler(call);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const loginThenOrder: QAFlow = {
  id: 'f1',
  name: 'Login lalu buat order',
  description: '',
  category: 'integration-chain',
  taskTitles: ['[BACKEND][ORDER][X] - Create order'],
  variables: { amount: '10000' },
  enabled: true,
  steps: [
    {
      id: 's1',
      name: 'Login',
      useEnvAuth: false,
      request: { method: 'POST', path: '/auth/login', body: { username: '{{username}}' } },
      extract: { accessToken: '$.data.accessToken' },
      assertions: [
        { type: 'status', op: 'equals', expected: 200 },
        { type: 'json', path: '$.data.accessToken', op: 'exists' },
      ],
    },
    {
      id: 's2',
      name: 'Buat order',
      service: 'Order-Service',
      request: { method: 'POST', path: '/v1/orders', headers: { Authorization: 'Bearer {{accessToken}}' }, body: { amount: '{{amount}}', ref: 'E2E-{{$timestamp}}' } },
      extract: { orderId: '$.data.id' },
      assertions: [
        { type: 'status', op: 'in', expected: [200, 201] },
        { type: 'json', path: '$.data.status', op: 'equals', expected: 'PENDING' },
      ],
    },
    {
      id: 's3',
      name: 'Cek order',
      service: 'order-service',
      request: { method: 'GET', path: '/v1/orders/{{orderId}}' },
      assertions: [{ type: 'json', path: '$.data.items[0].sku', op: 'equals', expected: 'A1' }],
    },
  ],
};

describe('runner helpers', () => {
  it('interpolates variables and built-ins, reporting unknown names', () => {
    const missing = new Set<string>();
    expect(interpolate('/o/{{id}}/{{ nope }}', { id: '7' }, missing)).toBe('/o/7/{{ nope }}');
    expect([...missing]).toEqual(['nope']);
    expect(interpolate('{{$uuid}}', {})).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads JSON paths with indexes', () => {
    const data = { a: { b: [{ c: 1 }, { c: null }] } };
    expect(jsonPath(data, '$.a.b[0].c')).toEqual({ found: true, value: 1 });
    expect(jsonPath(data, '$.a.b[1].c')).toEqual({ found: true, value: null });
    expect(jsonPath(data, '$.a.x').found).toBe(false);
  });

  it('checks assertions', () => {
    const res = { status: 201, headers: { 'Content-Type': 'application/json' }, json: { data: { n: 5, tags: ['x'] } }, durationMs: 120 };
    expect(checkAssertion({ type: 'status', op: 'in', expected: [200, 201] }, res).passed).toBe(true);
    expect(checkAssertion({ type: 'json', path: '$.data.n', op: 'gt', expected: 3 }, res).passed).toBe(true);
    expect(checkAssertion({ type: 'json', path: '$.data.tags', op: 'contains', expected: 'x' }, res).passed).toBe(true);
    expect(checkAssertion({ type: 'json', path: '$.data.n', op: 'type', expected: 'number' }, res).passed).toBe(true);
    expect(checkAssertion({ type: 'json', path: '$.data.gone', op: 'not_exists' }, res).passed).toBe(true);
    expect(checkAssertion({ type: 'header', name: 'content-type', op: 'contains', expected: 'json' }, res).passed).toBe(true);
    expect(checkAssertion({ type: 'latency', op: 'lt', expected: 100 }, res).passed).toBe(false);
  });
});

describe('runFlow', () => {
  it('chains extracted values across services and masks secrets', async () => {
    const { f, calls } = fakeFetch((c) => {
      if (c.url.endsWith('/auth/login')) return { status: 200, body: { data: { accessToken: 'tok-abcdef123' } } };
      if (c.method === 'POST') return { status: 201, body: { data: { id: 'ord-9', status: 'PENDING' } } };
      return { status: 200, body: { data: { items: [{ sku: 'A1' }] } } };
    });
    const result = await runFlow(loginThenOrder, 0, { env, secret: 'env-secret-xyz', fetch: f });
    expect(result.status).toBe('passed');
    expect(calls.map((c) => c.url)).toEqual(['https://api.dev.test/auth/login', 'https://order.dev.test/api/v1/orders', 'https://order.dev.test/api/v1/orders/ord-9']);
    // Login skips env auth; the order call uses the extracted token; numbers stay numbers.
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[1].headers.Authorization).toBe('Bearer tok-abcdef123');
    expect(JSON.parse(calls[1].body!).amount).toBe(10000);
    expect(calls[2].headers.Authorization).toBe('Bearer env-secret-xyz');

    const shown = JSON.stringify(result);
    expect(shown).not.toContain('tok-abcdef123');
    expect(shown).not.toContain('env-secret-xyz');
    expect(result.steps[0].extracted).toEqual({ accessToken: '***' });
    expect(result.steps[1].curl).toContain("curl -X POST 'https://order.dev.test/api/v1/orders'");
  });

  it('lets environment variables override flow samples and resolves built-ins once', async () => {
    const { f, calls } = fakeFetch((c) => (c.method === 'POST' ? { status: 201, body: { data: { id: 'o-1' } } } : { status: 200, body: { data: { id: 'o-1' } } }));
    const flow: QAFlow = {
      ...loginThenOrder,
      variables: { username: 'sample', ref: 'E2E-{{$uuid}}' },
      steps: [
        { id: 'a', name: 'create', request: { method: 'POST', path: '/o', body: { user: '{{username}}', ref: '{{ref}}' } }, extract: { id: '$.data.id' }, assertions: [] },
        { id: 'b', name: 'get', request: { method: 'GET', path: '/o/{{id}}', query: { ref: '{{ref}}' } }, assertions: [{ type: 'json', path: '$.data.id', op: 'equals', expected: '{{id}}' }] },
      ],
    };
    const r = await runFlow(flow, 0, { env, fetch: f });
    expect(r.status).toBe('passed');
    const sent = JSON.parse(calls[0].body!);
    expect(sent.user).toBe('qa-user');
    expect(sent.ref).toMatch(/^E2E-[0-9a-f-]{36}$/);
    expect(new URL(calls[1].url).searchParams.get('ref')).toBe(sent.ref);
  });

  it('skips the remaining steps after a failure', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 500, body: { error: 'boom' } }));
    const result = await runFlow(loginThenOrder, 0, { env, fetch: f });
    expect(result.status).toBe('failed');
    expect(result.steps.map((s) => s.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(calls).toHaveLength(1);
  });

  it('blocks writes on a read-only environment and rejects hosts in paths', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const ro = await runFlow(loginThenOrder, 0, { env: { ...env, readOnly: true }, fetch: f });
    expect(ro.status).toBe('blocked');
    expect(calls).toHaveLength(0);

    const evil: QAFlow = { ...loginThenOrder, steps: [{ id: 'x', name: 'x', request: { method: 'GET', path: 'https://evil.test/x' }, assertions: [] }] };
    const r = await runFlow(evil, 0, { env, fetch: f });
    expect(r.steps[0].status).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('reports variables that never got a value without sending the request', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const flow: QAFlow = { ...loginThenOrder, steps: [{ id: 'x', name: 'x', request: { method: 'GET', path: '/o/{{orderId}}' }, assertions: [] }] };
    const r = await runFlow(flow, 0, { env, fetch: f });
    expect(r.steps[0].error).toContain('{{orderId}}');
    expect(calls).toHaveLength(0);
  });
});

describe('generator', () => {
  const reply = `Berikut hasilnya:
\`\`\`json
{"notes":"Asumsi: OTP dimock","flows":[
  {"name":"Happy","category":"happy-path","taskTitles":["T1"],"steps":[
    {"name":"Get","service":"svc","request":{"method":"get","path":"https://host.test/v1/items?x=1"},"assertions":[{"type":"json","path":"data.id","op":"exists"}]},
    {"name":"Bad","request":{"method":"TRACE","path":"/x"}}
  ]},
  {"name":"Kosong","steps":[]}
]}
\`\`\``;

  it('parses fenced JSON, drops invalid steps/flows and strips hosts', () => {
    const { flows, notes } = parseQaReply(reply, ['T1']);
    expect(notes).toBe('Asumsi: OTP dimock');
    expect(flows).toHaveLength(1);
    const [step] = flows[0].steps;
    expect(flows[0].steps).toHaveLength(1);
    expect(step.request.method).toBe('GET');
    expect(step.request.path).toBe('/v1/items?x=1');
    // A status assertion is always added, JSON paths get a $ prefix.
    expect(step.assertions[0]).toEqual({ type: 'status', op: 'in', expected: [200, 201] });
    expect(step.assertions[1]).toMatchObject({ type: 'json', path: '$.data.id', op: 'exists' });
  });

  it('repairs bare variables and trailing commas', () => {
    const fixed = extractJson('{"flows":[{"name":"x","variables":{},"steps":[{"request":{"method":"POST","path":"/o","body":{"amount": {{amount}}, "ids":[{{id}}],}}}]}]}') as { flows: { steps: { request: { body: unknown } }[] }[] };
    expect(fixed.flows[0].steps[0].request.body).toEqual({ amount: '{{amount}}', ids: ['{{id}}'] });
    // Variables inside strings are untouched.
    expect(repairJson('{"path":"/o/{{id}}"}')).toBe('{"path":"/o/{{id}}"}');
  });

  it('fails clearly without JSON or flows', () => {
    expect(() => extractJson('maaf, tidak bisa')).toThrow('tidak berisi JSON');
    expect(() => parseQaReply('{"flows":[]}', [])).toThrow('tidak menghasilkan flow');
  });

  it('keeps ids of hand-edited flows', () => {
    const flow = normalizeEditedFlow({ ...loginThenOrder, enabled: false });
    expect(flow.id).toBe('f1');
    expect(flow.enabled).toBe(false);
    expect(flow.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('builds a prompt with the tasks, categories and existing flows', () => {
    const prompt = buildQaPrompt({
      projectId: 'd',
      projectName: 'TAD QRIS',
      ai: { provider: 'claude', model: '' },
      tasks: [{ title: 'T1', service: 'svc', spec: 'Endpoint: /v1/pay' }],
      categories: ['auth'],
      existing: [loginThenOrder],
      instructions: 'Fokus refund',
    });
    expect(prompt).toContain('### Task 1: T1');
    expect(prompt).toContain('Endpoint: /v1/pay');
    expect(prompt).toContain('auth (Auth & akses)');
    expect(prompt).not.toContain('happy-path (Happy path)');
    expect(prompt).toContain('- Login lalu buat order [integration-chain]');
    expect(prompt).toContain('Fokus refund');
  });
});

describe('QaManager', () => {
  let dir = '';
  const secrets = new Map<string, string>();
  let aiReply = '';
  const manager = () =>
    new QaManager({
      dir,
      readSecret: async (id) => secrets.get(id) ?? null,
      writeSecret: async (id, v) => (secrets.set(id, v), true),
      deleteSecret: async (id) => secrets.delete(id),
      runAi: () => ({ done: Promise.resolve({ reply: aiReply }), cancel: () => {} }),
      fetch: fakeFetch(() => ({ status: 200, body: { data: { accessToken: 'tok-123456', id: 'o1', status: 'PENDING', items: [{ sku: 'A1' }] } } })).f,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-qa-test-'));
    secrets.clear();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const until = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('validates environments and keeps secrets out of the file', async () => {
    expect(() => validateEnvironment({ name: '' })).toThrow('Nama');
    expect(() => validateEnvironment({ name: 'x', baseUrl: 'ftp://x' })).toThrow('http');
    expect(() => validateEnvironment({ name: 'x' })).toThrow('base URL');
    const qa = manager();
    const [saved] = await qa.saveEnvironment({ ...env, id: '' }, 'super-secret');
    expect(saved.id).toMatch(/^dev-/);
    expect(saved.hasSecret).toBe(true);
    const file = await import('node:fs/promises').then((m) => m.readFile(join(dir, 'environments.json'), 'utf8'));
    expect(file).not.toContain('super-secret');
    await qa.saveEnvironment(saved, '');
    expect((await qa.listEnvironments())[0].hasSecret).toBe(false);

    // Secret variables: stored outside the file, empty value keeps the stored one, removed lines go.
    await qa.saveEnvironment({ ...saved, variables: { username: 'qa-user', password: 'plain' } }, undefined, { password: 'p@ss-1234', pin: '123456' });
    let [e] = await qa.listEnvironments();
    expect(e.secretVariableNames).toEqual(['password', 'pin']);
    expect(e.variables).toEqual({ username: 'qa-user' });
    await qa.saveEnvironment(e, undefined, { password: '' });
    [e] = await qa.listEnvironments();
    expect(e.secretVariableNames).toEqual(['password']);
    expect(secrets.get(`${e.id}:vars`)).toBe(JSON.stringify({ password: 'p@ss-1234' }));
    const after = await import('node:fs/promises').then((m) => m.readFile(join(dir, 'environments.json'), 'utf8'));
    expect(after).not.toContain('p@ss-1234');
  });

  it('uses and masks secret variables during a run', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: { echo: 'p@ss-1234' } }));
    const flow: QAFlow = { ...loginThenOrder, steps: [{ id: 'a', name: 'login', useEnvAuth: false, request: { method: 'POST', path: '/login', body: { password: '{{password}}' } }, assertions: [] }] };
    const r = await runFlow(flow, 0, { env: { ...env, variables: { password: 'plain' } }, secretVariables: { password: 'p@ss-1234' }, fetch: f });
    expect(JSON.parse(calls[0].body!).password).toBe('p@ss-1234');
    expect(JSON.stringify(r)).not.toContain('p@ss-1234');
  });

  it('generates a suite, runs it in the background and keeps the run', async () => {
    const qa = manager();
    aiReply = JSON.stringify({ flows: [loginThenOrder] });
    const job = await qa.generate({ projectId: 'draft-1', projectName: 'TAD', ai: { provider: 'claude', model: '' }, tasks: [{ title: 'T', spec: 's' }], categories: [] });
    await until(() => qa.getJob(job.id)?.status !== 'running');
    expect(qa.getJob(job.id)?.status).toBe('done');
    expect((await qa.getSuite('draft-1'))?.flows).toHaveLength(1);

    const [e] = await qa.saveEnvironment({ ...env, id: '' }, 'env-token-1');
    const run = await qa.startRun({ projectId: 'draft-1', environmentId: e.id });
    await until(async () => (await qa.getRun('draft-1', run.id))?.status === 'done');
    const done = await qa.getRun('draft-1', run.id);
    expect(done?.summary).toMatchObject({ flows: 1, passedFlows: 1, steps: 3, passedSteps: 3 });
    expect((await qa.listRuns('draft-1')).map((r) => r.id)).toEqual([run.id]);
    // Stored on disk too (a fresh manager still sees it).
    expect((await manager().getRun('draft-1', run.id))?.status).toBe('done');
  });

  it('lets a project adopt the per-TAD suites and runs from before projects existed', async () => {
    const qa = manager();
    const legacy = (id: string, name: string) => ({ draftId: id, tadTitle: `TAD ${id}`, flows: [{ ...loginThenOrder, id: `f-${id}`, name }], updatedAt: '2026-10-01T00:00:00.000Z' });
    await mkdir(join(dir, 'suites'), { recursive: true });
    await writeFile(join(dir, 'suites', 'tad-a.json'), JSON.stringify(legacy('tad-a', 'Flow A')));
    await writeFile(join(dir, 'suites', 'tad-b.json'), JSON.stringify(legacy('tad-b', 'Flow B')));
    await mkdir(join(dir, 'runs', 'tad-a'), { recursive: true });
    await writeFile(join(dir, 'runs', 'tad-a', 'r1.json'), JSON.stringify({ id: 'r1', status: 'done' }));

    const suite = await qa.adoptLegacy('proj-1', 'Proyek X', ['tad-a', 'tad-b', 'tad-none']);
    expect(suite?.projectName).toBe('Proyek X');
    expect(suite?.flows.map((f) => f.name)).toEqual(['Flow A', 'Flow B']);
    expect(await readdir(join(dir, 'suites', 'migrated'))).toEqual(['tad-a.json', 'tad-b.json']);
    expect(await readdir(join(dir, 'runs', 'proj-1'))).toEqual(['r1.json']);
    // Once the project has a suite, nothing is adopted again.
    expect((await qa.adoptLegacy('proj-1', 'Proyek X', ['tad-a']))?.flows).toHaveLength(2);
    expect(await qa.adoptLegacy('proj-2', 'Lain', ['tad-a'])).toBeNull();
  });

  it('reports AI failures on the job', async () => {
    const qa = manager();
    aiReply = 'bukan json';
    const job = await qa.generate({ projectId: 'draft-2', projectName: 'TAD', ai: { provider: 'claude', model: '' }, tasks: [{ title: 'T', spec: 's' }], categories: [] });
    await until(() => qa.getJob(job.id)?.status !== 'running');
    expect(qa.getJob(job.id)).toMatchObject({ status: 'error', error: expect.stringContaining('JSON') });
    await expect(qa.startRun({ projectId: 'draft-2', environmentId: 'x' })).rejects.toThrow('Belum ada skenario');
  });
});
