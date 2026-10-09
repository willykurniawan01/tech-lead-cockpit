// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { textToAdf } from '../jira.ts';
import { bugFixSpec, buildBugPrompt, parseBugReply } from './analysis.ts';
import { BugManager, MAX_LOG_BYTES } from './manager.ts';

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    summary: 'Reserve promo gagal saat kuota harian habis',
    rootCause: 'QuotaRepository.Reserve tidak menangani slot nil saat kuota harian habis',
    confidence: 'high',
    severity: 'high',
    services: ['core-promo-ultimate', 'tidak-ada'],
    repo: 'core-promo-ultimate',
    evidence: [{ file: 'core-promo-ultimate/internal/quota/repo.go', line: 88, note: 'slot di-dereference tanpa cek nil' }, { file: '../etc/passwd', note: 'x' }],
    logSignals: ['panic: nil pointer dereference'],
    fixPlan: 'Cek slot nil dan kembalikan ErrQuotaExhausted',
    testPlan: 'Test Reserve dengan kuota harian habis',
    openQuestions: ['Apakah error code 4291 sesuai kontrak?'],
    jiraSummary: '[Promo] Reserve panic saat kuota harian habis',
    jiraDescription: 'Konteks…',
    ...over,
  });

describe('bug analysis parsing', () => {
  it('validates the AI JSON against real services and paths', () => {
    const a = parseBugReply(`Hasil:\n\`\`\`json\n${reply()}\n\`\`\``, ['core-promo-ultimate', 'core-biller-ultimate']);
    expect(a.services).toEqual(['core-promo-ultimate']);
    expect(a.repo).toBe('core-promo-ultimate');
    expect(a.evidence).toEqual([{ file: 'core-promo-ultimate/internal/quota/repo.go', line: 88, note: 'slot di-dereference tanpa cek nil' }]);
    expect(a.confidence).toBe('high');
    expect(parseBugReply(reply({ confidence: 'yakin', repo: 'ngarang' }), ['core-promo-ultimate']).confidence).toBe('medium');
    expect(parseBugReply(reply({ repo: 'ngarang' }), ['core-promo-ultimate']).repo).toBe('core-promo-ultimate');
    expect(() => parseBugReply('tidak tahu', [])).toThrow('JSON');
    expect(() => parseBugReply(reply({ rootCause: '' }), [])).toThrow('root cause');
  });

  it('splits the fix into tasks per service and falls back to one task', () => {
    const known = ['core-promo-ultimate', 'web-portal'];
    const two = parseBugReply(
      reply({
        tasks: [
          { title: 'Handle slot nil di Reserve', repo: 'core-promo-ultimate', fixPlan: 'Cek nil', testPlan: 'Test kuota habis', jiraSummary: '[BE] Reserve panic' },
          { title: 'Tampilkan pesan kuota habis', repo: 'web-portal', fixPlan: 'Map error 4291', testPlan: 'Cek UI' },
          { title: 'Repo karangan', repo: 'ngarang', fixPlan: 'x' },
          { title: 'Tanpa rencana', repo: 'core-promo-ultimate', fixPlan: '' },
        ],
      }),
      known,
    );
    expect(two.tasks.map((t) => [t.repo, t.profile, t.jiraSummary])).toEqual([
      ['core-promo-ultimate', 'backend', '[BE] Reserve panic'],
      ['web-portal', 'frontend', 'Tampilkan pesan kuota habis'],
    ]);
    // No tasks from the AI: one task from the overall plan.
    const one = parseBugReply(reply(), known);
    expect(one.tasks).toEqual([
      { title: '[Promo] Reserve panic saat kuota harian habis', repo: 'core-promo-ultimate', profile: 'backend', fixPlan: 'Cek slot nil dan kembalikan ErrQuotaExhausted', testPlan: 'Test Reserve dengan kuota harian habis', jiraSummary: '[Promo] Reserve panic saat kuota harian habis', jiraDescription: 'Konteks…' },
    ]);
  });

  it('builds the prompt and the per-task coder spec', () => {
    const c = { id: 'b1', title: 'Reserve promo gagal', description: 'User dapat error 500', steps: '1. Buka promo\n2. Klaim', expected: 'Pesan kuota habis', actual: 'Error 500', environment: 'staging', serviceHint: 'core-promo-ultimate', logs: [], status: 'draft' as const, tasks: [], coderRunIds: [], createdAt: '', updatedAt: '' };
    const p = buildBugPrompt(c, { servicesRoot: '/Users/x/Services', logExcerpts: [{ name: 'app.log', excerpt: 'panic: nil pointer' }] });
    expect(p).toContain('"/Users/x/Services" (HANYA BACA');
    expect(p).toContain('Langkah reproduksi:\n1. Buka promo');
    expect(p).toContain('### app.log\npanic: nil pointer');
    expect(p).toContain('JANGAN mengubah kode');
    expect(p).toContain('SATU task per service/repo');
    const analysis = { ...parseBugReply(reply(), ['core-promo-ultimate']), at: '', ai: { provider: 'claude' as const, model: '' } };
    const be = { id: 't1', status: 'ticketed' as const, coderRunIds: [], jira: { key: 'MU-9', url: '', createdAt: '' }, ...analysis.tasks[0] };
    const fe = { ...be, id: 't2', title: 'Pesan di portal', repo: 'web-portal', jira: undefined };
    const spec = bugFixSpec({ ...c, analysis, tasks: [be, fe] }, be);
    expect(spec).toContain('Task: [Promo] Reserve panic saat kuota harian habis (repo core-promo-ultimate) · Jira MU-9');
    expect(spec).toContain('- core-promo-ultimate/internal/quota/repo.go:88: slot di-dereference tanpa cek nil');
    expect(spec).toContain('Rencana test untuk task ini:\nTest Reserve dengan kuota harian habis');
    expect(spec).toContain('JANGAN dikerjakan di sini):\n- Pesan di portal (repo web-portal)');
    expect(spec).toContain('Belum terkonfirmasi');
  });

  it('converts a ticket description to Atlassian Document Format', () => {
    const adf = textToAdf('Konteks bug\nbaris kedua\n\n- langkah 1\n- langkah 2\n\n```\npanic: nil\n```\nPenutup') as { content: { type: string; content?: unknown[] }[] };
    expect(adf.content.map((n) => n.type)).toEqual(['paragraph', 'bulletList', 'codeBlock', 'paragraph']);
    expect(adf.content[0].content).toEqual([{ type: 'text', text: 'Konteks bug' }, { type: 'hardBreak' }, { type: 'text', text: 'baris kedua' }]);
    expect(adf.content[2].content).toEqual([{ type: 'text', text: 'panic: nil' }]);
  });
});

describe('BugManager', () => {
  let dir = '';
  let aiFolder: { files: string[]; log: string } | null = null;
  let aiReply = reply();
  let jiraCalls: unknown[] = [];
  const manager = () =>
    new BugManager({
      dir,
      resolveServicesRoot: async (i) => i || '/Users/x/Services',
      listServices: async () => ['core-promo-ultimate'],
      watchRepos: async () => async () => [],
      runAi: (_ai, _prompt, opts) => ({
        done: (async () => {
          aiFolder = { files: await readdir(join(opts.cwd, 'logs')), log: await readFile(join(opts.cwd, 'logs', 'app.log'), 'utf8') };
          return { reply: aiReply };
        })(),
        cancel: () => {},
      }),
      jira: async () => ({ createIssue: async (i) => (jiraCalls.push(i), { key: 'MU-123', url: 'https://x/browse/MU-123' }) }),
    });
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-bugs-'));
    aiFolder = null;
    aiReply = reply();
    jiraCalls = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('stores a case with logs, analyses it on redacted logs, files a ticket and records the fix run', async () => {
    const m = manager();
    await expect(m.create({ title: '' })).rejects.toThrow('Judul');
    const c = await m.create({ title: 'Reserve promo gagal', description: 'error 500', serviceHint: 'core-promo-ultimate' });
    expect(c.status).toBe('draft');
    await m.addLog(c.id, 'app.log', 'INFO ok\nERROR reserve failed token=abc123secret msisdn 081234567890\npanic: nil pointer');
    await expect(m.addLog(c.id, 'big.log', 'x'.repeat(MAX_LOG_BYTES + 1))).rejects.toThrow('melebihi');
    await expect(m.addLog(c.id, 'empty.log', '')).rejects.toThrow('kosong');
    expect((await m.readLog(c.id, 'app.log')).text).toContain('token=***');

    const job = await m.analyze({ caseId: c.id, ai: { provider: 'claude', model: '' }, useCodebase: true });
    await until(async () => m.job(job.id)?.status !== 'running');
    expect(m.job(job.id)?.status).toBe('done');
    // The AI saw only the redacted copy.
    expect(aiFolder?.files).toEqual(['app.log']);
    expect(aiFolder?.log).toContain('token=***');
    expect(aiFolder?.log).not.toContain('abc123secret');
    expect(aiFolder?.log).not.toContain('081234567890');
    // The original stays intact on disk.
    expect(await readFile(join(dir, 'logs', c.id, 'app.log'), 'utf8')).toContain('abc123secret');

    let saved = await m.get(c.id);
    expect(saved).toMatchObject({ status: 'analyzed', analysis: { repo: 'core-promo-ultimate', confidence: 'high', touchedRepos: [] } });
    expect(saved.tasks).toHaveLength(1);
    const task = saved.tasks[0];
    expect(task).toMatchObject({ status: 'proposed', repo: 'core-promo-ultimate', coderRunIds: [] });

    // Tasks can be edited and added once the analysis exists.
    saved = await m.updateTask(c.id, task.id, { title: 'Handle kuota habis', fixPlan: 'Kembalikan ErrQuotaExhausted' });
    expect(saved.tasks[0]).toMatchObject({ title: 'Handle kuota habis', fixPlan: 'Kembalikan ErrQuotaExhausted' });
    saved = await m.addTask(c.id, { title: 'Pesan kuota di portal', repo: 'web-portal' });
    expect(saved.tasks[1]).toMatchObject({ profile: 'frontend', status: 'proposed' });
    saved = await m.removeTask(c.id, saved.tasks[1].id);
    expect(saved.tasks).toHaveLength(1);

    await expect(m.createTicket({ caseId: c.id, taskId: task.id, projectKey: 'mu', issueType: 'Bug', summary: 'x', description: '' })).rejects.toThrow('Project key');
    saved = (await m.createTicket({ caseId: c.id, taskId: task.id, projectKey: 'MU', issueType: 'Bug', summary: 'Reserve panic', description: 'desc' })).case;
    expect(saved).toMatchObject({ status: 'ticketed', tasks: [{ status: 'ticketed', jira: { key: 'MU-123' } }] });
    expect(jiraCalls).toEqual([{ projectKey: 'MU', issueType: 'Bug', summary: 'Reserve panic', description: 'desc', priority: undefined }]);
    await expect(m.createTicket({ caseId: c.id, taskId: task.id, projectKey: 'MU', issueType: 'Bug', summary: 'again', description: '' })).rejects.toThrow('sudah punya tiket');
    await expect(m.removeTask(c.id, task.id)).rejects.toThrow('tidak bisa dihapus');

    saved = await m.attachRun(c.id, task.id, 'run-1');
    expect(saved).toMatchObject({ status: 'fixing', coderRunIds: ['run-1'], tasks: [{ status: 'fixing', coderRunIds: ['run-1'] }] });
    await expect(m.updateTask(c.id, task.id, { repo: 'core-biller-ultimate' })).rejects.toThrow('Repo tidak bisa diganti');
    saved = await m.setTaskStatus(c.id, task.id, 'fixed');
    expect(saved.status).toBe('fixed');
    expect((await m.list()).map((x) => x.id)).toEqual([c.id]);
    expect(m.jobsList()[0]).toMatchObject({ caseId: c.id, caseTitle: 'Reserve promo gagal', status: 'done' });
    await m.remove(c.id);
    expect(await m.list()).toEqual([]);
    expect(m.jobsList()).toEqual([]);
  });

  it('refuses tickets, fixes and tasks before the tracing agent has analysed the bug', async () => {
    const m = manager();
    const c = await m.create({ title: 'Belum ditrace' });
    await expect(m.createTicket({ caseId: c.id, taskId: 'x', projectKey: 'MU', issueType: 'Bug', summary: 's', description: '' })).rejects.toThrow('agent tracing dulu');
    await expect(m.fixTarget(c.id, 'x')).rejects.toThrow('agent tracing dulu');
    await expect(m.addTask(c.id, { title: 't', repo: 'core-promo-ultimate' })).rejects.toThrow('agent tracing dulu');
  });

  it('keeps ticketed tasks when the bug is traced again', async () => {
    const m = manager();
    const c = await m.create({ title: 'Retrace' });
    await m.addLog(c.id, 'app.log', 'ERROR x');
    const trace = async () => {
      const job = await m.analyze({ caseId: c.id, ai: { provider: 'claude', model: '' }, useCodebase: true });
      await until(async () => m.job(job.id)?.status !== 'running');
    };
    await trace();
    const first = (await m.get(c.id)).tasks[0];
    await m.createTicket({ caseId: c.id, taskId: first.id, projectKey: 'MU', issueType: 'Bug', summary: 's', description: '' });
    aiReply = reply({ tasks: [{ title: 'Ulang BE', repo: 'core-promo-ultimate', fixPlan: 'x' }] });
    await trace();
    const after = await m.get(c.id);
    // The ticketed task stays; a new proposal for the same repo is not duplicated.
    expect(after.tasks.map((t) => [t.id, t.status])).toEqual([[first.id, 'ticketed']]);
  });

  it('migrates a case from before per-task tickets and releases a cut-off trace', async () => {
    const m = manager();
    const c = await m.create({ title: 'Lama' });
    const analysis = { ...parseBugReply(reply(), ['core-promo-ultimate']), at: '', ai: { provider: 'claude', model: '' } } as Record<string, unknown>;
    delete analysis.tasks;
    const legacy = { ...c, tasks: undefined, status: 'fixing', analysis, jira: { key: 'MU-7', url: 'u', createdAt: '' }, coderRunIds: ['run-9'] };
    await writeFile(join(dir, 'cases', `${c.id}.json`), JSON.stringify(legacy));
    const got = await m.get(c.id);
    expect(got.tasks).toHaveLength(1);
    expect(got.tasks[0]).toMatchObject({ repo: 'core-promo-ultimate', jira: { key: 'MU-7' }, coderRunIds: ['run-9'], status: 'fixing' });
    expect(got.status).toBe('fixing');

    // "analyzing" on disk without a live job (connector restarted mid-trace).
    await writeFile(join(dir, 'cases', `${c.id}.json`), JSON.stringify({ ...got, status: 'analyzing', analysis: undefined, tasks: [] }));
    expect((await manager().get(c.id)).status).toBe('draft');
  });

  it('keeps the raw reply and resets the status when the analysis fails', async () => {
    const m = manager();
    const c = await m.create({ title: 'x' });
    await m.addLog(c.id, 'app.log', 'ERROR x');
    aiReply = 'maaf, tidak tahu';
    const job = await m.analyze({ caseId: c.id, ai: { provider: 'claude', model: '' }, useCodebase: false });
    await until(async () => m.job(job.id)?.status !== 'running' && (await m.get(c.id)).status !== 'analyzing');
    expect(m.job(job.id)).toMatchObject({ status: 'error', rawReply: 'maaf, tidak tahu' });
    expect((await m.get(c.id)).status).toBe('draft');
  });
});
