import { DEFAULT_STORAGE_OPTIONS, type StorageOptions } from '../lib/confluence/storage';
import { htmlToMarkdown, replaceBalancedHtmlTables } from '../lib/markdown/html-to-markdown';
import type { AiProviderId } from '../lib/ai/types';
import { api } from '../lib/api-base';
import type { PrdSource } from '../lib/prd/confluence-prd';

export interface ConfluenceTarget {
  spaceKey: string;
  parentId: string;
  /** Set after the first publish or save draft; later publishes update this page. */
  pageId?: string;
  version?: number;
  status?: 'current' | 'draft';
  url?: string;
  publishedAt?: string;
}

export interface Revision {
  id: string;
  timestamp: string;
  summary: string;
  markdown: string;
}

/** AI edit waiting for the user's review before it touches the TAD. */
export interface Proposal {
  id: string;
  createdAt: string;
  provider: AiProviderId;
  prompt: string;
  reply: string;
  /** TAD the AI started from; the diff is computed against this. */
  base: string;
  proposed: string;
  /** The AI stopped early (error/timeout) after editing. */
  partial: boolean;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  revisionId?: string;
  proposalId?: string;
  isError?: boolean;
}

export interface Draft {
  id: string;
  markdown: string;
  prdMarkdown?: string;
  /** PRD pulled from a Confluence page: where it lives and which version the TAD was based on. */
  prdSource?: PrdSource;
  createdAt: string;
  updatedAt: string;
  source: {
    jiraKeys: string[];
    figmaUrl?: string;
    prdTitle?: string;
    mrUrl?: string;
  };
  confluence: ConfluenceTarget;
  storageOptions: StorageOptions;
  revisions: Revision[];
  chatHistory: ChatMessage[];
  /** AI generator job still running for this draft; resumed after a reload. */
  pendingJobId?: string;
  /** Inputs for the AI analysis besides the PRD. */
  figmaLinks?: { title?: string; url: string }[];
  /** Names of supporting documents stored in the draft's AI workspace (docs/). */
  supportingDocs?: { name: string; size: number; encrypted?: boolean }[];
  servicesRoot?: string;
  /** Last session per provider, so the next chat message continues the same conversation. */
  aiSessions?: Partial<Record<AiProviderId, string>>;
  proposal?: Proposal;
  /** Scope agreed in the brainstorming phase (SCOPE.md), before the full TAD is generated. */
  scopePlan?: string;
  scopeStatus?: 'draft' | 'agreed';
}

const KEY = 'tlc.tad.drafts.v2';
const SELECTED_KEY = 'tlc.tad.selected';

export function draftTitle(d: Draft): string {
  const m = d.markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : 'Untitled';
}

const LAST_DISK_SYNC_KEY = 'tlc.tad.lastDiskSync';
const PENDING_DELETES_KEY = 'tlc.tad.pendingDeletes';

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the disk copy is what matters */
  }
}

function load(): Draft[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as Draft[]).map(normalize);
  } catch {
    return [];
  }
}

/** Fills fields older drafts lack and repairs known import mistakes. */
function normalize(d: Draft): Draft {
  let markdown = d.markdown;
  let source = d.source || { jiraKeys: [] };
  let confluence = d.confluence || { spaceKey: '', parentId: '' };

  // Fixup 1: If imported from Confluence, remove erroneous prdTitle
  if (confluence.pageId && source.prdTitle && /^TAD\s+[—-]/i.test(source.prdTitle)) {
    source = { ...source, prdTitle: undefined };
  }

  // Fixup 2: Extract spaceKey from confluence.url if missing
  if (confluence.url && !confluence.spaceKey) {
    const m = confluence.url.match(/\/spaces\/([^/]+)/);
    if (m) confluence = { ...confluence, spaceKey: m[1] };
  }

  // Deduplicate consecutive identical top H1 titles caused by earlier normalize loops
  const topH1Match = markdown.match(/^#\s+([^\n]+)\n+/);
  if (topH1Match) {
    const titleText = topH1Match[1].trim();
    const escaped = titleText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dupRegex = new RegExp(`^(?:#\\s+${escaped}\\s*\\n+)+`);
    markdown = markdown.replace(dupRegex, `# ${titleText}\n\n`);
  }

  // Fixup 3: If imported from Confluence and markdown lacks an H1 title (e.g. starts with Document Information)
  const firstH1 = markdown.match(/^#\s+([^\n]+)/m)?.[1]?.trim();
  const lacksTitle = !firstH1 || /^Document Information$/i.test(firstH1);
  if (confluence.pageId && lacksTitle) {
    const revSummary = d.revisions?.[0]?.summary || '';
    const titleMatch = revSummary.match(/Diimpor dari Confluence:\s*(.*?)\s*\(v\d+\)/);
    let title = titleMatch ? titleMatch[1].trim() : '';
    if (!title && confluence.url) {
      const urlMatch = confluence.url.match(/pages\/\d+\/([^/?#]+)/);
      if (urlMatch) title = decodeURIComponent(urlMatch[1].replace(/\+/g, ' '));
    }
    if (title) {
      markdown = `# ${title}\n\n${markdown}`;
    }
  }

  // Fixup 4: Clean up any raw HTML task tables left over from older imports,
  // and heal corrupted drafts where non-greedy regex left unbalanced tables or dangling tags
  const openCount = (markdown.match(/<table\b/gi) || []).length;
  const closeCount = (markdown.match(/<\/table>/gi) || []).length;
  const isCorrupted = openCount < closeCount || markdown.includes('</td></tr>') || markdown.includes('</tbody></table>');

  if (isCorrupted && d.revisions && d.revisions.length > 0) {
    for (const rev of d.revisions) {
      if (rev.markdown) {
        const revOpens = (rev.markdown.match(/<table\b/gi) || []).length;
        const revCloses = (rev.markdown.match(/<\/table>/gi) || []).length;
        if (revOpens > 0 && revOpens === revCloses) {
          markdown = rev.markdown;
          break;
        }
      }
    }
  }

  if (markdown.includes('<table')) {
    try {
      markdown = replaceBalancedHtmlTables(markdown, (tableHtml) => {
        const clean = htmlToMarkdown(tableHtml).trim();
        return clean ? `${clean}\n\n` : tableHtml;
      });
    } catch {
      /* keep original if parse fails */
    }
  }

  // Final cleanup: strip any remaining orphaned table tags if any left
  if (markdown.includes('</td>') || markdown.includes('</tr>') || markdown.includes('</table>')) {
    markdown = markdown.replace(/<\/?(?:table|tbody|thead|tfoot|tr|td|th|colgroup|col)\b[^>]*>/gi, '');
  }

  return {
    ...d,
    markdown,
    source,
    confluence,
    revisions: d.revisions || [
      {
        id: crypto.randomUUID(),
        timestamp: d.createdAt || new Date().toISOString(),
        summary: 'Inisiasi dokumen',
        markdown,
      },
    ],
    chatHistory: d.chatHistory || [],
  };
}

const CONNECTOR_HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };

async function diskCall<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(api(`/api/connector${path}`), {
    method: body === undefined ? 'GET' : 'POST',
    headers: CONNECTOR_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function persist(drafts: Draft[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    // Storage full or blocked: the in-memory drafts still work for this session.
  }
}

/**
 * Where drafts live: files under ~/.tech-lead-cockpit/drafts (via the connector) are the source of
 * truth, so rebuilding or reinstalling the app, or using the browser and the Mac app side by side,
 * never loses a TAD. localStorage is only a cache that makes the first paint instant and keeps
 * edits safe while the connector is unreachable.
 */
export type DiskState = 'pending' | 'saved' | 'offline';

class DraftStore {
  drafts = $state<Draft[]>(load());
  selectedId = $state<string | null>(null);
  disk = $state<DiskState>('pending');
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** JSON last written to (or read from) disk per draft, to upload only what changed. */
  #onDisk = new Map<string, string>();
  #syncing = false;

  constructor() {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SELECTED_KEY);
    } catch {
      /* ignore */
    }
    this.selectedId = this.drafts.find((d) => d.id === saved)?.id ?? this.drafts[0]?.id ?? null;
    if (typeof window !== 'undefined' && !import.meta.env?.VITEST) {
      void this.syncFromDisk();
      // Pick up edits made in the other client (browser vs Mac app) when coming back to this one.
      window.addEventListener('focus', () => void this.syncFromDisk());
    }
  }

  /**
   * Merges the disk copy with the local cache: per draft the newest `updatedAt` wins. A draft only in
   * the cache is kept (and uploaded) when it was never synced or edited since the last sync;
   * otherwise it was deleted elsewhere and is dropped.
   */
  async syncFromDisk() {
    if (this.#syncing) return;
    this.#syncing = true;
    try {
      for (const id of this.#pendingDeletes()) {
        await diskCall('/drafts/delete', { id });
        this.#setPendingDeletes(this.#pendingDeletes().filter((x) => x !== id));
      }
      const remote = (await diskCall<Draft[]>('/drafts')).map(normalize);
      const lastSync = readLocal(LAST_DISK_SYNC_KEY);
      const byId = new Map(remote.map((d) => [d.id, d]));
      const merged: Draft[] = [];
      for (const local of $state.snapshot(this.drafts) as Draft[]) {
        const r = byId.get(local.id);
        byId.delete(local.id);
        if (r) merged.push(r.updatedAt > local.updatedAt ? r : local);
        else if (!lastSync || local.updatedAt > lastSync) merged.push(local);
      }
      merged.push(...byId.values());

      this.#onDisk = new Map(remote.map((d) => [d.id, JSON.stringify(d)]));
      const changed = merged.some((d, i) => JSON.stringify(d) !== JSON.stringify(this.drafts[i]));
      if (changed || merged.length !== this.drafts.length) {
        this.drafts = merged;
        if (!merged.some((d) => d.id === this.selectedId)) this.selectedId = this.sorted[0]?.id ?? null;
      }
      persist(merged);
      await this.#flush(merged);
      writeLocal(LAST_DISK_SYNC_KEY, new Date().toISOString());
    } catch {
      this.disk = 'offline';
    } finally {
      this.#syncing = false;
    }
  }

  async #flush(list: Draft[]) {
    try {
      for (const d of list) {
        const json = JSON.stringify(d);
        if (this.#onDisk.get(d.id) === json) continue;
        await diskCall('/drafts/save', { draft: d });
        this.#onDisk.set(d.id, json);
      }
      this.disk = 'saved';
    } catch {
      this.disk = 'offline';
    }
  }

  #pendingDeletes(): string[] {
    try {
      return JSON.parse(readLocal(PENDING_DELETES_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  }

  #setPendingDeletes(ids: string[]) {
    writeLocal(PENDING_DELETES_KEY, JSON.stringify(ids));
  }

  get selected(): Draft | undefined {
    return this.drafts.find((d) => d.id === this.selectedId);
  }

  get sorted(): Draft[] {
    return [...this.drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  select(id: string) {
    this.selectedId = id;
    try {
      localStorage.setItem(SELECTED_KEY, id);
    } catch {
      /* ignore */
    }
  }

  create(
    markdown: string,
    source: Draft['source'] = { jiraKeys: [] },
    prdMarkdown?: string,
    summary = 'Inisiasi draft TAD',
    confluenceTarget?: ConfluenceTarget
  ): Draft {
    const now = new Date().toISOString();
    const initialRev: Revision = {
      id: crypto.randomUUID(),
      timestamp: now,
      summary,
      markdown,
    };
    const draft: Draft = {
      id: crypto.randomUUID(),
      markdown,
      prdMarkdown,
      createdAt: now,
      updatedAt: now,
      source,
      confluence: confluenceTarget || { spaceKey: '', parentId: '' },
      storageOptions: { ...DEFAULT_STORAGE_OPTIONS },
      revisions: [initialRev],
      chatHistory: [
        {
          id: crypto.randomUUID(),
          sender: 'system',
          text: `Draft dibuat: "${summary}". Gunakan chat generator untuk memperluas atau mengedit TAD.`,
          timestamp: now,
          revisionId: initialRev.id,
        },
      ],
    };
    this.drafts.push(draft);
    this.select(draft.id);
    this.saveNow();
    return draft;
  }

  update(id: string, patch: Partial<Omit<Draft, 'id'>>) {
    const d = this.drafts.find((x) => x.id === id);
    if (!d) return;
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    this.scheduleSave();
  }

  applyRevision(id: string, newMarkdown: string, summary: string): Revision | undefined {
    const d = this.drafts.find((x) => x.id === id);
    if (!d) return undefined;
    const now = new Date().toISOString();
    // Manual edits since the last revision would otherwise vanish from history.
    if (d.revisions[0] && d.markdown !== d.revisions[0].markdown) {
      d.revisions.unshift({ id: crypto.randomUUID(), timestamp: now, summary: 'Edit manual', markdown: d.markdown });
    }
    const rev: Revision = {
      id: crypto.randomUUID(),
      timestamp: now,
      summary,
      markdown: newMarkdown,
    };
    d.markdown = newMarkdown;
    d.updatedAt = now;
    d.revisions.unshift(rev); // newest first
    this.scheduleSave();
    return rev;
  }

  rollback(draftId: string, revisionId: string): boolean {
    const d = this.drafts.find((x) => x.id === draftId);
    if (!d) return false;
    const targetRev = d.revisions.find((r) => r.id === revisionId);
    if (!targetRev) return false;

    const now = new Date().toISOString();
    if (d.revisions[0] && d.markdown !== d.revisions[0].markdown) {
      d.revisions.unshift({ id: crypto.randomUUID(), timestamp: now, summary: 'Edit manual', markdown: d.markdown });
    }
    const summary = `Rollback ke revisi: ${targetRev.summary}`;
    const rollbackRev: Revision = {
      id: crypto.randomUUID(),
      timestamp: now,
      summary,
      markdown: targetRev.markdown,
    };
    d.markdown = targetRev.markdown;
    d.updatedAt = now;
    d.revisions.unshift(rollbackRev);
    d.chatHistory.push({
      id: crypto.randomUUID(),
      sender: 'system',
      text: `Dokumen di-rollback ke versi "${targetRev.summary}".`,
      timestamp: now,
      revisionId: rollbackRev.id,
    });
    this.scheduleSave();
    return true;
  }

  setProposal(draftId: string, proposal: Omit<Proposal, 'id' | 'createdAt'>): Proposal | undefined {
    const d = this.drafts.find((x) => x.id === draftId);
    if (!d) return undefined;
    d.proposal = { ...proposal, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.saveNow();
    return d.proposal;
  }

  /** Applies the reviewed result (all or some blocks) as a regular, rollback-able revision. */
  acceptProposal(draftId: string, merged: string, accepted: number, total: number): Revision | undefined {
    const d = this.drafts.find((x) => x.id === draftId);
    if (!d?.proposal) return undefined;
    const p = d.proposal;
    const who = p.provider === 'claude' ? 'Claude' : 'Antigravity';
    const scope = accepted === total ? '' : ` (${accepted}/${total} bagian)`;
    const rev = this.applyRevision(draftId, merged, `AI ${who}${p.partial ? ', sebagian' : ''}${scope}: ${p.prompt.slice(0, 40)}`);
    d.proposal = undefined;
    this.addChatMessage(draftId, {
      sender: 'system',
      text: accepted === total ? 'Usulan AI diterapkan seluruhnya.' : `Usulan AI diterapkan ${accepted} dari ${total} bagian.`,
      revisionId: rev?.id,
    });
    return rev;
  }

  rejectProposal(draftId: string) {
    const d = this.drafts.find((x) => x.id === draftId);
    if (!d?.proposal) return;
    d.proposal = undefined;
    this.addChatMessage(draftId, { sender: 'system', text: 'Usulan AI ditolak. TAD tidak diubah.' });
  }

  addChatMessage(
    draftId: string,
    msg: { sender: ChatMessage['sender']; text: string; revisionId?: string; proposalId?: string; isError?: boolean }
  ) {
    const d = this.drafts.find((x) => x.id === draftId);
    if (!d) return;
    d.chatHistory.push({
      id: crypto.randomUUID(),
      ...msg,
      timestamp: new Date().toISOString(),
    });
    this.scheduleSave();
  }

  remove(id: string) {
    this.drafts = this.drafts.filter((d) => d.id !== id);
    if (this.selectedId === id) this.selectedId = this.sorted[0]?.id ?? null;
    this.saveNow();
    this.#onDisk.delete(id);
    diskCall('/drafts/delete', { id }).catch(() => {
      // Retried on the next sync so the draft doesn't come back from disk.
      this.#setPendingDeletes([...new Set([...this.#pendingDeletes(), id])]);
      this.disk = 'offline';
    });
  }

  scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    clearTimeout(this.#saveTimer);
    const snapshot = $state.snapshot(this.drafts) as Draft[];
    persist(snapshot);
    if (typeof window !== 'undefined' && !import.meta.env?.VITEST) void this.#flush(snapshot);
  }
}

export const drafts = new DraftStore();
