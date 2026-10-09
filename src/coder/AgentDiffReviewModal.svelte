<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import { toasts } from '../components/toast.svelte';
  import { api } from '../lib/api-base';
  import { coder } from '../lib/coder/client';
  import type { CoderAiReview, CoderReviewVerdict, CoderRun } from '../lib/coder/types';
  import { DEFAULT_AI_SELECTION, type AiSelection } from '../lib/ai/types';
  import type { MrFileChange, ReviewStrictness } from '../lib/gitlab/types';
  import { REVIEW_STRICTNESS_OPTIONS } from '../lib/gitlab/types';
  import { renderPreview } from '../lib/markdown/preview';
  import { checkConformance, detailTaskSpec, parseScopeTasks } from '../lib/tad/task-links';
  import type { Draft } from '../tad/drafts.svelte';
  import {
    buildCoderReviewPrompt,
    extractRecommendations,
    extractReviewVerdict,
  } from '../lib/coder/agent-review';

  const AI_KEY = 'tlc.ai.coderReview';
  const STRICTNESS_KEY = 'tlc.coderReview.strictness';

  function readJson<T>(key: string, fallback: T): T {
    try {
      return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* convenience only */
    }
  }

  let {
    open = $bindable(false),
    run,
    draft,
    onupdate,
    onshowdiff,
    onpush,
    onapplyrevisions,
  }: {
    open: boolean;
    run: CoderRun | null;
    draft: Draft;
    onupdate?: () => void;
    onshowdiff?: (run: CoderRun) => void;
    onpush?: (run: CoderRun) => void;
    onapplyrevisions?: (run: CoderRun, feedback: string) => void;
  } = $props();

  let ai = $state<AiSelection>(readJson(AI_KEY, DEFAULT_AI_SELECTION));
  let strictness = $state<ReviewStrictness>(readJson(STRICTNESS_KEY, 'standard'));
  let customInstruction = $state('');
  let showCustomInput = $state(false);

  let reviewText = $state('');
  let reviewing = $state(false);
  let reviewAbort: AbortController | undefined;
  let diffFiles = $state<MrFileChange[]>([]);
  let loadingDiff = $state(false);

  let showReviseBox = $state(false);
  let reviseFeedback = $state('');
  let submittingRevise = $state(false);

  function updateAi(sel: AiSelection) {
    ai = sel;
    writeJson(AI_KEY, sel);
  }

  function updateStrictness(s: ReviewStrictness) {
    strictness = s;
    writeJson(STRICTNESS_KEY, s);
  }

  const parsedVerdict = $derived<CoderReviewVerdict | undefined>(
    extractReviewVerdict(reviewText)
  );

  const verdict = $derived<CoderReviewVerdict | undefined>(
    parsedVerdict || run?.aiReview?.verdict
  );

  const totalAdditions = $derived(diffFiles.reduce((s, f) => s + (f.additions || 0), 0));
  const totalDeletions = $derived(diffFiles.reduce((s, f) => s + (f.deletions || 0), 0));

  $effect(() => {
    if (open && run) {
      if (run.aiReview?.text) {
        reviewText = run.aiReview.text;
      } else {
        reviewText = '';
      }
      showReviseBox = false;
      reviseFeedback = '';
      void loadDiffFiles(run.id);
    }
  });

  async function loadDiffFiles(runId: string) {
    loadingDiff = true;
    try {
      diffFiles = await coder.diff(runId);
    } catch {
      diffFiles = [];
    } finally {
      loadingDiff = false;
    }
  }

  async function startReview() {
    if (!run || reviewing) return;

    if (diffFiles.length === 0) {
      try {
        await loadDiffFiles(run.id);
      } catch (e) {
        toasts.show('Gagal membaca diff: ' + (e as Error).message, 'err');
        return;
      }
    }

    reviewing = true;
    reviewText = '';
    reviewAbort = new AbortController();

    const task = parseScopeTasks(draft.markdown).find((t) => t.title === run.taskTitle);
    const spec = detailTaskSpec(draft.markdown, run.taskTitle);
    const conformanceChecks =
      task && spec ? checkConformance(spec, task, { projectPath: run.repo, changes: diffFiles }) : [];

    const { prompt, context } = buildCoderReviewPrompt({
      run,
      diffFiles,
      spec,
      conformanceChecks,
      strictness,
      customInstruction: customInstruction.trim() || undefined,
    });

    try {
      const res = await fetch(api('/api/connector/ai/assistant/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1' },
        body: JSON.stringify({ prompt, context, mode: 'code-review', strictness, ai }),
        signal: reviewAbort.signal,
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let failure = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const payload = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : '';
          if (!payload || payload === '[DONE]') continue;
          let data: { kind?: string; text?: string; reply?: string; error?: string };
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          if (data.kind === 'text' && data.text) {
            reviewText += (reviewText ? '\n' : '') + data.text;
          } else if (data.kind === 'done') {
            reviewText = data.reply ?? reviewText;
          } else if (data.kind === 'error') {
            failure = data.error ?? 'AI gagal memberikan review.';
          }
        }
      }

      if (failure) throw new Error(failure);

      // Save review to the run on backend
      const v = extractReviewVerdict(reviewText);
      const savedReview: CoderAiReview = {
        at: new Date().toISOString(),
        verdict: v,
        text: reviewText,
        provider: ai.provider,
        model: ai.model,
        strictness,
        customInstruction: customInstruction.trim() || undefined,
      };

      await coder.saveReview(run.id, savedReview).catch(() => {});
      toasts.show('AI Review selesai.', 'ok');
      onupdate?.();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        reviewText = `⚠️ Review gagal: ${(e as Error).message}`;
        toasts.show((e as Error).message, 'err');
      }
    } finally {
      reviewing = false;
    }
  }

  function stopReview() {
    reviewAbort?.abort();
    reviewing = false;
    toasts.show('Review dihentikan.', 'info');
  }

  function copyReview() {
    if (!reviewText) return;
    void navigator.clipboard.writeText(reviewText);
    toasts.show('Hasil review disalin ke clipboard.', 'ok');
  }

  function handlePrepareRevise() {
    if (!run) return;
    const recs = extractRecommendations(reviewText);
    reviseFeedback = recs
      ? `Tolong perbaiki temuan dari AI Code Review berikut:\n\n${recs}`
      : `Tolong periksa dan perbaiki temuan review pada implementasi task ini.`;
    showReviseBox = true;
  }

  async function handleSendRevise() {
    if (!run || !reviseFeedback.trim()) return;
    submittingRevise = true;
    try {
      await coder.revise(run.id, reviseFeedback.trim());
      toasts.show('Catatan revisi dikirim ke agent.', 'ok');
      open = false;
      onupdate?.();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      submittingRevise = false;
    }
  }

  function handlePassToRunsPanel() {
    if (!run) return;
    const recs = extractRecommendations(reviewText);
    const text = recs
      ? `Tolong perbaiki temuan dari AI Code Review berikut:\n\n${recs}`
      : `Tolong periksa dan perbaiki temuan review pada implementasi task ini.`;
    open = false;
    onapplyrevisions?.(run, text);
  }
</script>

{#if run}
  <Modal
    bind:open
    title="🤖 Review Perubahan Kode AI Agent"
    subtitle="{run.taskTitle} · {run.repo} ({run.branch})"
    width={1120}
    height="90vh"
  >
    <div class="review-modal-body">
      <!-- Toolbar: AI Model Picker & Strictness & Action -->
      <section class="toolbar-box">
        <div class="toolbar-top">
          <div class="toolbar-ai">
            <span class="label-text">Model Reviewer:</span>
            <AiPicker value={ai} onchange={updateAi} disabled={reviewing} />
          </div>

          <div class="toolbar-strictness">
            <span class="label-text">Standar Ketelitian:</span>
            <div class="segmented-control">
              {#each REVIEW_STRICTNESS_OPTIONS as opt (opt.id)}
                <button
                  type="button"
                  class="btn-segment"
                  class:active={strictness === opt.id}
                  disabled={reviewing}
                  onclick={() => updateStrictness(opt.id)}
                  title={opt.instructions}
                >
                  {opt.label}
                </button>
              {/each}
            </div>
          </div>

          <div class="toolbar-actions">
            {#if reviewing}
              <button type="button" class="btn btn-sm btn-danger" onclick={stopReview}>
                <Icon name="x" size={13} /> Berhenti
              </button>
            {:else}
              <button
                type="button"
                class="btn btn-sm btn-primary"
                onclick={startReview}
                disabled={loadingDiff}
              >
                <Icon name="sparkles" size={13} />
                <span>{reviewText ? 'Review Ulang' : 'Mulai Review dengan AI'}</span>
              </button>
            {/if}

            {#if reviewText && !reviewing}
              <button type="button" class="btn btn-sm btn-ghost" onclick={copyReview} title="Salin teks markdown review">
                <Icon name="copy" size={13} /> Salin
              </button>
            {/if}

            <button
              type="button"
              class="btn btn-sm btn-ghost"
              class:btn-active={showCustomInput}
              onclick={() => (showCustomInput = !showCustomInput)}
              title="Instruksi tambahan untuk model AI"
            >
              <Icon name="edit" size={13} /> Catatan Khusus
            </button>
          </div>
        </div>

        {#if showCustomInput}
          <div class="custom-prompt-row">
            <input
              type="text"
              class="input text-sm"
              placeholder="Instruksi khusus tambahan (misal: Periksa otorisasi user, pastikan query tidak N+1, cek edge cases)…"
              bind:value={customInstruction}
              disabled={reviewing}
            />
          </div>
        {/if}

        <div class="meta-strip">
          <span class="meta-chip">
            <strong>{diffFiles.length}</strong> file berubah
            <span class="diff-stat">(+{totalAdditions} / -{totalDeletions})</span>
          </span>
          {#if run.test}
            <span class="meta-chip" class:ok={run.test.exitCode === 0} class:err={run.test.exitCode !== 0}>
              <Icon name={run.test.exitCode === 0 ? 'check' : 'alert'} size={12} />
              Test: {run.test.exitCode === 0 ? 'Lulus (exit 0)' : `Gagal (exit ${run.test.exitCode})`}
            </span>
          {/if}
          {#if run.aiReview?.at}
            <span class="meta-chip muted">
              Terakhir direview: {new Date(run.aiReview.at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
              {#if run.aiReview.provider}· {run.aiReview.provider}{/if}
            </span>
          {/if}
        </div>
      </section>

      <!-- Verdict Banner if verdict detected -->
      {#if verdict}
        <div class="verdict-banner verdict-{verdict.toLowerCase()}">
          <div class="verdict-info">
            <span class="verdict-icon">
              {#if verdict === 'APPROVE'}
                ✅
              {:else if verdict === 'APPROVE_WITH_COMMENTS'}
                ℹ️
              {:else}
                ⚠️
              {/if}
            </span>
            <div>
              <h4 class="verdict-title">
                {#if verdict === 'APPROVE'}
                  VERDICT: APPROVE (Siap Push / Merge)
                {:else if verdict === 'APPROVE_WITH_COMMENTS'}
                  VERDICT: APPROVE WITH COMMENTS (Aman dengan Catatan)
                {:else}
                  VERDICT: REQUEST CHANGES (Perlu Revisi Agent)
                {/if}
              </h4>
              <p class="verdict-desc">
                {#if verdict === 'APPROVE'}
                  Perubahan kode memenuhi spesifikasi TAD, lolos pengujian, dan aman untuk dibuat Merge Request.
                {:else if verdict === 'APPROVE_WITH_COMMENTS'}
                  Perubahan kode secara umum fungsional dan aman, namun terdapat saran perbaikan kecil atau optimasi.
                {:else}
                  Ditemukan bug, potensi error, celah keamanan, atau ketidaksesuaian dengan spesifikasi TAD yang perlu diperbaiki.
                {/if}
              </p>
            </div>
          </div>

          <div class="verdict-actions">
            {#if verdict === 'REQUEST_CHANGES' || verdict === 'APPROVE_WITH_COMMENTS'}
              <button
                type="button"
                class="btn btn-sm btn-warn-action"
                onclick={handlePrepareRevise}
              >
                <Icon name="refresh" size={13} />
                <span>Kirim Revisi ke Agent</span>
              </button>
            {/if}
            {#if (verdict === 'APPROVE' || verdict === 'APPROVE_WITH_COMMENTS') && run.status === 'ready'}
              <button
                type="button"
                class="btn btn-sm btn-primary"
                onclick={() => {
                  open = false;
                  if (run) onpush?.(run);
                }}
              >
                <Icon name="upload" size={13} />
                <span>Push & Buat MR Draft</span>
              </button>
            {/if}
          </div>
        </div>
      {/if}

      <!-- Direct Revise Form if opened -->
      {#if showReviseBox}
        <section class="direct-revise-box">
          <div class="revise-head">
            <h5><Icon name="edit" size={13} /> Kirim Instruksi Revisi ke Coder Agent</h5>
            <button type="button" class="btn btn-ghost btn-xs" onclick={() => (showReviseBox = false)}>
              <Icon name="x" size={12} />
            </button>
          </div>
          <p class="small muted">
            Instruksi berikut diekstrak otomatis dari rekomendasi AI Code Review. Kamu dapat mengeditnya sebelum dikirim ke agent.
          </p>
          <textarea
            class="input input-mono"
            rows="5"
            bind:value={reviseFeedback}
            placeholder="Instruksi revisi untuk agent..."
          ></textarea>
          <div class="revise-foot">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onclick={handlePassToRunsPanel}
              title="Edit lebih lanjut di panel run utama"
            >
              Buka di Panel Agent
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              disabled={submittingRevise || !reviseFeedback.trim()}
              onclick={handleSendRevise}
            >
              <Icon name="sparkles" size={13} />
              <span>{submittingRevise ? 'Mengirim...' : 'Kirim ke Agent Sekarang'}</span>
            </button>
          </div>
        </section>
      {/if}

      <!-- Main Review Content -->
      <div class="review-content-scroll">
        {#if reviewing && !reviewText}
          <div class="loading-state">
            <div class="pulse-spinner"></div>
            <p><strong>AI sedang membaca diff dan memeriksa spesifikasi TAD…</strong></p>
            <p class="muted small">Memeriksa logic correctness, error handling, security, best practices, dan conformance.</p>
          </div>
        {:else if reviewText}
          <article class="markdown-preview">
            {@html renderPreview(reviewText).html}
            {#if reviewing}
              <div class="typing-indicator"><span class="cursor-dot"></span> Sedang menulis review…</div>
            {/if}
          </article>
        {:else}
          <div class="empty-review">
            <div class="empty-icon"><Icon name="bot" size={36} /></div>
            <h3>Review Perubahan Kode AI Agent dengan AI</h3>
            <p>
              Gunakan AI untuk mengaudit seluruh perubahan kode (git diff) yang dikerjakan oleh agent sebelum kamu melakukan push atau membuat Merge Request.
            </p>
            <div class="review-feature-grid">
              <div class="feature-item">
                <Icon name="shield" size={15} />
                <span><strong>Spesifikasi TAD</strong>: Validasi kesesuaian Acceptance Criteria dan flow teknis</span>
              </div>
              <div class="feature-item">
                <Icon name="alert" size={15} />
                <span><strong>Deteksi Bug & Security</strong>: Cek null-pointer, OWASP, validasi input & leak</span>
              </div>
              <div class="feature-item">
                <Icon name="code" size={15} />
                <span><strong>Kualitas & Clean Code</strong>: DRY, SOLID, keterbacaan, dan idiom framework</span>
              </div>
              <div class="feature-item">
                <Icon name="refresh" size={15} />
                <span><strong>1-Click Revisi</strong>: Otomatis kirim catatan review kembali ke coder agent</span>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-primary btn-lg"
              onclick={startReview}
              disabled={loadingDiff}
            >
              <Icon name="sparkles" size={16} />
              <span>Mulai AI Code Review Sekarang</span>
            </button>
          </div>
        {/if}
      </div>
    </div>

    {#snippet footer()}
      <div class="modal-footer-wrap">
        <div class="footer-left">
          {#if run}
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onclick={() => {
                open = false;
                if (run) onshowdiff?.(run);
              }}
              title="Lihat file dan baris per baris git diff"
            >
              <Icon name="eye" size={13} />
              <span>Buka Diff Kode</span>
            </button>
          {/if}
        </div>

        <div class="footer-right">
          {#if reviewText && !showReviseBox}
            <button
              type="button"
              class="btn btn-sm btn-outline"
              onclick={handlePrepareRevise}
              title="Gunakan hasil review ini sebagai feedback instruksi revisi agent"
            >
              <Icon name="edit" size={13} />
              <span>Kirim Catatan Revisi ke Agent</span>
            </button>
          {/if}

          {#if run?.status === 'ready'}
            <button
              type="button"
              class="btn btn-sm btn-primary"
              onclick={() => {
                open = false;
                if (run) onpush?.(run);
              }}
            >
              <Icon name="upload" size={13} />
              <span>Push & Buat MR Draft</span>
            </button>
          {/if}

          <button type="button" class="btn btn-sm btn-ghost" onclick={() => (open = false)}>
            Tutup
          </button>
        </div>
      </div>
    {/snippet}
  </Modal>
{/if}

<style>
  .review-modal-body {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 520px;
    gap: 12px;
  }

  .toolbar-box {
    background: var(--surface-2, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
    border-radius: 8px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .toolbar-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }

  .toolbar-ai,
  .toolbar-strictness {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .label-text {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-muted, #94a3b8);
  }

  .segmented-control {
    display: inline-flex;
    background: var(--surface-1, rgba(0, 0, 0, 0.2));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
  }

  .btn-segment {
    background: transparent;
    border: none;
    font-size: 11px;
    padding: 4px 9px;
    border-radius: 4px;
    color: var(--text-muted, #94a3b8);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-segment:hover:not(:disabled) {
    color: var(--text-color, #e2e8f0);
  }

  .btn-segment.active {
    background: var(--primary, #3b82f6);
    color: #ffffff;
    font-weight: 600;
  }

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }

  .custom-prompt-row {
    animation: fadeIn 0.15s ease;
  }

  .meta-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    flex-wrap: wrap;
    padding-top: 6px;
    border-top: 1px dashed var(--border-color, rgba(255, 255, 255, 0.08));
  }

  .meta-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--surface-3, rgba(255, 255, 255, 0.05));
    color: var(--text-color, #e2e8f0);
  }

  .meta-chip.ok {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
  }

  .meta-chip.err {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
  }

  .diff-stat {
    color: var(--text-muted, #94a3b8);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
  }

  /* Verdict Banner */
  .verdict-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 16px;
    border-radius: 8px;
    border: 1px solid;
    animation: slideDown 0.2s ease;
  }

  .verdict-banner.verdict-approve {
    background: rgba(34, 197, 94, 0.1);
    border-color: rgba(34, 197, 94, 0.3);
  }

  .verdict-banner.verdict-approve_with_comments {
    background: rgba(59, 130, 246, 0.1);
    border-color: rgba(59, 130, 246, 0.3);
  }

  .verdict-banner.verdict-request_changes {
    background: rgba(239, 68, 68, 0.1);
    border-color: rgba(239, 68, 68, 0.3);
  }

  .verdict-info {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .verdict-icon {
    font-size: 20px;
    line-height: 1;
    margin-top: 2px;
  }

  .verdict-title {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .verdict-approve .verdict-title {
    color: #4ade80;
  }

  .verdict-approve_with_comments .verdict-title {
    color: #60a5fa;
  }

  .verdict-request_changes .verdict-title {
    color: #f87171;
  }

  .verdict-desc {
    margin: 3px 0 0;
    font-size: 11px;
    color: var(--text-muted, #94a3b8);
  }

  .verdict-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .btn-warn-action {
    background: rgba(245, 158, 11, 0.2);
    border: 1px solid rgba(245, 158, 11, 0.4);
    color: #fbbf24;
    font-weight: 600;
  }

  .btn-warn-action:hover {
    background: rgba(245, 158, 11, 0.3);
  }

  /* Direct Revise Box */
  .direct-revise-box {
    background: var(--surface-3, rgba(255, 255, 255, 0.06));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
    border-radius: 8px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: fadeIn 0.15s ease;
  }

  .revise-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .revise-head h5 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-color, #e2e8f0);
  }

  .input-mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 1.5;
  }

  .revise-foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  /* Content Scroll Area */
  .review-content-scroll {
    flex: 1;
    overflow-y: auto;
    background: var(--surface-1, #0f172a);
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
    border-radius: 8px;
    padding: 18px 22px;
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 16px;
    gap: 12px;
    text-align: center;
  }

  .pulse-spinner {
    width: 36px;
    height: 36px;
    border: 3px solid rgba(59, 130, 246, 0.2);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .empty-review {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 24px;
    text-align: center;
    max-width: 620px;
    margin: 0 auto;
    gap: 14px;
  }

  .empty-icon {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: rgba(59, 130, 246, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #60a5fa;
  }

  .empty-review h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  .empty-review p {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted, #94a3b8);
    line-height: 1.5;
  }

  .review-feature-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    width: 100%;
    text-align: left;
    margin: 8px 0 12px;
  }

  .feature-item {
    background: var(--surface-2, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
    border-radius: 6px;
    padding: 10px 12px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 11px;
    color: var(--text-muted, #94a3b8);
    line-height: 1.4;
  }

  .feature-item strong {
    color: var(--text-color, #e2e8f0);
  }

  .feature-item :global(svg) {
    color: #3b82f6;
    margin-top: 2px;
    flex-shrink: 0;
  }

  .btn-lg {
    padding: 10px 20px;
    font-size: 13px;
    font-weight: 600;
  }

  /* Markdown output */
  .markdown-preview {
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-color, #e2e8f0);
  }

  .markdown-preview :global(h2) {
    font-size: 15px;
    font-weight: 700;
    margin: 20px 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    color: #93c5fd;
  }

  .markdown-preview :global(h3) {
    font-size: 13.5px;
    font-weight: 600;
    margin: 14px 0 6px;
    color: #e2e8f0;
  }

  .markdown-preview :global(pre) {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 10px 12px;
    overflow-x: auto;
    font-size: 11.5px;
  }

  .markdown-preview :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .markdown-preview :global(ul),
  .markdown-preview :global(ol) {
    padding-left: 20px;
    margin: 8px 0;
  }

  .markdown-preview :global(li) {
    margin-bottom: 4px;
  }

  .typing-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #60a5fa;
    margin-top: 12px;
  }

  .cursor-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #60a5fa;
    animation: blink 0.8s infinite;
  }

  /* Footer */
  .modal-footer-wrap {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
  }

  .footer-left,
  .footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes blink {
    0%, 100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
