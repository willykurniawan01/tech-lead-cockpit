import { connector, ConnectorRequestError } from './client';
import { toConfluenceStorage } from './storage';
import { diagramUploads } from '../../tad/export';
import { drafts, type Draft, draftTitle } from '../../tad/drafts.svelte';

export interface SyncResult {
  ok: boolean;
  version: number;
  url: string;
  action: 'create' | 'update';
}

export async function syncTadToConfluence(
  draft: Draft,
  versionMessage = 'Update status TAD dari Task Board'
): Promise<SyncResult> {
  if (!draft.confluence.pageId) {
    throw new Error('Dokumen TAD belum dipublish ke Confluence. Silakan publish terlebih dahulu.');
  }

  const opts = draft.storageOptions || {
    mermaid: 'attachment',
    mermaidMacro: 'mermaid-cloud',
    toc: true,
  };
  const storage = toConfluenceStorage(draft.markdown, opts);
  const attachments =
    opts.mermaid === 'attachment' && storage.diagrams.length ? await diagramUploads(storage.diagrams) : [];

  const title = storage.title || draftTitle(draft);

  try {
    const res = await connector.publish({
      spaceKey: draft.confluence.spaceKey,
      title,
      storage: storage.xhtml,
      parentId: draft.confluence.parentId || undefined,
      pageId: draft.confluence.pageId,
      expectedVersion: draft.confluence.version,
      versionMessage: versionMessage.trim() || undefined,
      attachments,
      context: {
        draftId: draft.id,
        mrUrl: draft.source?.mrUrl,
        jiraKeys: draft.source?.jiraKeys || [],
      },
    });

    drafts.update(draft.id, {
      confluence: {
        ...draft.confluence,
        pageId: res.page.id,
        version: res.page.version,
        url: res.page.url,
        publishedAt: new Date().toISOString(),
      },
    });
    drafts.saveNow();

    return {
      ok: true,
      version: res.page.version,
      url: res.page.url,
      action: res.action,
    };
  } catch (err) {
    if (err instanceof ConnectorRequestError && (err.body.code === 'conflict' || err.body.code === 'exists')) {
      throw new Error(
        `Halaman sudah diubah langsung di Confluence setelah versi dasar draft (v${draft.confluence.version}). Buka TAD ini lalu klik "Lihat & gabungkan" di banner kuning, kemudian sync lagi.`
      );
    }
    throw err;
  }
}
