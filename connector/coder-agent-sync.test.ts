// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoderRun } from '../src/lib/coder/types.ts';
import { AgentTaskStore } from './agent-tasks.ts';
import { syncCoderRun } from './coder-agent-sync.ts';

describe('syncCoderRun', () => {
  let dir: string;
  let store: AgentTaskStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-sync-'));
    store = new AgentTaskStore({ dir });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const run = (over: Partial<CoderRun> = {}): CoderRun => ({
    id: 'run-1',
    draftId: 'd1',
    tadTitle: 'TAD - Tabungan',
    taskTitle: '[BACKEND][CORE-TCICO][TM] - Get Transfer Sof',
    jiraKey: 'MU-2434',
    profile: 'backend',
    ai: { provider: 'claude', model: 'sonnet' },
    repo: 'core-tcico-ultimate',
    baseBranch: 'staging',
    targetBranch: 'staging',
    branch: 'feature/MU-2434-get-transfer-sof',
    worktree: '/tmp/x',
    spec: '### Endpoint\n/v1/x',
    status: 'queued',
    createdAt: new Date().toISOString(),
    events: [],
    revisions: 0,
    ...over,
  });

  it('lists a coding run as an implement task for the local runner and follows its status', async () => {
    const id = await syncCoderRun(store, run());
    let task = (await store.get(id))!;
    expect(task).toMatchObject({ kind: 'implement', runner: 'local', status: 'queued', provider: 'claude', model: 'sonnet' });
    expect(task.links).toMatchObject({ jiraKey: 'MU-2434', repo: 'core-tcico-ultimate', coderRunId: 'run-1' });

    await syncCoderRun(store, run({ agentTaskId: id, status: 'running', events: [{ at: '', kind: 'tool', text: 'Menulis handler.go' }] }));
    task = (await store.get(id))!;
    expect(task.status).toBe('running');
    expect(task.progress?.message).toBe('Agent menulis code — Menulis handler.go');

    await syncCoderRun(store, run({ agentTaskId: id, status: 'ready' }));
    expect((await store.get(id))!.status).toBe('blocked'); // waiting for the user's review + push

    await syncCoderRun(store, run({ agentTaskId: id, status: 'pushed', mrCreateUrl: 'https://gitlab/x/-/merge_requests/new' }));
    task = (await store.get(id))!;
    expect(task.status).toBe('completed');
    expect(task.links?.mrUrl).toBe('https://gitlab/x/-/merge_requests/new');
  });

  it('opens a new entry when a pushed run is revised', async () => {
    const first = await syncCoderRun(store, run({ status: 'pushed' }));
    const second = await syncCoderRun(store, run({ agentTaskId: first, status: 'running', revisions: 1 }));
    expect(second).not.toBe(first);
    expect((await store.get(second))!.title).toBe('Revisi #1 · [BACKEND][CORE-TCICO][TM] - Get Transfer Sof');
    expect((await store.get(first))!.status).toBe('completed');
  });

  it('is always a local task, never a queued remote one', async () => {
    await syncCoderRun(store, run());
    const queued = await store.list({ status: ['queued'] });
    expect(queued.filter((t) => t.runner !== 'local')).toHaveLength(0);
  });

  it('displays green merged message when run has merged event', async () => {
    const id = await syncCoderRun(
      store,
      run({ status: 'pushed', events: [{ at: '', kind: 'info', text: 'MR sudah merged di GitLab.' }] }),
    );
    const task = (await store.get(id))!;
    expect(task.status).toBe('completed');
    expect(task.progress?.message).toBe('🟢 Selesai: MR sudah merged di GitLab');
  });
});
