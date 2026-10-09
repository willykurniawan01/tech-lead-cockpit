// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskId, type EstimateRequest } from '../../src/lib/estimate/types.ts';
import { buildEstimatePrompt, parseEstimateReply } from './ai.ts';
import { EstimateManager, validateHolidays, validateProject } from './manager.ts';

const A = '[BACKEND][CORE][X] - Develop Model & Migration';
const B = '[BACKEND][CORE][X] - Develop API Create';
const C = '[MOBILE-FE][APP][X] - Integrasi API Create';
const idA = taskId('tad1', A);
const idB = taskId('tad1', B);
const idC = taskId('tad2', C);

const req: EstimateRequest = {
  projectId: 'proj-1',
  projectName: 'Proyek X',
  ai: { provider: 'claude', model: '' },
  tasks: [
    { id: idA, title: A, tadTitle: 'TAD Backend', service: 'core', role: 'BACKEND', spec: 'Tabel orders' },
    { id: idB, title: B, tadTitle: 'TAD Backend', service: 'core', role: 'BACKEND', spec: 'POST /v1/orders' },
    { id: idC, title: C, tadTitle: 'TAD Mobile', service: 'app', role: 'MOBILE-FE', spec: '' },
  ],
  context: 'Arsitektur: core + app',
};
const refs = req.tasks.map(({ id, title }) => ({ id, title }));

describe('estimate prompt & parser', () => {
  it('mentions the codebase only when it may be read, and each task’s TAD', () => {
    expect(buildEstimatePrompt({ ...req, servicesRoot: '/Users/x/Services' }, true)).toContain('"/Users/x/Services" (HANYA BACA');
    const plain = buildEstimatePrompt(req, false);
    expect(plain).toContain('# Estimasi effort proyek: Proyek X');
    expect(plain).toContain('codebase tidak tersedia');
    expect(plain).toContain(`### 3. ${C}\nTAD: TAD Mobile`);
    expect(plain).toContain('(Detail Task belum ada)');
    expect(plain).toContain('Arsitektur: core + app');
  });

  it('maps numbers and unique titles to task ids, rounds efforts and drops bad entries', () => {
    const reply = `Berikut:\n\`\`\`json\n{"notes":"Asumsi: pola repository sudah ada","tasks":[
      {"title":"[backend][core][x] - develop model & migration","effortDays":1.2,"confidence":"high","reason":"Pola migration sudah ada","dependsOn":[]},
      {"no":2,"effortDays":3,"confidence":"weird","dependsOn":[1,2,"tidak ada"]},
      {"title":"Task karangan","effortDays":2},
      {"no":3,"effortDays":0},
    ]}\n\`\`\``;
    const r = parseEstimateReply(reply, refs);
    expect(r.notes).toBe('Asumsi: pola repository sudah ada');
    expect(r.tasks).toEqual([
      { id: idA, effortDays: 1, confidence: 'high', reason: 'Pola migration sudah ada', dependsOn: [] },
      { id: idB, effortDays: 3, confidence: 'medium', reason: '', dependsOn: [idA] },
    ]);
    expect(() => parseEstimateReply('tidak tahu', refs)).toThrow('tidak berisi JSON');
    expect(() => parseEstimateReply('{"tasks":[{"title":"lain","effortDays":1}]}', refs)).toThrow('tidak menghasilkan');
  });

  it('does not guess between two TADs with the same task title', () => {
    const twin = [
      { id: taskId('tad1', A), title: A },
      { id: taskId('tad2', A), title: A },
    ];
    expect(() => parseEstimateReply(JSON.stringify({ tasks: [{ title: A, effortDays: 1 }] }), twin)).toThrow('tidak menghasilkan');
    expect(parseEstimateReply(JSON.stringify({ tasks: [{ no: 2, effortDays: 1, dependsOn: [1] }] }), twin).tasks[0]).toMatchObject({ id: twin[1].id, dependsOn: [twin[0].id] });
  });
});

describe('validation', () => {
  it('cleans a project from the UI', () => {
    const p = validateProject({
      name: ' Proyek X ',
      draftIds: ['tad1', 'tad1', '../bad'],
      startDate: '2026-10-12',
      developers: [{ id: 'be1', name: ' Budi ', role: 'BACKEND', allocation: 3 }],
      tasks: [
        { id: 'x', draftId: 'tad1', title: A, service: 'core', role: 'BACKEND', effortDays: 1.3, dependsOn: [idA, idB, 'ghost'], assigneeId: 'be1' },
        { id: 'y', draftId: 'tad1', title: B, service: 'core', role: 'BACKEND', effortDays: null, dependsOn: [], assigneeId: 'ghost' },
        { id: 'z', draftId: 'tad-out', title: C, service: 'app', role: 'MOBILE-FE', effortDays: 1, dependsOn: [] },
      ],
    } as never);
    expect(p.name).toBe('Proyek X');
    expect(p.draftIds).toEqual(['tad1']);
    expect(p.developers).toEqual([{ id: 'be1', name: 'Budi', role: 'BACKEND', allocation: 1 }]);
    // Ids are rebuilt from TAD + title; self and unknown dependencies go; tasks of TADs outside the project go.
    expect(p.tasks.map((t) => t.id)).toEqual([idA, idB]);
    expect(p.tasks[0]).toMatchObject({ effortDays: 1.5, dependsOn: [idB], assigneeId: 'be1' });
    expect(p.tasks[1]).toMatchObject({ effortDays: null, assigneeId: undefined });
    expect(p.skipCutiBersama).toBe(true);
    expect(() => validateProject({ name: '', startDate: '2026-10-12' } as never)).toThrow('Nama proyek');
    expect(() => validateProject({ name: 'x', startDate: 'besok' } as never)).toThrow('Tanggal mulai');
    expect(() => validateProject({ name: 'x', startDate: '2026-10-12', developers: [{ name: 'x', role: 'QA' }] } as never)).toThrow('Role');
  });

  it('sorts and dedupes holidays', () => {
    expect(
      validateHolidays([
        { date: '2026-12-25', name: 'Natal', kind: 'libur' },
        { date: '2026-08-17', name: '', kind: 'x' },
        { date: '2026-12-25', name: 'dup' },
      ]),
    ).toEqual([
      { date: '2026-08-17', name: 'Libur', kind: 'libur' },
      { date: '2026-12-25', name: 'Natal', kind: 'libur' },
    ]);
    expect(() => validateHolidays([{ date: '17-08-2026' }])).toThrow('tidak valid');
  });
});

describe('EstimateManager', () => {
  let dir = '';
  let reply = '';
  let seenOpts: { readOnlyDirs: string[] } | undefined;
  const manager = () =>
    new EstimateManager({
      dir,
      resolveServicesRoot: async (input) => {
        if (input.includes('missing')) throw new Error('Folder codebase tidak ditemukan');
        return input;
      },
      watchRepos: async () => async () => [],
      draftTitle: async (id) => (id === 'tad-old' ? 'TAD Motion Circle' : undefined),
      runAi: (_ai, _prompt, opts) => {
        seenOpts = opts;
        return { done: Promise.resolve({ reply }), cancel: () => {} };
      },
    });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-est-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the AI with the codebase read-only and parses the result', async () => {
    const m = manager();
    reply = JSON.stringify({ tasks: [{ no: 1, effortDays: 1, confidence: 'high', reason: 'ok', dependsOn: [] }] });
    const job = await m.start({ ...req, servicesRoot: '/Users/x/Services' });
    await until(() => m.job(job.id)?.status !== 'running' && m.job(job.id)?.touchedRepos !== undefined);
    expect(seenOpts?.readOnlyDirs).toEqual(['/Users/x/Services']);
    expect(m.job(job.id)).toMatchObject({ projectId: 'proj-1', status: 'done', touchedRepos: [], result: { tasks: [{ id: idA, effortDays: 1 }] } });
    expect(m.latestJob('proj-1')?.id).toBe(job.id);
    await expect(m.start({ ...req, servicesRoot: '/Users/x/missing' })).rejects.toThrow('tidak ditemukan');
  });

  it('keeps the raw reply when parsing fails', async () => {
    const m = manager();
    reply = 'maaf';
    const job = await m.start(req);
    await until(() => m.job(job.id)?.status !== 'running');
    expect(m.job(job.id)).toMatchObject({ status: 'error', rawReply: 'maaf' });
    expect(seenOpts?.readOnlyDirs).toEqual([]);
  });

  it('stores projects, keeps a TAD in one project, and falls back to the SKB holiday list', async () => {
    const m = manager();
    expect((await m.holidays()).custom).toBe(false);
    expect((await m.holidays()).holidays.some((h) => h.date === '2026-03-19')).toBe(true);
    await m.saveHolidays([{ date: '2026-10-20', name: 'Libur kantor', kind: 'libur' }]);
    expect(await m.holidays()).toEqual({ custom: true, holidays: [{ date: '2026-10-20', name: 'Libur kantor', kind: 'libur' }] });
    expect((await m.resetHolidays()).custom).toBe(false);

    expect(await m.listProjects()).toEqual([]);
    const p1 = await m.saveProject({ name: 'Proyek A', draftIds: ['tad1', 'tad2'], startDate: '2026-10-12', developers: [], tasks: [] } as never);
    expect((await m.project(p1.id))?.draftIds).toEqual(['tad1', 'tad2']);
    await expect(m.saveProject({ name: 'Proyek B', draftIds: ['tad2'], startDate: '2026-10-12' } as never)).rejects.toThrow('sudah masuk proyek "Proyek A"');
    // Saving the same project again is fine.
    await m.saveProject({ ...p1, name: 'Proyek A2' });
    expect((await m.listProjects()).map((p) => p.name)).toEqual(['Proyek A2']);
    await m.deleteProject(p1.id);
    expect(await m.listProjects()).toEqual([]);
    await expect(m.project('../x')).rejects.toThrow('Id proyek');
  });

  it('turns an old per-TAD estimate into a project once', async () => {
    await mkdir(join(dir, 'plans'), { recursive: true });
    await writeFile(
      join(dir, 'plans', 'tad-old.json'),
      JSON.stringify({
        draftId: 'tad-old',
        startDate: '2026-10-12',
        skipCutiBersama: true,
        developers: [{ id: 'be1', name: 'Budi', role: 'BACKEND', allocation: 1 }],
        tasks: [
          { title: A, service: 'core', role: 'BACKEND', effortDays: 2, dependsOn: [] },
          { title: B, service: 'core', role: 'BACKEND', effortDays: 1, dependsOn: [A] },
        ],
      }),
    );
    const [p] = await manager().listProjects();
    expect(p).toMatchObject({ name: 'Proyek TAD Motion Circle', draftIds: ['tad-old'] });
    expect(p.tasks.map((t) => [t.id, t.dependsOn])).toEqual([
      [taskId('tad-old', A), []],
      [taskId('tad-old', B), [taskId('tad-old', A)]],
    ]);
    expect(await readdir(join(dir, 'plans', 'migrated'))).toEqual(['tad-old.json']);
    // A fresh manager does not migrate it again.
    expect(await manager().listProjects()).toHaveLength(1);
  });
});

describe('project task sources outside the TADs', () => {
  const base = { name: 'Ops', startDate: '2026-10-12' };
  it('keeps a valid Jira filter, bug case ids and manual tasks, cleaned for JQL', () => {
    const p = validateProject({
      ...base,
      jiraFilter: { projectKey: 'mu', issueTypes: ['Bug', 'Bug', 'Ta"sk'], label: ' hot"fix ', epicKey: 'mu-12', activeSprint: true, doneDays: 7 },
      bugCaseIds: ['case-1', '../x', 'case-1'],
      manualTasks: [{ id: 'm1', title: ' Naikkan timeout ', repo: 'core-payment', jiraKey: 'mu-3', done: true, createdAt: '2026-10-09' }, { id: 'm2', title: '  ', createdAt: '' }] as never,
    } as never);
    expect(p.jiraFilter).toEqual({ projectKey: 'MU', issueTypes: ['Bug', 'Task'], label: 'hotfix', epicKey: 'MU-12', activeSprint: true, doneDays: 7 });
    expect(p.bugCaseIds).toEqual(['case-1']);
    expect(p.manualTasks).toEqual([{ id: 'm1', title: 'Naikkan timeout', repo: 'core-payment', jiraKey: 'MU-3', done: true, createdAt: '2026-10-09' }]);
  });

  it('rejects a malformed project or epic key, and drops an empty filter', () => {
    expect(() => validateProject({ ...base, jiraFilter: { projectKey: 'MU; DROP', issueTypes: [] } } as never)).toThrow('Project key');
    expect(() => validateProject({ ...base, jiraFilter: { projectKey: 'MU', issueTypes: [], epicKey: 'x' } } as never)).toThrow('Epic');
    expect(validateProject({ ...base, jiraFilter: { projectKey: '', issueTypes: [] } } as never).jiraFilter).toBeUndefined();
  });
});
