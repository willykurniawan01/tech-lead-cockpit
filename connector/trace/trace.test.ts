// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiSelection } from '../../src/lib/ai/types.ts';
import type { Trace } from '../../src/lib/trace/types.ts';
import { AgentTaskStore } from '../agent-tasks.ts';
import { syncTraceTurn } from './agent-sync.ts';
import { TraceManager, type TraceDeps } from './manager.ts';
import { buildTracePrompt, parseTraceReply } from './prompt.ts';
import { verifyEvidence } from './verify.ts';

const AI: AiSelection = { provider: 'claude', model: 'sonnet' };

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: 'Alur refund',
    answer: 'Refund dimulai dari callback. Lalu saldo dikembalikan.\n\n1. Handler menerima callback',
    confidence: 'high',
    services: ['core-payment', 'bad name'],
    diagram: '```mermaid\nsequenceDiagram\nA->>B: refund\n```',
    evidence: [
      { file: 'core-payment/refund.go', line: 3, note: 'handler' },
      { file: '../etc/passwd', line: 1, note: 'x' },
      { file: '/abs/root/core-payment/refund.go', line: 2, note: 'abs' },
    ],
    findings: [{ kind: 'bug', severity: 'high', title: 'Refund dobel', detail: 'Tidak idempotent', file: 'core-payment/refund.go', line: 4 }, { kind: 'x', title: '' }],
    openQuestions: ['Timeout berapa?'],
    ...over,
  });

describe('trace prompt and parsing', () => {
  it('builds a read-only prompt with the earlier answers of the thread', () => {
    const p = buildTracePrompt('Kalau timeout?', {
      servicesRoot: '/svc',
      history: [{ id: '1', question: 'Alur refund?', askedAt: '', ai: AI, status: 'done', answer: 'Lewat callback.' }],
    });
    expect(p).toContain('JANGAN mengubah kode');
    expect(p).toContain('"/svc"');
    expect(p).toContain('Lewat callback.');
    expect(p.trim().endsWith('Kalau timeout?')).toBe(true);
  });

  it('validates the JSON: safe relative paths only, known enums, diagram without fences', () => {
    const r = parseTraceReply(`Berikut:\n${reply()}`, '/abs/root');
    expect(r.evidence.map((e) => e.file)).toEqual(['core-payment/refund.go', 'core-payment/refund.go']);
    expect(r.evidence.every((e) => !e.verified)).toBe(true);
    expect(r.services).toEqual(['core-payment']);
    expect(r.diagram).toBe('sequenceDiagram\nA->>B: refund');
    expect(r.findings).toHaveLength(1);
    expect(r.confidence).toBe('high');
    expect(parseTraceReply(reply({ confidence: 'yakin' }), '/r').confidence).toBe('medium');
    expect(() => parseTraceReply('tidak tahu', '/r')).toThrow('JSON');
    expect(() => parseTraceReply(reply({ answer: '' }), '/r')).toThrow('penjelasan');
  });
});

describe('evidence verification', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlc-trace-svc-'));
    await mkdir(join(root, 'core-payment'));
    await writeFile(join(root, 'core-payment', 'refund.go'), 'package refund\n\nfunc Refund() {\n  pay()\n}\n');
    await writeFile(join(tmpdir(), 'tlc-trace-outside.txt'), 'secret\n');
    await symlink(join(tmpdir(), 'tlc-trace-outside.txt'), join(root, 'core-payment', 'link.txt'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('marks evidence verified only when the file is inside the root and the line exists', async () => {
    const out = await verifyEvidence(root, [
      { file: 'core-payment/refund.go', line: 3, note: '', verified: false },
      { file: 'core-payment/refund.go', line: 99, note: '', verified: false },
      { file: 'core-payment/missing.go', line: 1, note: '', verified: false },
      { file: 'core-payment/link.txt', line: 1, note: '', verified: false },
      { file: 'core-payment/refund.go', note: '', verified: false },
    ]);
    expect(out.map((e) => e.verified)).toEqual([true, false, false, false, true]);
    expect(out[0].snippet).toContain('▶ func Refund() {');
    expect(out[0].snippet).toContain('pay()');
    expect(out[3].snippet).toBeUndefined();
  });
});

describe('TraceManager', () => {
  let dir = '';
  let root = '';
  let store: AgentTaskStore;
  let replies: { reply: string; error?: string }[];
  let resolvers: ((v: { reply: string; error?: string }) => void)[];
  let prompts: string[];
  let cancelled = 0;

  const manager = (over: Partial<TraceDeps> = {}) =>
    new TraceManager({
      dir: join(dir, 'traces'),
      resolveServicesRoot: async () => root,
      runAi: (_ai, prompt, opts) => {
        prompts.push(prompt);
        expect(opts.readOnlyDirs).toEqual([root]);
        opts.onProgress('Membaca core-payment/refund.go');
        const next = replies.shift();
        const done = next ? Promise.resolve(next) : new Promise<{ reply: string; error?: string }>((r) => resolvers.push(r));
        return { done, cancel: () => (cancelled++, resolvers.shift()?.({ reply: '', error: 'killed' })) };
      },
      sink: (t, turn) => syncTraceTurn(store, t, turn),
      versions: async (_r, repos) => [...new Set(repos)].map((repo) => ({ repo, branch: 'staging', commit: 'abc1234' })),
      ...over,
    });

  async function settle(m: TraceManager, id: string): Promise<Trace> {
    for (let i = 0; i < 500; i++) {
      const t = await m.get(id);
      if (!m.isBusy() && t.turns.every((x) => x.status !== 'running')) return t;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('trace did not settle');
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-trace-'));
    root = join(dir, 'svc');
    await mkdir(join(root, 'core-payment'), { recursive: true });
    await writeFile(join(root, 'core-payment', 'refund.go'), 'package refund\n\nfunc Refund() {\n  pay()\n}\n');
    store = new AgentTaskStore({ dir: join(dir, 'agent-tasks') });
    replies = [];
    resolvers = [];
    prompts = [];
    cancelled = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('answers in the background, verifies evidence and lists the question in Agent Tasks', async () => {
    replies.push({ reply: reply() });
    const m = manager();
    const started = await m.ask({ question: 'Gimana alur refund?\nDetail lain', ai: AI });
    expect(started.title).toBe('Gimana alur refund?');
    const t = await settle(m, started.id);
    const turn = t.turns[0];
    expect(turn.status).toBe('done');
    // The absolute path outside this root and the ../ path are dropped by the parser.
    expect(turn.evidence?.map((e) => e.verified)).toEqual([true]);
    expect(turn.versions).toEqual([{ repo: 'core-payment', branch: 'staging', commit: 'abc1234' }]);
    expect(turn.progress).toBeUndefined();

    const [task] = await store.list();
    expect(task).toMatchObject({ kind: 'trace', runner: 'local', status: 'completed', title: 'Gimana alur refund?', links: { traceId: t.id } });
    expect(task.progress?.message).toBe('Refund dimulai dari callback.');
    expect(turn.agentTaskId).toBe(task.id);
  });

  it('runs a follow-up with the earlier answer as context, as its own Agent Task', async () => {
    replies.push({ reply: reply() }, { reply: reply({ answer: 'Kalau timeout, retry 3x.' }) });
    const m = manager();
    const first = await settle(m, (await m.ask({ question: 'Alur refund?', ai: AI })).id);
    const second = await settle(m, (await m.ask({ traceId: first.id, question: 'Kalau timeout?', ai: AI })).id);
    expect(second.turns.map((t) => t.status)).toEqual(['done', 'done']);
    expect(prompts[1]).toContain('Refund dimulai dari callback.');
    const tasks = await store.list();
    expect(tasks.map((t) => t.title).sort()).toEqual(['Alur refund?', 'Lanjutan · Kalau timeout?']);
  });

  it('refuses a second question while one is running, and cancels it', async () => {
    const m = manager();
    const t = await m.ask({ question: 'Alur refund?', ai: AI });
    await expect(m.ask({ traceId: t.id, question: 'lagi', ai: AI })).rejects.toMatchObject({ status: 409 });
    expect((await store.list())[0].status).toBe('running');
    // Wait for the AI run to start, so cancelling has a process to stop.
    for (let i = 0; i < 100 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 5));
    await m.cancel(t.id);
    const done = await settle(m, t.id);
    expect(cancelled).toBe(1);
    expect(done.turns[0].status).toBe('cancelled');
    expect((await store.list())[0].status).toBe('cancelled');
  });

  it('does not start the AI when cancelled before it runs', async () => {
    let releaseWatch!: () => void;
    const m = manager({ watchRepos: () => new Promise((r) => (releaseWatch = () => r(async () => [])) ) });
    const t = await m.ask({ question: 'Alur refund?', ai: AI });
    for (let i = 0; i < 100 && !releaseWatch; i++) await new Promise((r) => setTimeout(r, 5));
    await m.cancel(t.id);
    releaseWatch();
    const done = await settle(m, t.id);
    expect(prompts).toHaveLength(0);
    expect(done.turns[0].status).toBe('cancelled');
  });

  it('keeps the raw reply when the AI answer is not valid JSON', async () => {
    replies.push({ reply: 'maaf saya tidak tahu' });
    const m = manager();
    const t = await settle(m, (await m.ask({ question: 'Alur?', ai: AI })).id);
    expect(t.turns[0]).toMatchObject({ status: 'error', rawReply: 'maaf saya tidak tahu' });
    const [task] = await store.list();
    expect(task.status).toBe('failed');
    expect(task.progress?.message).toBe('Trace gagal.');
  });

  it('closes a turn left running by a restart', async () => {
    const m = manager();
    const t = await m.ask({ question: 'Alur?', ai: AI });
    const fresh = manager(); // new process: no live job
    const after = await fresh.get(t.id);
    expect(after.turns[0].status).toBe('error');
    expect(after.turns[0].error).toContain('dimulai ulang');
    expect((await store.list())[0].status).toBe('failed');
    // Let the first manager's run finish before the temp folder is removed.
    for (let i = 0; i < 200 && !resolvers.length; i++) await new Promise((r) => setTimeout(r, 5));
    resolvers.shift()?.({ reply: reply() });
    for (let i = 0; i < 200 && m.isBusy(); i++) await new Promise((r) => setTimeout(r, 5));
  });

  it('validates input', async () => {
    const m = manager();
    await expect(m.ask({ question: '   ', ai: AI })).rejects.toThrow('wajib');
    await expect(m.ask({ question: 'x'.repeat(9_000), ai: AI })).rejects.toThrow('maksimal');
    await expect(m.get('../x')).rejects.toThrow('tidak valid');
    await expect(m.get('nope')).rejects.toMatchObject({ status: 404 });
  });
});
