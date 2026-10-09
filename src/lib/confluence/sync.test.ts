import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncTadToConfluence } from './sync';
import { connector, ConnectorRequestError } from './client';
import { drafts, type Draft } from '../../tad/drafts.svelte';

vi.mock('./client', () => ({
  connector: {
    publish: vi.fn(),
  },
  ConnectorRequestError: class extends Error {
    constructor(
      public status: number,
      public body: { error: string; code?: string }
    ) {
      super(body.error);
    }
  },
}));

describe('syncTadToConfluence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sampleDraft: Draft = {
    id: 'test-draft-1',
    markdown: '# TAD - Sample Feature\n\n| **Document Information** |\n|---|---|\n| State | In Review |\n',
    createdAt: '2026-10-07T00:00:00Z',
    updatedAt: '2026-10-07T00:00:00Z',
    source: { jiraKeys: ['CORE-123'] },
    confluence: {
      spaceKey: 'TLC',
      parentId: '111',
      pageId: '999',
      version: 2,
      url: 'https://confluence.example.com/pages/999',
    },
    storageOptions: { mermaid: 'code', mermaidMacro: '', toc: false },
    revisions: [],
    chatHistory: [],
  };

  it('rejects if TAD is not linked to Confluence pageId', async () => {
    const unlinkedDraft = { ...sampleDraft, confluence: { spaceKey: 'TLC', parentId: '' } };
    await expect(syncTadToConfluence(unlinkedDraft)).rejects.toThrow(
      'Dokumen TAD belum dipublish ke Confluence'
    );
  });

  it('publishes and updates draft confluence version', async () => {
    vi.mocked(connector.publish).mockResolvedValueOnce({
      action: 'update',
      page: {
        id: '999',
        title: 'TAD - Sample Feature',
        spaceKey: 'TLC',
        version: 3,
        url: 'https://confluence.example.com/pages/999',
      },
    });

    const updateSpy = vi.spyOn(drafts, 'update').mockImplementation(() => {});
    const saveSpy = vi.spyOn(drafts, 'saveNow').mockImplementation(() => {});

    const res = await syncTadToConfluence(sampleDraft, 'Ubah status ke In Development');
    expect(res.ok).toBe(true);
    expect(res.version).toBe(3);
    expect(res.action).toBe('update');

    expect(connector.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: '999',
        expectedVersion: 2,
        versionMessage: 'Ubah status ke In Development',
      })
    );
    expect(updateSpy).toHaveBeenCalledWith('test-draft-1', expect.objectContaining({
      confluence: expect.objectContaining({ version: 3 }),
    }));
    expect(saveSpy).toHaveBeenCalled();
  });

  it('formats version conflicts clearly', async () => {
    vi.mocked(connector.publish).mockRejectedValueOnce(
      new (ConnectorRequestError as any)(409, { error: 'Version conflict', code: 'conflict' })
    );

    await expect(syncTadToConfluence(sampleDraft)).rejects.toThrow(
      'Halaman sudah diubah langsung di Confluence'
    );
  });
});
