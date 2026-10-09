// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_NINEROUTER_BASE_URL,
  DEFAULT_NINEROUTER_MODELS,
  checkNineRouterStatus,
  clearNineRouterModelsCache,
  explainNineRouterError,
  getNineRouterConfig,
  listNineRouterModels,
  startNineRouterRun,
} from './ninerouter.ts';

vi.mock('./keychain.ts', () => ({
  NINEROUTER_SERVICE: 'tech-lead-cockpit.9router',
  readKeychain: vi.fn().mockResolvedValue(null),
}));

describe('NineRouter Configuration', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NINEROUTER_API_KEY;
    delete process.env.NINEROUTER_BASE_URL;
    delete process.env.NINEROUTER_MODEL;
    clearNineRouterModelsCache();
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns default config when no environment variables are set', async () => {
    const cfg = await getNineRouterConfig({});
    expect(cfg).toEqual({
      baseUrl: DEFAULT_NINEROUTER_BASE_URL,
      apiKey: undefined,
      defaultModel: undefined,
    });
  });

  it('reads custom base URL, API key, and model from environment and strips trailing /v1', async () => {
    const cfg = await getNineRouterConfig({
      NINEROUTER_BASE_URL: 'https://ai.diwebin.web.id/v1/',
      NINEROUTER_API_KEY: 'master-secret-key',
      NINEROUTER_MODEL: 'claude-3-7-sonnet',
    });
    expect(cfg).toEqual({
      baseUrl: 'https://ai.diwebin.web.id',
      apiKey: 'master-secret-key',
      defaultModel: 'claude-3-7-sonnet',
    });
  });
});

describe('explainNineRouterError', () => {
  it('explains 401 unauthorized errors', () => {
    expect(explainNineRouterError(401, 'unauthorized')).toContain('API key tidak valid');
  });

  it('explains 404 not found errors', () => {
    expect(explainNineRouterError(404, 'model not found')).toContain('tidak ditemukan');
  });

  it('explains 429 rate limit errors', () => {
    expect(explainNineRouterError(429, 'rate limit exceeded')).toContain('Limit permintaan 9Router tercapai');
  });

  it('explains 502/503 upstream gateway errors', () => {
    expect(explainNineRouterError(502, 'bad gateway')).toContain('gagal menghubungi upstream');
  });

  it('passes through default status message', () => {
    expect(explainNineRouterError(500, 'Server crashed')).toBe('Server crashed');
  });
});

describe('listNineRouterModels and checkNineRouterStatus', () => {
  const origFetch = global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
    clearNineRouterModelsCache();
  });

  it('returns fallback models when connection fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const models = await listNineRouterModels({
      baseUrl: 'http://localhost:20128',
    });
    expect(models).toEqual([{ id: '', label: 'Default (9Router gateway)' }]);
  });

  it('parses dynamic models from /v1/models', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' },
          { id: 'gpt-4o', name: 'GPT-4o' },
        ],
      }),
    });

    const status = await checkNineRouterStatus({
      baseUrl: 'http://localhost:20128',
      defaultModel: 'claude-3-7-sonnet',
    });

    expect(status.available).toBe(true);
    expect(status.models).toEqual([
      { id: '', label: 'Default (claude-3-7-sonnet)' },
      { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet (claude-3-7-sonnet)' },
      { id: 'gpt-4o', label: 'GPT-4o (gpt-4o)' },
    ]);
  });

  it('detects 401 as unavailable with auth note', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    const status = await checkNineRouterStatus({
      baseUrl: 'http://localhost:20128',
    });

    expect(status.available).toBe(false);
    expect(status.note).toContain('API Key 9Router ditolak');
  });
});

describe('startNineRouterRun', () => {
  let tmpDir: string;
  const origFetch = global.fetch;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlc-9router-test-'));
  });

  afterEach(async () => {
    global.fetch = origFetch;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('streams text completion chunks in purpose: text', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Halo "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"dari 9Router!"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: stream,
    });

    const events: any[] = [];
    const run = startNineRouterRun(
      { provider: '9router', model: 'claude-3-7-sonnet' },
      'text',
      'Halo',
      { cwd: tmpDir, timeoutMs: 5000, onEvent: (e) => events.push(e) },
    );

    const outcome = await run.done;
    expect(outcome.reply).toBe('Halo dari 9Router!');
    expect(events).toContainEqual({ kind: 'text', text: 'Halo ' });
    expect(events).toContainEqual({ kind: 'text', text: 'dari 9Router!' });
  });

  it('executes tool calling loop in purpose: edit to update SCOPE.md', async () => {
    const scopePath = path.join(tmpDir, 'SCOPE.md');
    await fs.promises.writeFile(scopePath, '# Scope Awal\n', 'utf-8');

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Memperbarui scope.',
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'SCOPE.md',
                          content: '# Rencana Scope\n\n## Pemahaman Kebutuhan\nFitur 9Router selesai.',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Scope berhasil diperbarui.',
              },
            },
          ],
        }),
      };
    });

    const run = startNineRouterRun(
      { provider: '9router', model: 'claude-3-7-sonnet' },
      'edit',
      'FASE BRAINSTORMING: perbarui SCOPE.md',
      { cwd: tmpDir, timeoutMs: 5000 },
    );

    const outcome = await run.done;
    expect(outcome.reply).toBe('Scope berhasil diperbarui.');
    const content = await fs.promises.readFile(scopePath, 'utf-8');
    expect(content).toContain('Fitur 9Router selesai.');
  });

  it('handles SSE data stream response without JSON parse errors', async () => {
    const sseResponseText = [
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Halo dari 9Router."},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join('\n');

    let requestBody: any;
    global.fetch = vi.fn().mockImplementation(async (_url, init) => {
      requestBody = JSON.parse(init.body as string);
      return {
        ok: true,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
        text: async () => sseResponseText,
      };
    });

    const run = startNineRouterRun(
      { provider: '9router', model: 'ag/gemini-3.8-flash-high' },
      'edit',
      'halo',
      { cwd: tmpDir, timeoutMs: 5000 },
    );

    const outcome = await run.done;
    expect(outcome.error).toBeUndefined();
    expect(outcome.reply).toBe('Halo dari 9Router.');
    expect(requestBody.stream).toBe(false);
  });
});

