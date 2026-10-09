import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startGeneratorJob } from './generator-client';
import type { Draft } from './drafts.svelte';
import type { AiSelection } from '../lib/ai/types';

describe('startGeneratorJob', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const dummyDraft: Draft = {
    id: 'draft-123',
    markdown: '# Original TAD\n\nContent here',
    revisions: [],
    chatHistory: [],
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: '2026-10-05T00:00:00Z',
    servicesRoot: '/Users/test/services',
    source: { jiraKeys: [] },
    confluence: { spaceKey: 'ENG', parentId: '' },
    storageOptions: { mermaid: 'attachment', mermaidMacro: 'mermaid-cloud', toc: true },
  };

  const ai: AiSelection = { provider: 'claude', model: 'claude-3-7-sonnet' };

  it('sends default draft.markdown when no override is provided', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job-1', status: 'running' }), { status: 200 }));

    const res = await startGeneratorJob(dummyDraft, 'Perbaiki TAD', ai, 'edit');
    expect(res.job.id).toBe('job-1');
    expect(res.alreadyRunning).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.tadMarkdown).toBe('# Original TAD\n\nContent here');
    expect(body.prompt).toBe('Perbaiki TAD');
  });

  it('sends tadMarkdownOverride when refining a proposed document', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'job-2', status: 'running' }), { status: 200 }));

    const refinedDraftText = '# Refined TAD\n\nNew proposed content';
    const res = await startGeneratorJob(
      dummyDraft,
      'Revisi / Refine usulan sebelumnya: Tambahkan endpoint X',
      ai,
      'edit',
      refinedDraftText,
    );

    expect(res.job.id).toBe('job-2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.tadMarkdown).toBe(refinedDraftText);
    expect(body.prompt).toBe('Revisi / Refine usulan sebelumnya: Tambahkan endpoint X');
  });

  it('handles 409 conflict when job is already running', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'conflict', job: { id: 'job-running', status: 'running' } }), {
        status: 409,
      }),
    );

    const res = await startGeneratorJob(dummyDraft, 'Instruksi', ai, 'edit');
    expect(res.alreadyRunning).toBe(true);
    expect(res.job.id).toBe('job-running');
  });
});
