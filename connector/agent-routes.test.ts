// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRuntime } from './agent-runtime.ts';
import { AgentTaskStore, type AgentTask } from './agent-tasks.ts';
import { connectorMiddleware } from './dev-connector.ts';
import { syncTraceTurn } from './trace/agent-sync.ts';
import { TraceManager } from './trace/manager.ts';

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

describe('connector /agent-tasks routes (local coding agents)', () => {
  let dir = '';
  let app: Server;
  let appUrl = '';
  let store: AgentTaskStore;
  let runtimeCalls = 0;
  let localId = '';
  let legacyId = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-agent-routes-'));
    store = new AgentTaskStore({ dir });
    localId = (await store.create({ prompt: 'implement', title: 'Local run', kind: 'implement', runner: 'local', status: 'queued' })).task.id;
    legacyId = (await store.create({ prompt: 'old', title: 'Legacy remote task', runner: 'hermes', status: 'queued' })).task.id;
    const runtime: AgentRuntime = { store };
    const handler = connectorMiddleware({}, {
      readToken: async () => null,
      appendAudit: async () => {},
      readAudit: async () => [],
      logError: () => {},
      agentRuntime: () => (runtimeCalls++, runtime),
    });
    app = createServer((req, res) => handler(req, res, () => ((res.statusCode = 404), res.end())));
    appUrl = await listen(app);
  });

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`${appUrl}/api/connector${path}`, {
      method: init.json !== undefined ? 'POST' : 'GET',
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      ...init,
      headers: { 'X-TLC-Client': '1', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json', ...init.headers },
    });

  it('rejects requests without the client header or from another origin', async () => {
    const before = runtimeCalls;
    expect((await call('/agent-tasks', { headers: { 'X-TLC-Client': '' } })).status).toBe(403);
    expect((await call(`/agent-tasks/${localId}/complete`, { json: {}, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    const noOrigin = await fetch(`${appUrl}/api/connector/agent-tasks/${localId}/complete`, { method: 'POST', headers: { 'X-TLC-Client': '1' }, body: '{}' });
    expect(noOrigin.status).toBe(403);
    expect(runtimeCalls).toBe(before); // rejected before the runtime is touched
  });

  it('lists only local tasks and hides leftovers from the removed remote runner', async () => {
    const res = await call('/agent-tasks');
    expect(res.status).toBe(200);
    const { tasks } = await res.json();
    expect(tasks.map((t: { id: string }) => t.id)).toEqual([localId]);
    expect((await call('/agent-tasks?limit=999999')).status).toBe(400);
  });

  it('no longer exposes the Hermes routes or task creation', async () => {
    // Falls through to the generic connector routes (here: unconfigured), never to an agent runtime.
    const before = runtimeCalls;
    expect((await call('/hermes/status')).status).not.toBe(200);
    expect(runtimeCalls).toBe(before);
    expect((await call('/agent-tasks', { json: { prompt: 'x' } })).status).toBe(404);
  });

  it('returns a local task with its events, and 404 for hidden or unknown ones', async () => {
    const res = await call(`/agent-tasks/${localId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ task: { id: localId, runner: 'local' }, events: [] });
    expect((await call(`/agent-tasks/${legacyId}`)).status).toBe(404);
    expect((await call('/agent-tasks/not a valid id')).status).toBe(400);
  });

  it('marks a local task completed and refuses actions it does not support', async () => {
    expect((await call(`/agent-tasks/${localId}/retry`, { json: {} })).status).toBe(409);
    expect((await call(`/agent-tasks/${localId}/steer`, { json: { message: 1 } })).status).toBe(400);
    const done = await call(`/agent-tasks/${localId}/complete`, { json: { message: 'Selesai manual' } });
    expect(done.status).toBe(200);
    expect((await done.json()).task).toMatchObject({ status: 'completed', progress: { message: 'Selesai manual' } });
    expect((await call(`/agent-tasks/${legacyId}/complete`, { json: {} })).status).toBe(404);
  });
});

describe('connector /traces routes and trace tasks in Agent Tasks', () => {
  let dir = '';
  let app: Server;
  let appUrl = '';
  let store: AgentTaskStore;
  const pending: ((v: { reply: string; error?: string }) => void)[] = [];
  const answer = (text: string) => JSON.stringify({ answer: text, confidence: 'high', evidence: [], findings: [] });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-trace-routes-'));
    store = new AgentTaskStore({ dir: join(dir, 'tasks') });
    const traces = new TraceManager({
      dir: join(dir, 'traces'),
      resolveServicesRoot: async () => dir,
      runAi: () => ({ done: new Promise((r) => pending.push(r)), cancel: () => pending.shift()?.({ reply: '', error: 'killed' }) }),
      sink: (t, turn) => syncTraceTurn(store, t, turn),
      versions: async () => [],
    });
    const handler = connectorMiddleware({}, {
      readToken: async () => null,
      appendAudit: async () => {},
      readAudit: async () => [],
      logError: () => {},
      agentRuntime: () => ({ store }),
      traceManager: () => traces,
    });
    app = createServer((req, res) => handler(req, res, () => ((res.statusCode = 404), res.end())));
    appUrl = await listen(app);
  });

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const call = (path: string, json?: unknown) =>
    fetch(`${appUrl}/api/connector${path}`, {
      method: json === undefined ? 'GET' : 'POST',
      body: json === undefined ? undefined : JSON.stringify(json),
      headers: { 'X-TLC-Client': '1', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
    });

  async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    for (let i = 0; i < 500; i++) {
      const v = await fn();
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('condition not reached');
  }
  /** The AI run starts just after the 202; wait for it before answering. */
  const nextRun = async () => (await until(async () => pending.length, (n) => n > 0), pending.shift()!);
  const taskOf = async (traceId: string) => (await store.list()).filter((t) => t.links?.traceId === traceId);

  it('starts a trace in the background and lists it as a local trace task', async () => {
    expect((await call('/traces', { question: 'Alur refund?', ai: 'bad' })).status).toBe(400);
    const res = await call('/traces', { question: 'Alur refund?', ai: { provider: 'claude', model: 'sonnet' } });
    expect(res.status).toBe(202);
    const trace = await res.json();
    expect(trace.turns[0].status).toBe('running');

    const list = await (await call('/agent-tasks')).json();
    const task = list.tasks.find((t: AgentTask) => t.links?.traceId === trace.id);
    expect(task).toMatchObject({ kind: 'trace', runner: 'local', status: 'running' });

    // A follow-up while running is refused; the answer then completes the task.
    expect((await call(`/agent-tasks/${task.id}/steer`, { message: 'lagi' })).status).toBe(409);
    (await nextRun())({ reply: answer('Lewat callback.') });
    await until(() => taskOf(trace.id), (ts) => ts[0]?.status === 'completed');

    const detail = await (await call(`/agent-tasks/${task.id}`)).json();
    expect(detail.trace.turns[0]).toMatchObject({ status: 'done', answer: 'Lewat callback.' });
  });

  it('asks a follow-up through Agent Tasks and can cancel it', async () => {
    const trace = await (await call('/traces', { question: 'Alur settlement?', ai: { provider: 'claude', model: 'sonnet' } })).json();
    (await nextRun())({ reply: answer('Batch harian.') });
    const [first] = await until(() => taskOf(trace.id), (ts) => ts[0]?.status === 'completed');

    expect((await call(`/agent-tasks/${first.id}/steer`, { message: 'Jam berapa?' })).status).toBe(200);
    const tasks = await until(() => taskOf(trace.id), (ts) => ts.length === 2);
    const followUp = tasks.find((t) => t.id !== first.id)!;
    expect(followUp.title).toBe('Lanjutan · Jam berapa?');

    await until(async () => pending.length, (n) => n > 0);
    expect((await call(`/agent-tasks/${followUp.id}/cancel`, {})).status).toBe(200);
    await until(() => store.get(followUp.id), (t) => t?.status === 'cancelled');
    expect((await call(`/agent-tasks/${followUp.id}/retry`, {})).status).toBe(409);
  });
});
