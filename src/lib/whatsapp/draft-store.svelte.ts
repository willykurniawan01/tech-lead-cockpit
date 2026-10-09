/**
 * Global reactive draft and selected chat store for Cockpit WhatsApp.
 * Preserves in-progress drafts across view changes and allows other modules
 * (e.g. TAD Progress Report) to open a chat and prefill the draft input
 * without immediately sending.
 */

class WaDraftStore {
  selectedJid = $state<string | null>(this.readInitialJid());
  drafts = $state<Record<string, string>>(this.readInitialDrafts());

  private readInitialJid(): string | null {
    try {
      return sessionStorage.getItem('tlc.wa.pendingChat') ?? null;
    } catch {
      return null;
    }
  }

  private readInitialDrafts(): Record<string, string> {
    try {
      const chat = sessionStorage.getItem('tlc.wa.pendingChat');
      const draft = sessionStorage.getItem('tlc.wa.pendingDraft');
      if (chat && draft) {
        return { [chat]: draft };
      }
    } catch {}
    return {};
  }

  select(jid: string | null) {
    this.selectedJid = jid;
  }

  setDraft(jid: string, text: string, select = true) {
    this.drafts = { ...this.drafts, [jid]: text };
    if (select) {
      this.selectedJid = jid;
      try {
        sessionStorage.setItem('tlc.wa.pendingChat', jid);
        sessionStorage.setItem('tlc.wa.pendingDraft', text);
      } catch {}
    }
  }

  getDraft(jid: string): string {
    return this.drafts[jid] ?? '';
  }

  clearDraft(jid: string) {
    const next = { ...this.drafts };
    delete next[jid];
    this.drafts = next;
  }

  consumePending(): { jid: string; draft: string } | null {
    try {
      const jid = sessionStorage.getItem('tlc.wa.pendingChat');
      const draft = sessionStorage.getItem('tlc.wa.pendingDraft');
      if (jid) {
        this.selectedJid = jid;
        if (draft) {
          this.drafts = { ...this.drafts, [jid]: draft };
        }
        sessionStorage.removeItem('tlc.wa.pendingChat');
        sessionStorage.removeItem('tlc.wa.pendingDraft');
        return { jid, draft: draft ?? '' };
      }
    } catch {}
    return null;
  }
}

export const waDraftStore = new WaDraftStore();
