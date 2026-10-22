import { toasts } from '../components/toast.svelte';
import { aiUsage } from '../lib/ai/usage.svelte';
import type { GeneratorJob } from '../lib/generator/types';
import { drafts } from './drafts.svelte';

/**
 * Hands a finished TAD generator job to its draft: a proposal to review, a revision (with rollback),
 * a scope update, or a chat message. Used by the TAD chat pane and by pages that start a job in the
 * background (the E2E tab's "Update TAD dari temuan"); whichever sees the job finish first delivers
 * it, once. A draft with `pendingReview` always gets a proposal, whatever the chat's review switch.
 */

const delivered = new Set<string>();

export interface DeliveryOptions {
  /** The chat's "review dulu" switch. */
  reviewMode: boolean;
  onreview?: () => void;
  onscope?: () => void;
}

const providerName = (p: string) => (p === 'claude' ? 'Claude CLI' : p === 'antigravity' ? 'Antigravity CLI' : p === '9router' ? '9Router' : 'InferHub');

export function finishGeneratorJob(draftId: string, finished: GeneratorJob, opts: DeliveryOptions): void {
  if (delivered.has(finished.id)) return;
  const current = drafts.drafts.find((d) => d.id === draftId);
  // Another page already handed this job over (its id is no longer pending on the draft).
  if (current && current.pendingJobId && current.pendingJobId !== finished.id) return;
  delivered.add(finished.id);
  const review = opts.reviewMode || Boolean(current?.pendingReview);
  const r = finished.result;
  void aiUsage.load(true);
  const sessions = { ...(current?.aiSessions ?? {}) };
  if (finished.status === 'error' || r?.error) {
    delete sessions[finished.ai.provider];
  } else if (r?.sessionId) {
    sessions[finished.ai.provider] = r.sessionId;
  }
  drafts.update(draftId, {
    pendingJobId: undefined,
    pendingReview: undefined,
    aiSessions: sessions,
  });
  const who = providerName(finished.ai.provider);
  if (finished.status === 'cancelled') {
    drafts.addChatMessage(draftId, { sender: 'system', text: 'Proses AI dibatalkan. TAD tidak diubah.' });
    return;
  }
  if (finished.kind === 'brainstorm' && r?.scopeChanged && r.updatedScopeMarkdown) {
    // The scope plan is a discussion document: updates land directly, the TAD stays untouched.
    drafts.update(draftId, { scopePlan: r.updatedScopeMarkdown, scopeStatus: 'draft' });
    drafts.addChatMessage(draftId, {
      sender: 'assistant',
      text: `${r.partial ? `${who} berhenti sebelum selesai: ${r.error}\n\n` : ''}${r.reply || 'Rencana scope diperbarui.'}`,
      isError: r.partial,
    });
    toasts.show('Rencana scope diperbarui.', 'ok', 3000);
    opts.onscope?.();
    return;
  }
  if (finished.status === 'error' && r?.partial && r.updatedTadMarkdown) {
    deliver(draftId, finished, r.updatedTadMarkdown, r.baseTadMarkdown, `${who} berhenti sebelum selesai: ${r.error}\n\nPerubahan yang sudah dibuat tetap disimpan. Periksa bagian akhir TAD, lalu minta AI melanjutkan bila perlu.`, true, review, opts);
    return;
  }
  if (finished.status === 'error' || !r) {
    drafts.addChatMessage(draftId, { sender: 'assistant', text: `${who}: ${r?.error ?? 'gagal tanpa keterangan.'}`, isError: true });
    toasts.show('Generator gagal. Lihat pesan di panel chat.', 'err');
    return;
  }
  if (r.changed && r.updatedTadMarkdown) {
    deliver(draftId, finished, r.updatedTadMarkdown, r.baseTadMarkdown, r.reply || 'TAD.md diperbarui.', false, review, opts);
    return;
  }
  drafts.addChatMessage(draftId, { sender: 'assistant', text: r.reply || '(AI tidak memberi balasan teks.)' });
}

/** In review mode the edit becomes a proposal; otherwise it is applied right away as a revision. */
function deliver(draftId: string, finished: GeneratorJob, proposed: string, base: string | undefined, text: string, partial: boolean, review: boolean, opts: DeliveryOptions) {
  const d = drafts.drafts.find((x) => x.id === draftId);
  if (!d) return;
  if (review) {
    const existingProposal = d.proposal;
    const proposal = drafts.setProposal(draftId, {
      provider: finished.ai.provider,
      prompt: finished.prompt,
      reply: text,
      base: existingProposal?.base ?? base ?? d.markdown,
      proposed,
      partial,
    });
    drafts.addChatMessage(draftId, { sender: 'assistant', text: `${text}\n\nUsulan perubahan menunggu review sebelum masuk ke TAD.`, isError: partial, proposalId: proposal?.id });
    toasts.show('Usulan AI siap direview.', 'info', 4000);
    opts.onreview?.();
    return;
  }
  const who = finished.ai.provider === 'claude' ? 'Claude' : finished.ai.provider === 'antigravity' ? 'Antigravity' : finished.ai.provider === '9router' ? '9Router' : 'InferHub';
  const revisionId = drafts.applyRevision(draftId, proposed, `AI (${who}${partial ? ', sebagian' : ''}): ${finished.prompt.slice(0, 40)}`)?.id;
  drafts.addChatMessage(draftId, { sender: 'assistant', text, isError: partial, revisionId });
  toasts.show(partial ? 'AI berhenti sebelum selesai; hasil sebagian diterapkan.' : 'TAD diperbarui oleh AI.', partial ? 'info' : 'ok', 4000);
}
