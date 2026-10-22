// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QAAgentJob, QAFlow, QAGenerateRequest, QARun } from '../../src/lib/qa/types.ts';
import { QaManager } from './manager.ts';
import { buildFixPrompt, buildPlanPrompt, buildRepairPrompt, evidenceMentions, parsePlan, uncoveredTasks } from './plan.ts';

const AI = { provider: 'claude' as const, model: '' };

const PLAN = JSON.stringify({
  notes: 'kuota belum jelas',
  variables: [{ name: 'promoUuid', description: 'uuid promo', producedBy: 's1' }],
  stages: [
    {
      id: 's1',
      title: '1. Buat promo',
      goal: 'promo tersimpan',
      taskTitles: ['Create promo'],
      endpoints: [
        { method: 'POST', path: '/v1/cms/promo', service: 'core-promo', evidence: 'core-promo/router/router.go:3' },
        { method: 'GET', path: '/v1/cms/ghost', service: 'core-promo', evidence: 'core-promo/router/router.go:2' },
      ],
      produces: ['promoUuid'],
      consumes: [],
      rules: ['nama wajib unik'],
    },
    {
      id: 's2',
      title: '2. Reserve promo',
      goal: 'kuota berkurang',
      taskTitles: ['Reserve'],
      endpoints: [{ method: 'POST', path: '/v1/promo/{{promoUuid}}/reserve', service: 'core-promo', evidence: 'core-promo/router/router.go:4' }],
      produces: [],
      consumes: ['promoUuid'],
      rules: [],
    },
  ],
});

const flowsReply = (name: string, path: string) =>
  JSON.stringify({ flows: [{ name, category: 'happy-path', steps: [{ name: 'hit', service: 'core-promo', request: { method: 'POST', path } }] }] });

const REQ: QAGenerateRequest = {
  projectId: 'proj',
  projectName: 'Promo',
  ai: AI,
  tasks: [
    { title: 'Create promo', service: 'core-promo', spec: 'POST /v1/cms/promo' },
    { title: 'Reserve', service: 'core-promo', spec: 'POST /reserve' },
  ],
  categories: ['happy-path'],
};

describe('E2E multi-agent pipeline', () => {
  let dir = '';
  let services = '';
  let prompts: string[] = [];
  let reply: (prompt: string) => string;
  let delay: (prompt: string) => number;
  let running = 0;
  let maxRunning = 0;
  let synced: QAAgentJob[] = [];
  const manager = () =>
    new QaManager({
      dir,
      readSecret: async () => null,
      writeSecret: async () => true,
      deleteSecret: async () => true,
      resolveServicesRoot: async () => services,
      agentSink: async (job) => (synced.push({ ...job }), `task-${job.id}`),
      runAi: (_ai, prompt) => {
        prompts.push(prompt);
        running++;
        maxRunning = Math.max(maxRunning, running);
        let cancel = () => {};
        const done = new Promise<{ reply: string; error?: string }>((resolve) => {
          const t = setTimeout(() => resolve({ reply: reply(prompt) }), delay(prompt));
          cancel = () => (clearTimeout(t), resolve({ reply: '', error: 'Dibatalkan.' }));
        }).finally(() => running--);
        return { done, cancel: () => cancel() };
      },
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-qa-pipe-'));
    services = join(dir, 'Services');
    await mkdir(join(services, 'core-promo', 'router'), { recursive: true });
    await writeFile(join(services, 'core-promo', 'router', 'router.go'), ['package router', '// nothing here', 'g.POST("/promo", h.Create)', 'g.POST("/:uuid/reserve", h.Reserve)'].join('\n'));
    prompts = [];
    synced = [];
    running = maxRunning = 0;
    reply = () => PLAN;
    delay = () => 1;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const settle = async (m: QaManager) => {
    for (let i = 0; i < 400; i++) {
      const { pipeline } = await m.getPipeline('proj');
      if (!pipeline.agents.some((a) => a.status === 'running' || a.status === 'queued')) return pipeline;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('pipeline did not settle');
  };

  it('plans the journey, checks each endpoint against the router, then waits for review', async () => {
    const m = manager();
    await m.startPlan({ ...REQ, useCodebase: true });
    const pipeline = await settle(m);
    expect(pipeline.phase).toBe('review');
    const { plan } = await m.getPipeline('proj');
    expect(plan?.stages.map((s) => s.title)).toEqual(['1. Buat promo', '2. Reserve promo']);
    const [create, ghost] = plan!.stages[0].endpoints;
    expect(create.verified).toBe(true);
    // The cited line exists but registers another route.
    expect(ghost.verified).toBe(false);
    expect(plan!.stages[1].endpoints[0].verified).toBe(true);
    expect(prompts[0]).toContain('Create promo');
    // Mirrored into Agent Tasks: queued/running … done.
    expect(synced.at(-1)).toMatchObject({ role: 'plan', status: 'done' });
    expect(synced.some((j) => j.status === 'running')).toBe(true);
  });

  it('writes each stage with its own agent, at most `concurrency` at once, in journey order', async () => {
    const m = manager();
    await m.startPlan(REQ);
    await settle(m);
    // A manual flow outside the plan stays.
    await m.saveSuite({ projectId: 'proj', projectName: 'Promo', flows: [{ id: 'manual', name: 'Manual', description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [{ id: 'x', name: 'x', request: { method: 'GET', path: '/x' }, assertions: [] }] } as QAFlow], updatedAt: '' });
    // Stage 1 finishes last; the suite still lists it first.
    reply = (p) => (p.includes('FOKUS AGENT INI: tahap "1. Buat promo"') ? flowsReply('Create', '/v1/cms/promo') : flowsReply('Reserve', '/v1/promo/{{promoUuid}}/reserve/extra'));
    delay = (p) => (p.includes('tahap "1. Buat promo"') ? 40 : 5);
    await m.writeFromPlan('proj', { concurrency: 2 });
    await settle(m);
    expect(maxRunning).toBe(2);
    const writers = prompts.slice(1);
    expect(writers).toHaveLength(2);
    expect(writers.find((p) => p.includes('tahap "2. Reserve promo"'))).toContain('Data dari tahap sebelumnya, pakai PERSIS nama ini: {{promoUuid}} (uuid promo)');
    const suite = await m.getSuite('proj');
    expect(suite?.flows.map((f) => [f.name, f.stage])).toEqual([
      ['Create', '1. Buat promo'],
      ['Reserve', '2. Reserve promo'],
      ['Manual', undefined],
    ]);
    // Static check: a step outside the plan's endpoints is flagged.
    expect(suite?.flows[0].warnings).toBeUndefined();
    expect(suite?.flows[1].warnings?.[0]).toContain('tidak ada di peta journey');
  });

  it('rewrites only the chosen stages and keeps the others', async () => {
    const m = manager();
    await m.startPlan(REQ);
    await settle(m);
    reply = (p) => (p.includes('tahap "1. Buat promo"') ? flowsReply('Create v1', '/v1/cms/promo') : flowsReply('Reserve v1', '/v1/promo/1/reserve'));
    await m.writeFromPlan('proj', { concurrency: 3 });
    await settle(m);
    reply = () => flowsReply('Reserve v2', '/v1/promo/1/reserve');
    await m.writeFromPlan('proj', { stageIds: ['s2'] });
    await settle(m);
    expect((await m.getSuite('proj'))?.flows.map((f) => f.name)).toEqual(['Create v1', 'Reserve v2']);
  });

  it('keeps manual groups, empty groups and their order when a stage is rewritten', async () => {
    const m = manager();
    await m.startPlan(REQ);
    await settle(m);
    reply = (p) => (p.includes('tahap "1. Buat promo"') ? flowsReply('Create v1', '/v1/cms/promo') : flowsReply('Reserve v1', '/v1/promo/1/reserve'));
    await m.writeFromPlan('proj', { concurrency: 3 });
    await settle(m);
    // The user puts a manual group first, keeps an empty one, and moves stage 2 above stage 1.
    const manual = { id: 'm', name: 'Setup manual', description: '', category: 'happy-path', taskTitles: [], enabled: true, stage: '0. Setup', steps: [{ id: 'x', name: 'x', request: { method: 'GET', path: '/x' }, assertions: [] }] } as QAFlow;
    const current = (await m.getSuite('proj'))!;
    await m.saveSuite({ ...current, groups: ['0. Setup', 'Kosong', '2. Reserve promo', '1. Buat promo'], flows: [manual, ...current.flows] });
    reply = () => flowsReply('Reserve v2', '/v1/promo/1/reserve');
    await m.writeFromPlan('proj', { stageIds: ['s2'] });
    await settle(m);
    const suite = (await m.getSuite('proj'))!;
    expect(suite.groups).toEqual(['0. Setup', 'Kosong', '2. Reserve promo', '1. Buat promo']);
    expect(suite.flows.map((f) => [f.name, f.stage])).toEqual([
      ['Setup manual', '0. Setup'],
      ['Reserve v2', '2. Reserve promo'],
      ['Create v1', '1. Buat promo'],
    ]);
  });

  it('gives the fix agent the environment databases, so sample values become real data', async () => {
    const schemas: string[] = [];
    const m = new QaManager({
      dir,
      readSecret: async () => null,
      writeSecret: async () => true,
      deleteSecret: async () => true,
      resolveServicesRoot: async () => services,
      runAi: (_ai, prompt) => {
        prompts.push(prompt);
        const flow = { id: 'f1', name: 'Reserve', description: '', category: 'happy-path', taskTitles: [], variables: {}, enabled: true, steps: [{ id: 's1', name: 'reserve', service: 'core-promo', request: { method: 'POST', path: '/reserve', body: { promo: '{{promoId}}' } }, assertions: [] }], dataQueries: [{ name: 'promoId', db: 'core-promo', sql: "SELECT id FROM promos WHERE status = 'ACTIVE' LIMIT 1" }] };
        return { done: Promise.resolve({ reply: JSON.stringify({ flows: [flow], changes: [{ flowId: 'f1', summary: 'promoId dari database' }] }) }), cancel: () => {} };
      },
      db: {
        schema: async (c) => (schemas.push(c.database), 'promos(id uuid, status text)'),
        query: async () => ({ db: 'core-promo', sql: '', columns: [], rows: [], rowCount: 0, durationMs: 0 }),
        test: async () => 'PostgreSQL',
        list: async () => [],
      },
    } as ConstructorParameters<typeof QaManager>[0]);
    await m.saveEnvironment({ id: 'dev', name: 'Development', baseUrl: 'http://dev', services: {}, headers: {}, variables: {}, auth: { type: 'none' }, readOnly: false, timeoutMs: 10_000, dbServer: { host: 'db.dev', port: 5432, user: 'ro' }, databases: [{ name: 'core-promo', service: 'core-promo', database: 'db_promo' }] });
    const [env] = await m.listEnvironments();
    await m.saveSuite({ projectId: 'proj', projectName: 'Promo', flows: [{ id: 'f1', name: 'Reserve', description: '', category: 'happy-path', taskTitles: [], variables: { promoId: 'P-1' }, enabled: true, steps: [{ id: 's1', name: 'reserve', service: 'core-promo', request: { method: 'POST', path: '/reserve', body: { promo: '{{promoId}}' } }, assertions: [] }] } as QAFlow], updatedAt: '' });
    await m.fixFlows('proj', { flowIds: ['f1'], instruction: 'isi variabel dari database', ai: AI, environmentId: env.id });
    await settle(m);
    expect(schemas).toEqual(['db_promo']);
    expect(prompts.at(-1)).toContain('## Database (HANYA BACA)');
    expect(prompts.at(-1)).toContain('promos(id uuid, status text)');
    expect(prompts.at(-1)).toContain('ambil lewat "dataQueries" dari database service terkait');
    const suite = await m.getSuite('proj');
    expect(suite?.flows[0].dataQueries).toEqual([{ name: 'promoId', db: 'core-promo', sql: "SELECT id FROM promos WHERE status = 'ACTIVE' LIMIT 1" }]);
    // Without an environment the prompt has no database part (as before).
    expect(buildFixPrompt(suite!.flows, 'x', new Map())).not.toContain('## Database');
    // The repair agent gets the same: data that is missing in development can come from a query.
    const repair = buildRepairPrompt(suite!.flows[0], { flowId: 'f1', name: 'Reserve', category: 'happy-path', taskTitles: [], status: 'failed', steps: [] }, undefined, [{ name: 'core-promo', service: 'core-promo', schema: 'promos(id uuid)' }]);
    expect(repair).toContain('## Database (HANYA BACA)');
    expect(repair).toContain('bisa diatasi dengan "dataQueries"');
  });

  it('refuses a second batch while agents run, and cancels queued agents', async () => {
    const m = manager();
    await m.startPlan(REQ);
    await settle(m);
    delay = () => 200;
    const p = await m.writeFromPlan('proj', { concurrency: 1 });
    await expect(m.writeFromPlan('proj')).rejects.toThrow('Masih ada agent E2E');
    for (let i = 0; i < 100 && !p.agents.some((a) => a.status === 'running'); i++) await new Promise((r) => setTimeout(r, 2));
    const queued = p.agents.find((a) => a.status === 'queued')!;
    expect(m.cancelAgent(queued.id)?.status).toBe('cancelled');
    m.cancelPipeline('proj');
    const done = await settle(m);
    expect(done.agents.every((a) => a.status === 'cancelled')).toBe(true);
    expect(prompts).toHaveLength(2); // the planner and the one writer that had started
  });

  it('repairs failed flows: fixes a wrong test, lists a service bug as a suspect', async () => {
    const m = manager();
    const step = (id: string) => ({ id, name: id, service: 'core-promo', request: { method: 'POST', path: '/v1/promo' }, assertions: [{ type: 'status', expected: 200 }] });
    await m.saveSuite({
      projectId: 'proj',
      projectName: 'Promo',
      ai: AI,
      updatedAt: '',
      flows: [
        { id: 'wrong', name: 'Wrong path', description: '', category: 'happy-path', taskTitles: [], enabled: true, stage: '1. Buat promo', steps: [step('a')] },
        { id: 'buggy', name: 'Buggy service', description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [step('b')] },
        { id: 'fine', name: 'Fine', description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [step('c')] },
      ] as unknown as QAFlow[],
    });
    const runId = randomUUID();
    const result = (flowId: string, status: 'failed' | 'passed') => ({ flowId, name: flowId, category: 'happy-path', taskTitles: [], status, steps: [{ stepId: 'a', name: 'a', status, assertions: [{ passed: status === 'passed', message: 'status 404 ≠ 200' }] }] });
    const run = { id: runId, projectId: 'proj', projectName: 'Promo', environment: { id: 'e', name: 'dev', readOnly: false }, status: 'done', startedAt: new Date().toISOString(), flows: [result('wrong', 'failed'), result('buggy', 'failed'), result('fine', 'passed')], summary: { flows: 3, passedFlows: 1, steps: 3, passedSteps: 1 } };
    await mkdir(join(dir, 'runs', 'proj'), { recursive: true });
    await writeFile(join(dir, 'runs', 'proj', `${runId}.json`), JSON.stringify(run as unknown as QARun));
    reply = (p) =>
      p.includes('"Wrong path"')
        ? JSON.stringify({ verdict: 'fix-test', reason: 'path salah, router pakai /v1/cms/promo', flow: { name: 'Wrong path', category: 'happy-path', steps: [{ id: 'a', name: 'a', request: { method: 'POST', path: '/v1/cms/promo' } }] } })
        : JSON.stringify({ verdict: 'service-bug', reason: 'handler tidak menyimpan', bug: { title: 'Promo tidak tersimpan', detail: 'router.go:3', service: 'core-promo' } });
    const p = await m.repairRun('proj', runId);
    expect(p.agents.map((a) => a.flowId)).toEqual(['wrong', 'buggy']);
    await settle(m);
    const suite = await m.getSuite('proj');
    const fixed = suite!.flows.find((f) => f.id === 'wrong')!;
    expect(fixed.steps[0].request.path).toBe('/v1/cms/promo');
    expect(fixed.stage).toBe('1. Buat promo');
    expect(fixed.repairNote).toContain('Test diperbaiki: path salah');
    expect(suite!.flows.find((f) => f.id === 'buggy')!.steps[0].request.path).toBe('/v1/promo');
    expect(suite!.suspects).toEqual([expect.objectContaining({ flowId: 'buggy', title: 'Promo tidak tersimpan', service: 'core-promo', runId })]);
  });

  it('fixes flows by instruction in small batches, keeps ids and stage, and can undo', async () => {
    const m = manager();
    const flow = (id: string, msisdn: unknown) => ({
      id,
      name: `Reserve ${id}`,
      description: '',
      category: 'happy-path',
      taskTitles: [],
      enabled: true,
      stage: '2. Reserve promo',
      variables: {},
      steps: [{ id: `${id}-s`, name: 'reserve', service: 'core-promo', request: { method: 'POST', path: '/v1/promo/reserve', headers: {}, query: {}, body: { msisdn, amount: '{{amount}}' } }, assertions: [{ type: 'status', op: 'equals', expected: 200 }], extract: {} }],
    });
    const flows = Array.from({ length: 7 }, (_, i) => flow(`f${i}`, i === 6 ? '{{msisdn|string}}' : 81234567890)) as unknown as QAFlow[];
    await m.saveSuite({ projectId: 'proj', projectName: 'Promo', ai: AI, updatedAt: '', flows });
    // The agent fixes msisdn in the flows it got (dropping a step id), and returns f6 unchanged.
    reply = (p) => {
      const sent = JSON.parse(p.slice(p.indexOf('## Test case (JSON)') + 20).split('\n## ')[0]) as QAFlow[];
      return JSON.stringify({
        flows: sent.map((f) => ({ ...f, steps: f.steps.map(({ id: _id, ...s }) => ({ ...s, request: { ...s.request, body: { ...(s.request.body as object), msisdn: '{{msisdn|string}}' } } })) })),
        changes: sent.map((f) => ({ flowId: f.id, summary: 'msisdn jadi string (dto/reserve.go:12)' })),
      });
    };
    await expect(m.fixFlows('proj', { flowIds: ['f0'], instruction: '  ' })).rejects.toThrow('Tulis instruksi');
    const p = await m.fixFlows('proj', { flowIds: flows.map((f) => f.id), instruction: 'msisdn harus string' });
    expect(p.agents.map((a) => a.role)).toEqual(['fix', 'fix']);
    await settle(m);
    expect(prompts[0]).toContain('## Instruksi Tech Lead\nmsisdn harus string');
    expect(prompts[0]).toContain('BACA struct request');
    const suite = (await m.getSuite('proj'))!;
    const f0 = suite.flows[0];
    expect((f0.steps[0].request.body as { msisdn: string }).msisdn).toBe('{{msisdn|string}}');
    expect(f0.steps[0].id).toBe('f0-s');
    expect(f0.stage).toBe('2. Reserve promo');
    expect(f0.repairNote).toBe('Diperbaiki AI: msisdn jadi string (dto/reserve.go:12)');
    // f6 already had it: unchanged, so not in the undo either.
    expect(suite.flows[6].repairNote).toBeUndefined();
    expect(suite.undo).toMatchObject({ label: 'msisdn harus string' });
    // Batches finish in any order.
    expect(suite.undo!.flows.map((f) => f.id).sort()).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5']);

    const back = await m.undoFix('proj');
    expect((back.flows[0].steps[0].request.body as { msisdn: number }).msisdn).toBe(81234567890);
    expect(back.undo).toBeUndefined();
    await expect(m.undoFix('proj')).rejects.toThrow('Tidak ada perbaikan AI');
  });
});

describe('evidenceMentions', () => {
  it('looks for the last static segment of the path near the cited line', () => {
    expect(evidenceMentions('/v1/promo/{{uuid}}/reserve', 'g.POST("/:uuid/reserve", h.Reserve)')).toBe(true);
    expect(evidenceMentions('/v1/promo/{{uuid}}', '  5 ▶ promo := r.Group("/v1/promo")')).toBe(true);
    expect(evidenceMentions('/v1/cms/ghost', 'g.POST("/promo", h.Create)')).toBe(false);
    expect(evidenceMentions('/v1/x', undefined)).toBe(false);
  });
});

describe('plan coverage', () => {
  const request: QAGenerateRequest = {
    projectId: 'p',
    projectName: 'Promo',
    ai: { provider: 'claude', model: '' },
    categories: [],
    tasks: [
      { title: 'Develop API Create Promo', service: 'core-promo', spec: 'POST /cms/promo' },
      { title: 'Develop API Promo Reserve', service: 'core-promo', spec: 'POST /internal/promo/reserve' },
      { title: 'Develop Model Promo', service: 'core-promo', spec: 'CREATE TABLE promos' },
    ],
  };

  it('asks for the setup through its API and every API task in a stage', () => {
    const prompt = buildPlanPrompt({ ...request, codebase: { root: '/s', folders: ['core-promo'] } });
    expect(prompt).toMatch(/Tahap setup membuat data master LEWAT API/);
    expect(prompt).toContain('router codebase (group cms/admin/backoffice');
    expect(prompt).toMatch(/WAJIB masuk minimal satu tahap/);
  });

  it('warns about API tasks no stage tests (model tasks are context only)', () => {
    expect(uncoveredTasks(request.tasks, [{ taskTitles: ['develop api promo reserve'] }])).toEqual(['Develop API Create Promo']);
    const reply = JSON.stringify({ notes: 'catatan AI', stages: [{ title: '1. Transaksi', taskTitles: ['Develop API Promo Reserve'], endpoints: [] }] });
    const plan = parsePlan(reply, { projectId: 'p', projectName: 'Promo', ai: request.ai, request });
    expect(plan.notes).toBe('PERINGATAN: task belum masuk tahap mana pun (tambahkan ke tahap, atau buat ulang rencana):\n- Develop API Create Promo\n\ncatatan AI');
  });
});
