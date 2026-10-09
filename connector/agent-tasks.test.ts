// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TASK_LIMITS, AGENT_TASKS_FILE, AgentTaskError, AgentTaskStore, type AgentTaskStoreOptions } from './agent-tasks.ts';

describe('AgentTaskStore', () => {
  let root: string;
  let dir: string;
  let clock: number;
  let seq: number;

  const make = (opts: AgentTaskStoreOptions = {}) =>
    new AgentTaskStore({
      dir,
      now: () => new Date(clock),
      newId: () => `task-${++seq}`,
      ...opts,
    });
  const readStore = async () => JSON.parse(await readFile(join(dir, AGENT_TASKS_FILE), 'utf8'));
  const tick = (ms = 1000) => (clock += ms);

  async function expectCode(p: Promise<unknown>, code: AgentTaskError['code']) {
    const err = await p.then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(AgentTaskError);
    expect(err.code).toBe(code);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tlc-agent-tasks-'));
    dir = join(root, 'agent-tasks');
    clock = Date.parse('2026-10-05T08:00:00.000Z');
    seq = 0;
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  describe('missing and malformed files', () => {
    it('starts empty when the directory does not exist and creates it on first write', async () => {
      const store = make();
      expect(await store.list()).toEqual([]);
      expect(await store.loadReport()).toEqual({ droppedTasks: 0, recoveredTasks: 0 });
      await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });

      await store.create({ prompt: 'Review PR 42' });
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, AGENT_TASKS_FILE))).mode & 0o777).toBe(0o600);
    });

    it('quarantines a file that is not valid JSON and keeps working', async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, AGENT_TASKS_FILE), '{"version":1,"tasks":[{"id":');
      const store = make();
      expect(await store.list()).toEqual([]);
      const report = await store.loadReport();
      expect(report.quarantined).toMatch(/tasks\.json\.corrupt-/);
      expect(await readFile(report.quarantined!, 'utf8')).toBe('{"version":1,"tasks":[{"id":');

      const { task } = await store.create({ prompt: 'after corruption' });
      expect((await readStore()).tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    });

    it('quarantines JSON with the wrong shape or version', async () => {
      await mkdir(dir, { recursive: true });
      for (const body of ['[]', 'null', '{"version":99,"tasks":[]}', '{"version":1,"tasks":{}}']) {
        await writeFile(join(dir, AGENT_TASKS_FILE), body);
        const store = make();
        expect(await store.list()).toEqual([]);
        expect((await store.loadReport()).quarantined).toBeDefined();
      }
      expect((await readdir(dir)).filter((n) => n.includes('.corrupt-'))).toHaveLength(4);
    });

    it('drops invalid or duplicate entries but keeps valid ones, and bounds text read from disk', async () => {
      const good = {
        id: 'good-1',
        title: 'x'.repeat(5000),
        prompt: 'do it\u0000 now',
        status: 'queued',
        priority: 'high',
        provider: 'hermes',
        approvalPolicy: 'review_required',
        attempts: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        error: 'e'.repeat(10_000),
      };
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, AGENT_TASKS_FILE),
        JSON.stringify({
          version: 1,
          tasks: [
            good,
            { ...good }, // duplicate id
            { ...good, id: '../escape' },
            { ...good, id: 'bad-status', status: 'exploded' },
            { ...good, id: 'bad-provider', provider: 'has spaces' },
            { ...good, id: 'bad-run', runId: 'x/../y' },
            { ...good, id: 'empty-prompt', prompt: '   ' },
            'not an object',
          ],
        }),
      );
      const store = make();
      const tasks = await store.list();
      expect(tasks.map((t) => t.id)).toEqual(['good-1']);
      expect(tasks[0].title).toHaveLength(AGENT_TASK_LIMITS.title);
      expect(tasks[0].error).toHaveLength(AGENT_TASK_LIMITS.error);
      expect(tasks[0].prompt).toBe('do it now');
      expect((await store.loadReport()).droppedTasks).toBe(7);
      // The cleaned-up list is written back.
      expect((await readStore()).tasks).toHaveLength(1);
    });
  });

  describe('atomic writes', () => {
    it('leaves no temp files behind and writes a versioned document', async () => {
      const store = make();
      await store.create({ prompt: 'one' });
      await store.create({ prompt: 'two' });
      expect(await readdir(dir)).toEqual([AGENT_TASKS_FILE]);
      const doc = await readStore();
      expect(doc.version).toBe(1);
      expect(doc.tasks).toHaveLength(2);
    });

    it('keeps the previous file and in-memory state when the final rename fails', async () => {
      let fail = false;
      const store = make({
        renameFile: async (from, to) => {
          if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          await rename(from, to);
        },
      });
      const { task } = await store.create({ prompt: 'stable' });
      const before = await readFile(join(dir, AGENT_TASKS_FILE), 'utf8');

      fail = true;
      await expect(store.create({ prompt: 'lost' })).rejects.toThrow('disk full');
      await expect(store.update(task.id, { status: 'queued' })).rejects.toThrow('disk full');

      expect(await readFile(join(dir, AGENT_TASKS_FILE), 'utf8')).toBe(before);
      expect(await readdir(dir)).toEqual([AGENT_TASKS_FILE]);
      expect((await store.list()).map((t) => [t.id, t.status])).toEqual([[task.id, 'pending']]);

      fail = false;
      await store.update(task.id, { status: 'queued' });
      expect((await readStore()).tasks[0].status).toBe('queued');
    });

    it('ignores and removes temp files left by a crash mid-write', async () => {
      const first = make();
      const { task } = await first.create({ prompt: 'survives' });
      const stale = join(dir, `.${AGENT_TASKS_FILE}.999.deadbeef.tmp`);
      await writeFile(stale, '{"version":1,"tasks":[{"partial');

      const second = make();
      expect((await second.list()).map((t) => t.id)).toEqual([task.id]);
      expect(await readdir(dir)).toEqual([AGENT_TASKS_FILE]);
    });

    it('serializes concurrent mutations without losing writes', async () => {
      const store = make();
      await Promise.all(Array.from({ length: 25 }, (_, i) => store.create({ prompt: `task ${i}` })));
      expect(await store.list()).toHaveLength(25);
      expect((await readStore()).tasks).toHaveLength(25);
      expect((await make().list()).length).toBe(25);
    });
  });

  describe('recovery', () => {
    it('moves running tasks back to queued on load and persists the change', async () => {
      const first = make();
      const { task: a } = await first.create({ prompt: 'was running', status: 'queued' });
      const { task: b } = await first.create({ prompt: 'was blocked', status: 'queued' });
      await first.update(a.id, { status: 'running', runId: 'run_abc', progress: { percent: 40, message: 'step 2' } });
      await first.update(b.id, { status: 'blocked' });

      tick();
      const second = make();
      const recovered = await second.get(a.id);
      expect(recovered).toMatchObject({ status: 'queued', runId: 'run_abc', attempts: 1, updatedAt: new Date(clock).toISOString() });
      expect(recovered?.startedAt).toBeUndefined();
      expect(recovered?.progress?.percent).toBe(40);
      expect(recovered?.progress?.message).toMatch(/Recovered/);
      expect((await second.get(b.id))?.status).toBe('blocked');
      expect(await second.loadReport()).toMatchObject({ recoveredTasks: 1, droppedTasks: 0 });

      const onDisk = (await readStore()).tasks.find((t: { id: string }) => t.id === a.id);
      expect(onDisk.status).toBe('queued');
      expect((await make().loadReport()).recoveredTasks).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('returns the existing task for a repeated idempotency key', async () => {
      const store = make();
      const first = await store.create({ prompt: 'Investigate JIRA-1', idempotencyKey: 'jira:JIRA-1:investigate' });
      const again = await store.create({ prompt: 'different text', idempotencyKey: 'jira:JIRA-1:investigate' });
      expect(first.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.task).toEqual(first.task);
      expect(await store.list()).toHaveLength(1);
    });

    it('dedupes concurrent creates and survives a reload', async () => {
      const store = make();
      const results = await Promise.all(Array.from({ length: 5 }, () => store.create({ prompt: 'p', idempotencyKey: 'same-key' })));
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.task.id)).size).toBe(1);

      const reloaded = await make().create({ prompt: 'p', idempotencyKey: 'same-key' });
      expect(reloaded).toMatchObject({ created: false, task: { id: results[0].task.id } });
    });

    it('rejects malformed idempotency keys', async () => {
      const store = make();
      await expectCode(store.create({ prompt: 'p', idempotencyKey: '' }), 'invalid_argument');
      await expectCode(store.create({ prompt: 'p', idempotencyKey: 'has space' }), 'invalid_argument');
      await expectCode(store.create({ prompt: 'p', idempotencyKey: 'k'.repeat(129) }), 'invalid_argument');
    });
  });

  describe('create / list / get / update / cancel / retry', () => {
    it('applies defaults on create', async () => {
      const { task } = await make().create({ prompt: '  Summarize the incident\nwith details  ' });
      expect(task).toEqual({
        id: 'task-1',
        title: 'Summarize the incident with details',
        prompt: 'Summarize the incident\nwith details',
        status: 'pending',
        priority: 'normal',
        provider: 'local',
        approvalPolicy: 'review_required',
        attempts: 0,
        createdAt: '2026-10-05T08:00:00.000Z',
        updatedAt: '2026-10-05T08:00:00.000Z',
      });
    });

    it('validates and bounds create input', async () => {
      const store = make();
      await expectCode(store.create({ prompt: '   ' }), 'invalid_argument');
      await expectCode(store.create({ prompt: 'x'.repeat(AGENT_TASK_LIMITS.prompt + 1) }), 'invalid_argument');
      await expectCode(store.create({ prompt: 'p', priority: 'asap' as never }), 'invalid_argument');
      await expectCode(store.create({ prompt: 'p', approvalPolicy: 'yolo' as never }), 'invalid_argument');
      await expectCode(store.create({ prompt: 'p', status: 'running' as never }), 'invalid_argument');
      await expectCode(store.create({ prompt: 'p', provider: 'bad provider' }), 'invalid_argument');
      await expectCode(store.create({ prompt: 'p', model: 'bad model\n' }), 'invalid_argument');
      const { task } = await store.create({ prompt: 'p', title: `t\u0007${'x'.repeat(500)}`, provider: 'claude', model: 'anthropic/claude-sonnet-5-5', approvalPolicy: 'auto_approve' });
      expect(task.title).toHaveLength(AGENT_TASK_LIMITS.title);
      expect(task.title.startsWith('t x')).toBe(true);
      expect(task).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', approvalPolicy: 'auto_approve' });
    });

    it('lists by priority then age, with status filter and limit', async () => {
      const store = make();
      const low = (await store.create({ prompt: 'low', priority: 'low' })).task;
      tick();
      const n1 = (await store.create({ prompt: 'n1' })).task;
      tick();
      const urgent = (await store.create({ prompt: 'urgent', priority: 'urgent', status: 'queued' })).task;
      tick();
      const n2 = (await store.create({ prompt: 'n2', status: 'queued' })).task;
      expect((await store.list()).map((t) => t.id)).toEqual([urgent.id, n1.id, n2.id, low.id]);
      expect((await store.list({ status: 'queued' })).map((t) => t.id)).toEqual([urgent.id, n2.id]);
      expect((await store.list({ status: ['pending'], limit: 1 })).map((t) => t.id)).toEqual([n1.id]);
      await expectCode(store.list({ status: 'nope' as never }), 'invalid_argument');
    });

    it('get validates ids and returns copies', async () => {
      const store = make();
      const { task } = await store.create({ prompt: 'p' });
      await expectCode(store.get('../etc/passwd'), 'invalid_argument');
      expect(await store.get('missing')).toBeUndefined();
      const copy = (await store.get(task.id))!;
      copy.status = 'completed';
      expect((await store.get(task.id))?.status).toBe('pending');
    });

    it('tracks run lifecycle: running sets startedAt/attempts, terminal sets finishedAt and freezes the task', async () => {
      const store = make();
      const { task } = await store.create({ prompt: 'p', status: 'queued' });
      tick();
      const running = await store.update(task.id, { status: 'running', runId: 'run-1', progress: { percent: 150, message: 'go' } });
      expect(running).toMatchObject({ status: 'running', runId: 'run-1', attempts: 1, startedAt: '2026-10-05T08:00:01.000Z', progress: { percent: 100, message: 'go' } });
      tick();
      const failed = await store.update(task.id, { status: 'failed', error: 'boom\u0000', progress: null });
      expect(failed).toMatchObject({ status: 'failed', error: 'boom', finishedAt: '2026-10-05T08:00:02.000Z' });
      expect(failed.progress).toBeUndefined();
      await expectCode(store.update(task.id, { status: 'running' }), 'invalid_state');
      await expectCode(store.update(task.id, { runId: 'bad id!' }), 'invalid_argument');
      await expectCode(store.update('missing', { status: 'queued' }), 'not_found');
    });

    it('cancels active tasks idempotently and refuses to cancel finished ones', async () => {
      const store = make();
      const { task } = await store.create({ prompt: 'p' });
      const cancelled = await store.cancel(task.id, 'no longer needed');
      expect(cancelled).toMatchObject({ status: 'cancelled', error: 'no longer needed', finishedAt: expect.any(String) });
      expect(await store.cancel(task.id)).toEqual(cancelled);

      const { task: done } = await store.create({ prompt: 'q', status: 'queued' });
      await store.update(done.id, { status: 'completed' });
      await expectCode(store.cancel(done.id), 'invalid_state');
      await expectCode(store.cancel('missing'), 'not_found');
    });

    it('retries failed or cancelled tasks back to queued and clears run state', async () => {
      const store = make();
      const { task } = await store.create({ prompt: 'p', status: 'queued' });
      await expectCode(store.retry(task.id), 'invalid_state');
      await store.update(task.id, { status: 'running', runId: 'run-1' });
      await store.update(task.id, { status: 'failed', error: 'timeout' });
      const retried = await store.retry(task.id);
      expect(retried).toMatchObject({ status: 'queued', attempts: 1 });
      for (const key of ['runId', 'error', 'progress', 'startedAt', 'finishedAt']) expect(retried).not.toHaveProperty(key);
      await store.update(task.id, { status: 'running' });
      expect((await store.get(task.id))?.attempts).toBe(2);

      await store.cancel(task.id);
      expect((await store.retry(task.id)).status).toBe('queued');
    });
  });
});
