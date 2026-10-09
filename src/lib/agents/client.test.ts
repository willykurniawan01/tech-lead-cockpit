import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, groupByStatus } from './client';
import type { AgentTask } from './types';

const task = (id: string, status: AgentTask['status']): AgentTask => ({
  id,
  title: id,
  prompt: id,
  status,
  priority: 'normal',
  provider: 'claude',
  runner: 'local',
  approvalPolicy: 'review_required',
  attempts: 0,
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
});

describe('groupByStatus', () => {
  it('orders groups by urgency and omits empty ones', () => {
    const groups = groupByStatus([task('a', 'completed'), task('b', 'blocked'), task('c', 'running'), task('d', 'blocked')]);
    expect(groups.map((g) => [g.status, g.tasks.map((t) => t.id)])).toEqual([
      ['blocked', ['b', 'd']],
      ['running', ['c']],
      ['completed', ['a']],
    ]);
  });
});

describe('agents client', () => {
  const fetchMock = vi.fn();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the trusted-client header and JSON bodies to the connector routes', async () => {
    fetchMock.mockResolvedValue(json(200, { task: task('t1', 'completed') }));
    await agents.complete('t1', 'Selesai');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/connector/agent-tasks/t1/complete');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-TLC-Client': '1', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ message: 'Selesai' });
    expect(JSON.stringify(init)).not.toMatch(/api[-_]?key|authorization/i);
  });

  it('builds list queries and action routes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tasks: [task('t1', 'running')] }));
    expect(await agents.list({ status: ['running', 'blocked'], limit: 50 })).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/connector/agent-tasks?status=running%2Cblocked&limit=50');

    fetchMock.mockResolvedValueOnce(json(200, { task: task('t1', 'cancelled') }));
    expect((await agents.cancel('t1')).status).toBe('cancelled');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/connector/agent-tasks/t1/cancel');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({});

    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await agents.steer('t1', '  focus on tests ');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/connector/agent-tasks/t1/steer');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ message: 'focus on tests' });

    fetchMock.mockResolvedValueOnce(json(200, { ok: true, updated: 2 }));
    expect(await agents.syncMrs()).toEqual({ ok: true, updated: 2 });
    expect(fetchMock.mock.calls[3][0]).toBe('/api/connector/agent-tasks/sync-mrs');
  });

  it('maps connector errors onto AgentApiError with status and code', async () => {
    fetchMock.mockResolvedValue(json(404, { error: 'Task tidak ditemukan.', code: 'not-found' }));
    await expect(agents.cancel('t1')).rejects.toMatchObject({ name: 'AgentApiError', status: 404, code: 'not-found', message: 'Task tidak ditemukan.' });

    fetchMock.mockResolvedValue(new Response('<html>oops</html>', { status: 502 }));
    await expect(agents.syncMrs()).rejects.toMatchObject({ status: 502, code: 'http', message: 'HTTP 502' });

    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(agents.list()).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('rejects an empty revision message without calling the connector', async () => {
    await expect(agents.steer('t1', '   ')).rejects.toMatchObject({ code: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
