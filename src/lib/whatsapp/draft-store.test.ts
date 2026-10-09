import { beforeEach, describe, expect, it } from 'vitest';
import { waDraftStore } from './draft-store.svelte';

describe('waDraftStore', () => {
  beforeEach(() => {
    sessionStorage.clear();
    waDraftStore.selectedJid = null;
    waDraftStore.drafts = {};
  });

  it('sets and retrieves drafts per JID', () => {
    waDraftStore.setDraft('6281234@s.whatsapp.net', 'Halo Mas Budi', false);
    expect(waDraftStore.getDraft('6281234@s.whatsapp.net')).toBe('Halo Mas Budi');
    expect(waDraftStore.selectedJid).toBeNull();
  });

  it('selects chat when requested and writes to sessionStorage', () => {
    const jid = '6289999@s.whatsapp.net';
    waDraftStore.setDraft(jid, 'Laporan Progress TAD', true);
    expect(waDraftStore.selectedJid).toBe(jid);
    expect(waDraftStore.getDraft(jid)).toBe('Laporan Progress TAD');
    expect(sessionStorage.getItem('tlc.wa.pendingChat')).toBe(jid);
    expect(sessionStorage.getItem('tlc.wa.pendingDraft')).toBe('Laporan Progress TAD');
  });

  it('consumes pending drafts from sessionStorage', () => {
    const jid = '120363@g.us';
    sessionStorage.setItem('tlc.wa.pendingChat', jid);
    sessionStorage.setItem('tlc.wa.pendingDraft', 'Progress sprint 85%');

    const pending = waDraftStore.consumePending();
    expect(pending).toEqual({ jid, draft: 'Progress sprint 85%' });
    expect(waDraftStore.selectedJid).toBe(jid);
    expect(waDraftStore.getDraft(jid)).toBe('Progress sprint 85%');
    expect(sessionStorage.getItem('tlc.wa.pendingChat')).toBeNull();
  });

  it('clears draft when requested', () => {
    const jid = '628111@s.whatsapp.net';
    waDraftStore.setDraft(jid, 'Pesan sementara');
    expect(waDraftStore.getDraft(jid)).toBe('Pesan sementara');
    waDraftStore.clearDraft(jid);
    expect(waDraftStore.getDraft(jid)).toBe('');
  });
});
