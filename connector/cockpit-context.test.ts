// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { pickRelevantDraft, renderCockpitContext, type CockpitState, type DraftForContext } from './cockpit-context.ts';
import { withCockpitContext } from './assistant.ts';

const draft = (id: string, title: string, extra: Partial<DraftForContext> = {}): DraftForContext => ({
  id,
  markdown: `# ${title}\n\n## Objective\nIsi ${title}`,
  updatedAt: '2026-10-04T05:00:00.000Z',
  revisions: [{ summary: 'Inisiasi dokumen', timestamp: '2026-10-04T05:00:00.000Z' }],
  ...extra,
});

const motion = draft('aaaa-1111', 'TAD - Motion Circle', { source: { jiraKeys: ['MPAY-321'] }, confluence: { pageId: '99', url: 'https://x/wiki/99', version: 4 } });
const qris = draft('bbbb-2222', 'TAD - QRIS Refund Partner', { proposal: {} });

describe('pickRelevantDraft', () => {
  it('matches on title words, Jira key or id', () => {
    expect(pickRelevantDraft([motion, qris], 'ringkas TAD motion circle dong')?.id).toBe('aaaa-1111');
    expect(pickRelevantDraft([motion, qris], 'status MPAY-321 gimana?')?.id).toBe('aaaa-1111');
    expect(pickRelevantDraft([motion, qris], 'lihat bbbb-2222')?.id).toBe('bbbb-2222');
    expect(pickRelevantDraft([motion, qris], 'refund qris butuh service apa?')?.id).toBe('bbbb-2222');
  });

  it('returns nothing for unrelated questions', () => {
    expect(pickRelevantDraft([motion, qris], 'cara hubungkan whatsapp?')).toBeUndefined();
    expect(pickRelevantDraft([motion, qris], 'buat TAD baru')).toBeUndefined();
  });
});

describe('renderCockpitContext', () => {
  const state: CockpitState = {
    now: new Date('2026-10-04T08:00:00.000Z'),
    runtime: 'desktop',
    confluence: { configured: true, baseUrl: 'https://acme.atlassian.net/wiki' },
    jira: { configured: false, error: 'URL Jira belum diatur (Setup → Jira & Confluence).' },
    teams: { connected: true, user: 'Willy <willy@x>' },
    whatsapp: { connection: 'open', me: 'Willy' },
    ai: [
      { id: 'claude', label: 'Claude CLI', available: true },
      { id: 'antigravity', label: 'Antigravity CLI', available: false, note: 'agy tidak ditemukan' },
    ],
    usage: [{ id: 'claude', windows: [{ label: 'Sesi (5 jam)', usedPercent: 40 }] }],
    drafts: [motion, qris],
  };

  it('lists connections, AI and drafts with clickable links', () => {
    const out = renderCockpitContext(state, 'apa kabar?');
    expect(out).toContain('aplikasi Mac');
    expect(out).toContain('Confluence: terhubung');
    expect(out).toContain('Jira: belum terhubung (URL Jira belum diatur (Setup → Jira & Confluence).)');
    expect(out).toContain('WhatsApp: terhubung sebagai Willy');
    expect(out).toContain('Claude CLI: tersedia · limit terpakai: Sesi (5 jam) 40%');
    expect(out).toContain('Antigravity CLI: tidak tersedia (agy tidak ditemukan)');
    expect(out).toContain('[TAD - Motion Circle](#/tad/aaaa-1111)');
    expect(out).toContain('tertaut Confluence v4');
    expect(out).toContain('ada usulan AI menunggu review');
    expect(out).not.toContain('Isi TAD:');
  });

  it('includes the body of the draft being discussed', () => {
    const out = renderCockpitContext(state, 'apa objective motion circle?');
    expect(out).toContain('Isi draft yang sedang dibahas: TAD - Motion Circle');
    expect(out).toContain('Isi TAD - Motion Circle');
  });

  it('puts the user message after the snapshot', () => {
    expect(withCockpitContext('halo', '### SNAPSHOT')).toBe('### SNAPSHOT\n\n### PESAN USER:\nhalo');
  });
});

describe('workspace in the snapshot', () => {
  it('states the organisation, codebase folder and AI defaults from the settings', () => {
    const out = renderCockpitContext(
      { now: new Date('2026-10-09T03:00:00Z'), runtime: 'desktop', drafts: [], workspace: { orgName: 'Acme', servicesRoot: '/Users/x/Code/Services', serviceCount: 12, defaultBaseBranch: 'develop', defaultAi: 'claude · sonnet', inferhubModel: 'ag/claude-sonnet' } },
      'halo',
    );
    expect(out).toContain('- Organisasi/tim: Acme');
    expect(out).toContain('- Folder codebase (Services): `/Users/x/Code/Services` · 12 repo');
    expect(out).toContain('- Branch dasar default: develop');
    expect(out).toContain('- Model default InferHub: ag/claude-sonnet');
  });
});
