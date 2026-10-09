// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_INFERHUB_MODELS,
  explainInferHubError,
  getInferHubConfig,
  listInferHubModels,
  startInferHubRun,
} from './inferhub.ts';

vi.mock('./keychain.ts', () => ({
  INFERHUB_SERVICE: 'tech-lead-cockpit.inferhub',
  CONFLUENCE_SERVICE: 'tech-lead-cockpit.confluence',
  readKeychain: vi.fn().mockResolvedValue(null),
}));

describe('InferHub Configuration', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.INFERHUB_API_KEY;
    delete process.env.INFERHUB_BASE_URL;
    delete process.env.INFERHUB_MODEL;
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('returns null when no API key is present in env or keychain', async () => {
    const cfg = await getInferHubConfig({});
    expect(cfg).toBeNull();
  });

  it('reads API key, custom base URL, and default model from environment', async () => {
    const cfg = await getInferHubConfig({
      INFERHUB_API_KEY: 'sk-airo-test12345',
      INFERHUB_BASE_URL: 'https://api.inferhub.dev/v1/',
      INFERHUB_MODEL: 'cb/gpt-5.4',
    });
    expect(cfg).toEqual({
      apiKey: 'sk-airo-test12345',
      baseUrl: 'https://api.inferhub.dev/v1',
      defaultModel: 'cb/gpt-5.4',
    });
  });
});

describe('explainInferHubError', () => {
  it('explains 401 authentication errors in Indonesian', () => {
    expect(explainInferHubError(401, 'invalid api key')).toContain('API key tidak valid');
    expect(explainInferHubError(400, 'missing or malformed authorization')).toContain('API key tidak valid');
  });

  it('explains 402 payment and balance errors', () => {
    expect(explainInferHubError(402, 'payment required')).toContain('Saldo InferHub tidak mencukupi');
    expect(explainInferHubError(400, 'insufficient credits')).toContain('Saldo InferHub tidak mencukupi');
  });

  it('explains 429 rate limit errors', () => {
    expect(explainInferHubError(429, 'rate limit exceeded')).toContain('Limit permintaan InferHub tercapai');
  });

  it('passes through other errors', () => {
    expect(explainInferHubError(500, 'Internal server error')).toBe('Internal server error');
  });
});

describe('listInferHubModels', () => {
  it('falls back to default model list when API call fails', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    try {
      const models = await listInferHubModels({
        apiKey: 'dummy',
        baseUrl: 'https://api.inferhub.dev',
        defaultModel: 'ag/claude-sonnet-4-6',
      });
      expect(models).toEqual(DEFAULT_INFERHUB_MODELS);
    } finally {
      global.fetch = origFetch;
    }
  });

  it('parses dynamic models returned by /v1/models', async () => {
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'ag/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
          { id: 'cb/gpt-5.4', name: 'GPT 5.4' },
        ],
      }),
    });
    try {
      const models = await listInferHubModels({
        apiKey: 'dummy',
        baseUrl: 'https://api.inferhub.dev',
        defaultModel: 'ag/claude-sonnet-4-6',
      });
      expect(models).toEqual([
        { id: '', label: 'Default (ag/claude-sonnet-4-6)' },
        { id: 'ag/claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (ag/claude-sonnet-4-6)' },
        { id: 'cb/gpt-5.4', label: 'GPT 5.4 (cb/gpt-5.4)' },
      ]);
    } finally {
      global.fetch = origFetch;
    }
  });
});

describe('startInferHubRun', () => {
  let tmpDir: string;
  const origEnv = { ...process.env };
  const origFetch = global.fetch;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlc-inferhub-test-'));
    process.env.INFERHUB_API_KEY = 'sk-airo-test-key';
  });

  afterEach(async () => {
    process.env = { ...origEnv };
    global.fetch = origFetch;
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when API key is missing', async () => {
    delete process.env.INFERHUB_API_KEY;
    const run = startInferHubRun(
      { provider: 'inferhub', model: 'ag/claude-sonnet-4-6' },
      'text',
      'halo',
      { cwd: tmpDir, timeoutMs: 5000 },
    );
    const result = await run.done;
    expect(result.error).toContain('InferHub API key belum diset');
  });

  it('streams text completion chunks in purpose: text', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Halo "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Tech Lead!"}}]}\n\n',
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
    const run = startInferHubRun(
      { provider: 'inferhub', model: 'ag/claude-sonnet-4-6' },
      'text',
      'Tulis balasan WA',
      { cwd: tmpDir, timeoutMs: 5000, onEvent: (e) => events.push(e) },
    );

    const outcome = await run.done;
    expect(outcome.reply).toBe('Halo Tech Lead!');
    expect(outcome.error).toBeUndefined();
    expect(events).toContainEqual({ kind: 'text', text: 'Halo ' });
    expect(events).toContainEqual({ kind: 'text', text: 'Tech Lead!' });
  });

  it('executes tool calling loop in purpose: edit to update TAD.md', async () => {
    const tadPath = path.join(tmpDir, 'TAD.md');
    await fs.promises.writeFile(tadPath, '# TAD - Asal\n\nIsi lama', 'utf-8');

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
                  content: 'Saya akan menulis TAD baru.',
                  tool_calls: [
                    {
                      id: 'call-1',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'TAD.md',
                          content: '# TAD - Fitur Baru\n\n## Objective\nSukses.',
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
                content: 'TAD telah berhasil diperbarui.',
              },
            },
          ],
        }),
      };
    });

    const events: any[] = [];
    const run = startInferHubRun(
      { provider: 'inferhub', model: 'ag/claude-sonnet-4-6' },
      'edit',
      'Tolong update TAD',
      { cwd: tmpDir, timeoutMs: 5000, onEvent: (e) => events.push(e) },
    );

    const outcome = await run.done;
    expect(outcome.reply).toBe('TAD telah berhasil diperbarui.');
    expect(outcome.sessionId).toBeDefined();

    // Verify file on disk was modified by write_file tool
    const updatedContent = await fs.promises.readFile(tadPath, 'utf-8');
    expect(updatedContent).toBe('# TAD - Fitur Baru\n\n## Objective\nSukses.');
    expect(events).toContainEqual({ kind: 'tool', text: 'Menulis TAD.md' });
  });

  it('falls back to extracting markdown code block if tool calling was not used', async () => {
    const tadPath = path.join(tmpDir, 'TAD.md');
    await fs.promises.writeFile(tadPath, '# TAD - Asal\n', 'utf-8');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content:
                'Berikut adalah dokumen TAD yang diperbarui:\n\n```markdown\n# TAD - Hasil Ekstrak\n\n## Objective\nBerhasil diekstrak tanpa tool call.\n```',
            },
          },
        ],
      }),
    });

    const run = startInferHubRun(
      { provider: 'inferhub', model: 'cb/gpt-5.4' },
      'edit',
      'Buat TAD baru',
      { cwd: tmpDir, timeoutMs: 5000 },
    );

    const outcome = await run.done;
    expect(outcome.reply).toContain('Hasil Ekstrak');

    const updated = await fs.promises.readFile(tadPath, 'utf-8');
    expect(updated).toContain('# TAD - Hasil Ekstrak');
    expect(updated).toContain('Berhasil diekstrak tanpa tool call.');
  });

  it('rejects writing files outside the workspace directory', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Coba tulis file terlarang.',
              tool_calls: [
                {
                  id: 'call-hack',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({
                      path: '../../etc/passwd',
                      content: 'hacked',
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    });

    const events: any[] = [];
    const run = startInferHubRun(
      { provider: 'inferhub', model: 'ag/claude-sonnet-4-6' },
      'edit',
      'Tes security',
      { cwd: tmpDir, timeoutMs: 5000, onEvent: (e) => events.push(e) },
    );

    await run.done;
    expect(events).toContainEqual({ kind: 'tool', text: 'Menulis passwd (ditolak)' });
  });

  it('aborts cleanly when abort() is called', async () => {
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          reject(new Error('Operation aborted'));
        });
      });
    });

    const run = startInferHubRun(
      { provider: 'inferhub', model: 'ag/claude-sonnet-4-6' },
      'text',
      'halo',
      { cwd: tmpDir, timeoutMs: 10000 },
    );

    setTimeout(() => run.abort?.(), 50);
    const outcome = await run.done;
    expect(outcome.error).toBeDefined();
  });
});
