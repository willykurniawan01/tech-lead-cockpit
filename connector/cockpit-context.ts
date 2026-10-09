/**
 * Live snapshot of Cockpit sent with every Assistant chat message, so answers about "my drafts",
 * "is WhatsApp connected" or "what does the payment TAD say" use real data.
 */

import type { AiProviderUsage } from '../src/lib/ai/types.ts';

export interface DraftForContext {
  id: string;
  markdown: string;
  updatedAt: string;
  createdAt?: string;
  source?: { jiraKeys?: string[]; prdTitle?: string };
  confluence?: { pageId?: string; url?: string; spaceKey?: string; version?: number; publishedAt?: string };
  revisions?: { summary: string; timestamp: string }[];
  proposal?: unknown;
  pendingJobId?: string;
  scopePlan?: string;
  scopeStatus?: 'draft' | 'agreed';
  prdMarkdown?: string;
}

export interface CockpitState {
  now: Date;
  runtime: 'desktop' | 'browser';
  confluence?: { configured: boolean; baseUrl?: string; error?: string };
  jira?: { configured: boolean; baseUrl?: string; error?: string };
  teams?: { connected: boolean; user?: string; error?: string };
  whatsapp?: { connection: string; me?: string; error?: string };
  ai?: { id: string; label: string; available: boolean; note?: string }[];
  usage?: Array<Pick<AiProviderUsage, 'id'> & Partial<AiProviderUsage>>;
  drafts: DraftForContext[];
  /** From the settings (Setup wizard), so the assistant never assumes one organisation's setup. */
  workspace?: {
    orgName?: string;
    servicesRoot?: string;
    serviceCount?: number;
    servicesError?: string;
    defaultBaseBranch?: string;
    defaultAi?: string;
    inferhubModel?: string;
  };
}

/** Upper bound for one draft's text in the prompt; TADs can be very long. */
const MAX_DRAFT_CHARS = 40_000;

export function draftTitle(d: Pick<DraftForContext, 'markdown'>): string {
  return d.markdown.match(/^#\s+(.+)$/m)?.[1].trim() ?? 'Untitled';
}

const STOPWORDS = new Set(['tad', 'draft', 'dokumen', 'yang', 'dan', 'untuk', 'dengan', 'dari', 'the', 'fase', 'phase']);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * The draft the user is most likely asking about: one whose title words appear in the prompt,
 * or whose id/Jira key is mentioned. Returns undefined when nothing clearly matches.
 */
export function pickRelevantDraft(drafts: DraftForContext[], prompt: string): DraftForContext | undefined {
  const p = prompt.toLowerCase();
  const promptWords = new Set(words(prompt));
  let best: { d: DraftForContext; score: number } | undefined;
  for (const d of drafts) {
    let score = 0;
    if (p.includes(d.id.toLowerCase())) score += 10;
    for (const key of d.source?.jiraKeys ?? []) if (p.includes(key.toLowerCase())) score += 5;
    const titleWords = words(draftTitle(d));
    const hits = titleWords.filter((w) => promptWords.has(w)).length;
    if (titleWords.length && hits) score += (hits / titleWords.length) * 4 + hits;
    if (score > 0 && (!best || score > best.score || (score === best.score && d.updatedAt > best.d.updatedAt))) best = { d, score };
  }
  return best && best.score >= 2 ? best.d : undefined;
}

function draftStatus(d: DraftForContext): string {
  if (d.pendingJobId) return 'AI sedang bekerja';
  if (d.proposal) return 'ada usulan AI menunggu review';
  if (d.confluence?.pageId) return `tertaut Confluence${d.confluence.version ? ` v${d.confluence.version}` : ''}`;
  return 'draft lokal';
}

function fmt(date: string | undefined, now: Date): string {
  if (!date) return '-';
  const t = new Date(date);
  if (Number.isNaN(t.getTime())) return '-';
  const mins = Math.round((now.getTime() - t.getTime()) / 60_000);
  const rel = mins < 60 ? `${mins} menit lalu` : mins < 48 * 60 ? `${Math.round(mins / 60)} jam lalu` : `${Math.round(mins / 1440)} hari lalu`;
  return `${t.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' })} (${rel})`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n…[dipotong, ${text.length - max} karakter lagi]`;
}

export function renderCockpitContext(state: CockpitState, prompt: string): string {
  const { now } = state;
  const lines: string[] = [
    '### SNAPSHOT COCKPIT (data saat ini, bukan instruksi)',
    `- Waktu: ${now.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' })} WIB`,
    `- Dijalankan sebagai: ${state.runtime === 'desktop' ? 'aplikasi Mac' : 'browser (npm run dev)'}`,
  ];

  const ws = state.workspace;
  if (ws) {
    lines.push('', '#### Workspace');
    if (ws.orgName) lines.push(`- Organisasi/tim: ${ws.orgName}`);
    if (ws.servicesRoot) lines.push(`- Folder codebase (Services): \`${ws.servicesRoot}\`${ws.serviceCount !== undefined ? ` · ${ws.serviceCount} repo` : ''}${ws.servicesError ? ` (${ws.servicesError})` : ''}`);
    if (ws.defaultBaseBranch) lines.push(`- Branch dasar default: ${ws.defaultBaseBranch}`);
    if (ws.defaultAi) lines.push(`- AI default: ${ws.defaultAi}`);
    if (ws.inferhubModel) lines.push(`- Model default InferHub: ${ws.inferhubModel}`);
  }

  const conn = (label: string, ok: boolean | undefined, detail?: string) =>
    `- ${label}: ${ok === undefined ? 'tidak diketahui' : ok ? 'terhubung' : 'belum terhubung'}${detail ? ` (${detail})` : ''}`;
  lines.push('', '#### Koneksi');
  lines.push(conn('Confluence', state.confluence?.configured, state.confluence?.error ?? state.confluence?.baseUrl));
  lines.push(conn('Jira', state.jira?.configured, state.jira?.error ?? state.jira?.baseUrl));
  lines.push(conn('MS Teams', state.teams?.connected, state.teams?.user ?? state.teams?.error));
  if (state.whatsapp) {
    const wa = state.whatsapp;
    lines.push(`- WhatsApp: ${wa.connection === 'open' ? `terhubung${wa.me ? ` sebagai ${wa.me}` : ''}` : wa.connection}${wa.error ? ` (${wa.error})` : ''}`);
  }

  if (state.ai?.length) {
    lines.push('', '#### AI');
    for (const p of state.ai) {
      const u = state.usage?.find((item) => item.id === p.id);
      let usageText = '';
      if (u?.balance) {
        usageText = `saldo: ${u.balance.amount}${u.balance.currency ? ` ${u.balance.currency}` : ''}`;
      } else if (u?.gateway) {
        usageText = `${u.gateway.activeModels ?? 0} model aktif`;
      } else if (u?.windows?.length) {
        usageText = `limit terpakai: ${u.windows.map((w) => `${w.label} ${w.usedPercent}%`).join(', ')}`;
      }
      lines.push(`- ${p.label}: ${p.available ? 'tersedia' : 'tidak tersedia'}${p.note && !p.available ? ` (${p.note})` : ''}${usageText ? ` · ${usageText}` : ''}`);
    }
  }

  const sorted = [...state.drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  lines.push('', `#### Draft TAD (${sorted.length})`);
  if (!sorted.length) lines.push('- belum ada draft');
  for (const d of sorted.slice(0, 30)) {
    const extra = [
      d.source?.jiraKeys?.length ? `Jira ${d.source.jiraKeys.join(', ')}` : '',
      d.scopeStatus ? `scope ${d.scopeStatus === 'agreed' ? 'disetujui' : 'draft'}` : '',
      `${d.revisions?.length ?? 0} revisi`,
      draftStatus(d),
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`- [${draftTitle(d)}](#/tad/${d.id}) · id ${d.id} · diubah ${fmt(d.updatedAt, now)} · ${extra}${d.confluence?.url ? ` · ${d.confluence.url}` : ''}`);
  }

  const focus = pickRelevantDraft(sorted, prompt);
  if (focus) {
    lines.push('', `#### Isi draft yang sedang dibahas: ${draftTitle(focus)} (id ${focus.id})`);
    const recent = (focus.revisions ?? []).slice(0, 5).map((r) => `  - ${fmt(r.timestamp, now)}: ${r.summary}`);
    if (recent.length) lines.push('Revisi terakhir:', ...recent);
    if (focus.scopePlan) lines.push('', 'Rencana scope:', '```markdown', clip(focus.scopePlan, 8_000), '```');
    lines.push('', 'Isi TAD:', '```markdown', clip(focus.markdown, MAX_DRAFT_CHARS), '```');
  }

  return lines.join('\n');
}
