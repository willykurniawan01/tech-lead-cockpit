<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { applyHunks, buildHunks, lineDiff, type DiffHunk } from '../lib/diff';
  import { trackedHunk } from '../lib/html-diff';
  import { renderPreview } from '../lib/markdown/preview';
  import { loadAiSelection } from '../lib/ai/providers.svelte';
  import { drafts, type Draft } from './drafts.svelte';
  import { startGeneratorJob } from './generator-client';
  import PreviewPane from './PreviewPane.svelte';

  let { draft, open = $bindable(false) }: { draft: Draft; open: boolean } = $props();

  const CONTEXT = 2;
  const COLLAPSE_AT = 60;

  const proposal = $derived(draft.proposal);
  const diff = $derived(proposal ? lineDiff(proposal.base.split('\n'), proposal.proposed.split('\n')) : []);
  const hunks = $derived(buildHunks(diff));

  let accepted = $state<Set<number>>(new Set());
  let expanded = $state<Set<number>>(new Set());
  let tab = $state<'changes' | 'preview'>('changes');

  let refineOpen = $state(false);
  let refinePrompt = $state('');
  let refining = $state(false);

  const refineQuickChips = [
    'Lengkapi Detail Task yang masih TODO',
    'Tambahkan response error 4xx & 5xx',
    'Perjelas skema JSON payload',
    'Sederhanakan rancangan arsitektur',
  ];

  function refineSection(sectionName: string) {
    refineOpen = true;
    refinePrompt = `Perbaiki bagian "${sectionName}": `;
  }

  function handleRefineKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitRefine();
    }
  }

  async function submitRefine() {
    const text = refinePrompt.trim();
    if (!text || !proposal || refining) return;
    refining = true;
    const promptToSend = `Revisi / Refine usulan sebelumnya: ${text}`;
    drafts.addChatMessage(draft.id, {
      sender: 'user',
      text: `[Refine Usulan AI] ${text}`,
    });

    try {
      const currentAi = loadAiSelection('generator');
      const { job, alreadyRunning } = await startGeneratorJob(
        draft,
        promptToSend,
        currentAi,
        'edit',
        proposal.proposed,
      );
      if (alreadyRunning) {
        toasts.show('AI masih mengerjakan instruksi sebelumnya.', 'info');
      } else {
        drafts.update(draft.id, { pendingJobId: job.id });
        drafts.saveNow();
        toasts.show('Instruksi refine dikirim ke AI. Menunggu hasil update…', 'ok');
        refinePrompt = '';
        refineOpen = false;
        open = false;
      }
    } catch (err) {
      drafts.addChatMessage(draft.id, {
        sender: 'assistant',
        text: `Gagal mengirim refine: ${(err as Error).message}`,
        isError: true,
      });
      toasts.show(`Gagal refine: ${(err as Error).message}`, 'err');
    } finally {
      refining = false;
    }
  }

  // Changes are shown as a document with Word-style revision marks by default; Markdown on request.
  const VIEW_KEY = 'tlc.review.view';
  let view = $state<'doc' | 'md'>(readView());

  function readView(): 'doc' | 'md' {
    try {
      return localStorage.getItem(VIEW_KEY) === 'md' ? 'md' : 'doc';
    } catch {
      return 'doc';
    }
  }

  function setView(v: 'doc' | 'md') {
    view = v;
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* only a preference */
    }
  }

  /**
   * A hunk widened to whole Markdown blocks (up to the blank lines around it), so tables and
   * lists render completely, then rendered before/after and compared word by word.
   */
  function trackedHtml(h: DiffHunk): { html: string; formatOnly: boolean } {
    return trackedHunk(diff, h, (md) => renderPreview(md).html);
  }


  const tracked = $derived(view === 'doc' ? new Map(hunks.map((h) => [h.id, trackedHtml(h)])) : new Map<number, { html: string; formatOnly: boolean }>());

  // Everything starts accepted for a new proposal; the reviewer unticks what they don't want.
  $effect(() => {
    void proposal?.id;
    untrack(() => {
      accepted = new Set(hunks.map((h) => h.id));
      expanded = new Set();
      tab = 'changes';
    });
  });

  const merged = $derived(proposal ? applyHunks(diff, hunks, accepted) : '');
  const totals = $derived({
    added: hunks.filter((h) => accepted.has(h.id)).reduce((n, h) => n + h.added, 0),
    removed: hunks.filter((h) => accepted.has(h.id)).reduce((n, h) => n + h.removed, 0),
  });
  // The TAD may have been edited by hand while the AI was working.
  const drifted = $derived(Boolean(proposal && draft.markdown !== proposal.base));

  function toggle(id: number) {
    const next = new Set(accepted);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    accepted = next;
  }

  function setAll(on: boolean) {
    accepted = on ? new Set(hunks.map((h) => h.id)) : new Set();
  }

  function linesOf(h: { start: number; end: number }) {
    const from = Math.max(0, h.start - CONTEXT);
    const to = Math.min(diff.length, h.end + CONTEXT);
    return diff.slice(from, to).map((line, i) => ({ ...line, context: from + i < h.start || from + i >= h.end }));
  }

  function apply() {
    if (!proposal) return;
    if (accepted.size === 0) return reject();
    drafts.acceptProposal(draft.id, merged, accepted.size, hunks.length);
    toasts.show(accepted.size === hunks.length ? 'Usulan AI diterapkan.' : `${accepted.size} dari ${hunks.length} bagian diterapkan.`, 'ok');
    open = false;
  }

  async function reject() {
    if (!proposal) return;
    const ok = await confirmDialog({
      title: 'Tolak Usulan AI',
      message: 'Tolak seluruh usulan AI? TAD tidak akan berubah.',
      confirmText: 'Tolak Usulan',
      danger: true,
    });
    if (!ok) return;
    drafts.rejectProposal(draft.id);
    open = false;
  }
</script>

<Modal bind:open title="Review usulan AI" subtitle="Pilih bagian yang ingin diterapkan ke TAD. Yang tidak dicentang dibuang." width={1100} height={720}>
  {#if proposal}
    <div class="summary">
      <div class="prompt">
        <span class="chip chip-accent">{proposal.provider === 'claude' ? 'Claude CLI' : proposal.provider === 'antigravity' ? 'Antigravity CLI' : proposal.provider === '9router' ? '9Router' : 'InferHub'}</span>
        {#if proposal.prompt.includes('Refine') || proposal.prompt.includes('Revisi')}
          <span class="chip chip-ok"><Icon name="sparkles" size={12} /> Hasil Refine</span>
        {/if}
        <span class="text" title={proposal.prompt}>{proposal.prompt}</span>
      </div>
      {#if proposal.partial}
        <p class="alert"><Icon name="alert" size={14} /> AI berhenti sebelum selesai. Periksa terutama bagian terakhir.</p>
      {/if}
      {#if drifted}
        <p class="alert"><Icon name="alert" size={14} /> TAD diedit manual setelah AI mulai bekerja. Menerapkan usulan akan menggantikan editan itu (editannya tetap tersimpan sebagai revisi "Edit manual").</p>
      {/if}
    </div>

    <div class="refine-bar">
      <div class="refine-lead">
        <button class="btn btn-sm" class:btn-primary={refineOpen} type="button" onclick={() => (refineOpen = !refineOpen)}>
          <Icon name="sparkles" size={13} />
          {refineOpen ? 'Tutup Panel Refine' : 'Refine usulan dengan AI…'}
        </button>
        {#if !refineOpen}
          <span class="muted small refine-desc">Kurang sesuai? Minta AI memperjelas atau merevisi usulan ini sebelum diterapkan.</span>
        {/if}
      </div>
      {#if refineOpen}
        <div class="refine-box">
          <div class="refine-chips">
            {#each refineQuickChips as chip}
              <button class="sug-pill" type="button" onclick={() => (refinePrompt = chip)} disabled={refining}>{chip}</button>
            {/each}
          </div>
          <div class="refine-input-row">
            <textarea
              class="input mono"
              rows={2}
              bind:value={refinePrompt}
              placeholder="Ketik instruksi perbaikan untuk AI (mis. perjelas detail task, tambahkan skema payload)... (Enter untuk kirim)"
              disabled={refining}
              onkeydown={handleRefineKeydown}
            ></textarea>
            <button class="btn btn-primary refine-send-btn" type="button" onclick={submitRefine} disabled={!refinePrompt.trim() || refining}>
              {#if refining}
                <span class="spin"><Icon name="refresh" size={14} /></span> Memproses…
              {:else}
                <Icon name="sparkles" size={14} /> Kirim Refine
              {/if}
            </button>
          </div>
        </div>
      {/if}
    </div>

    <div class="tabs" role="tablist">
      <button role="tab" class:active={tab === 'changes'} aria-selected={tab === 'changes'} onclick={() => (tab = 'changes')}>
        Perubahan ({hunks.length} bagian)
      </button>
      <button role="tab" class:active={tab === 'preview'} aria-selected={tab === 'preview'} onclick={() => (tab = 'preview')}>Pratinjau hasil</button>
      <span class="spacer"></span>
      {#if tab === 'changes'}
        <div class="view-switch" role="group" aria-label="Tampilan perubahan">
          <button class:active={view === 'doc'} aria-pressed={view === 'doc'} onclick={() => setView('doc')}>Dokumen</button>
          <button class:active={view === 'md'} aria-pressed={view === 'md'} onclick={() => setView('md')}>Markdown</button>
        </div>
        <button class="btn btn-ghost btn-sm" onclick={() => setAll(true)}>Centang semua</button>
        <button class="btn btn-ghost btn-sm" onclick={() => setAll(false)}>Kosongkan</button>
      {/if}
    </div>

    {#if tab === 'changes' && view === 'doc'}
      <p class="legend">
        <ins class="tc-add-sample">teks baru</ins> ditambahkan · <del class="tc-del-sample">teks lama</del> dihapus · bagian yang tidak dicentang tidak diterapkan
      </p>
      <div class="hunks doc">
        {#each hunks as h (h.id)}
          {@const t = tracked.get(h.id)}
          <section class="hunk" class:off={!accepted.has(h.id)}>
            <div class="hunk-head">
              <label class="hunk-label">
                <input type="checkbox" checked={accepted.has(h.id)} onchange={() => toggle(h.id)} />
                <span class="section">{h.section}</span>
              </label>
              {#if t?.formatOnly}<span class="fmt">format saja</span>{/if}
              <button class="btn btn-ghost btn-xs refine-hunk-btn" type="button" title="Refine khusus bagian ini" onclick={() => refineSection(h.section)}>
                <Icon name="sparkles" size={11} /> Refine bagian ini
              </button>
              <span class="add">+{h.added}</span>
              <span class="del">−{h.removed}</span>
            </div>
            <div class="doc-body">
              <PreviewPane html={t?.html ?? ''} embedded />
            </div>
          </section>
        {:else}
          <p class="muted">Tidak ada perbedaan dengan TAD saat AI mulai bekerja.</p>
        {/each}
      </div>
    {:else if tab === 'changes'}
      <div class="hunks">
        {#each hunks as h (h.id)}
          {@const lines = linesOf(h)}
          {@const long = lines.length > COLLAPSE_AT && !expanded.has(h.id)}
          <section class="hunk" class:off={!accepted.has(h.id)}>
            <div class="hunk-head">
              <label class="hunk-label">
                <input type="checkbox" checked={accepted.has(h.id)} onchange={() => toggle(h.id)} />
                <span class="section">{h.section}</span>
              </label>
              <button class="btn btn-ghost btn-xs refine-hunk-btn" type="button" title="Refine khusus bagian ini" onclick={() => refineSection(h.section)}>
                <Icon name="sparkles" size={11} /> Refine bagian ini
              </button>
              <span class="add">+{h.added}</span>
              <span class="del">−{h.removed}</span>
            </div>
            <div class="lines mono">
              {#each long ? lines.slice(0, COLLAPSE_AT) : lines as line, i (i)}
                <div class="line {line.context ? 'ctx' : line.type}">
                  <span class="sign">{line.context ? ' ' : line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
                  <span>{line.text || ' '}</span>
                </div>
              {/each}
              {#if long}
                <button class="more" onclick={() => (expanded = new Set([...expanded, h.id]))}>Tampilkan {lines.length - COLLAPSE_AT} baris lagi</button>
              {/if}
            </div>
          </section>
        {:else}
          <p class="muted">Tidak ada perbedaan dengan TAD saat AI mulai bekerja.</p>
        {/each}
      </div>
    {:else}
      <div class="preview">
        <PreviewPane markdown={merged} />
      </div>
    {/if}
  {/if}

  {#snippet footer()}
    <span class="muted small" style="flex:1">
      {accepted.size}/{hunks.length} bagian dipilih · <span class="add">+{totals.added}</span> <span class="del">−{totals.removed}</span> baris
    </span>
    <button class="btn btn-ghost" type="button" onclick={() => (refineOpen = !refineOpen)} title="Minta AI merevisi usulan ini">
      <Icon name="sparkles" size={13} /> Refine AI
    </button>
    <button class="btn btn-danger" onclick={reject}>Tolak semua</button>
    <button class="btn" onclick={() => (open = false)}>Nanti</button>
    <button class="btn btn-primary" onclick={apply} disabled={!proposal || accepted.size === 0}>
      <Icon name="check" />
      {accepted.size === hunks.length ? 'Terima semua' : `Terapkan ${accepted.size} bagian`}
    </button>
  {/snippet}
</Modal>

<style>
  .summary {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 10px;
  }
  .prompt {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .prompt .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
    font-size: 13px;
  }
  .alert {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    margin: 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 12.5px;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 10px;
  }
  .tabs button[role='tab'] {
    padding: 6px 10px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    cursor: pointer;
    font-weight: 500;
    color: var(--text-2);
  }
  .tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .hunks {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 58vh;
    overflow: auto;
  }
  .hunk {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .hunk.off {
    opacity: 0.55;
  }
  .hunks.doc {
    background: var(--surface-2);
    padding: 10px;
    border-radius: 10px;
  }
  .hunks.doc .hunk {
    background: var(--page-bg);
    flex-shrink: 0;
  }
  .doc-body {
    max-height: 70vh;
    overflow: auto;
  }
  .fmt {
    padding: 0 7px;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text-2);
    font-size: 11.5px;
    font-weight: 500;
  }
  .legend {
    margin: 0 0 8px;
    font-size: 12.5px;
    color: var(--text-2);
  }
  .tc-add-sample {
    color: #006644;
    background: #e3fcef;
    text-decoration: underline;
  }
  .tc-del-sample {
    color: #bf2600;
    background: #ffebe6;
  }
  .view-switch {
    display: inline-flex;
    padding: 2px;
    border-radius: 999px;
    background: var(--surface-2);
    margin-right: 6px;
  }
  .view-switch button {
    height: 26px;
    padding: 0 12px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--text-2);
    font-size: 12.5px;
    cursor: pointer;
  }
  .view-switch button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }
  .hunk-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    font-size: 13px;
  }
  .section {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add {
    color: var(--ok);
    font-weight: 600;
  }
  .del {
    color: var(--err);
    font-weight: 600;
  }
  .lines {
    font-size: 12px;
    line-height: 1.5;
  }
  .line {
    display: flex;
    gap: 8px;
    padding: 0 10px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .line .sign {
    width: 10px;
    flex-shrink: 0;
    font-weight: 700;
  }
  .line.ctx {
    color: var(--text-3);
  }
  .line.add {
    background: var(--ok-soft);
  }
  .line.del {
    background: var(--err-soft);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--err) 50%, transparent);
  }
  .more {
    width: 100%;
    padding: 6px;
    border: 0;
    border-top: 1px dashed var(--border);
    background: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
  }
  .preview {
    height: 58vh;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .small {
    font-size: 12.5px;
  }
  .refine-bar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
    margin-bottom: 10px;
  }
  .refine-lead {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .refine-desc {
    font-size: 12px;
  }
  .refine-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 4px;
  }
  .refine-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .sug-pill {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 3px 10px;
    font-size: 11.5px;
    color: var(--text-2);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    transition: all 0.15s ease;
  }
  .sug-pill:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .refine-input-row {
    display: flex;
    gap: 8px;
  }
  .refine-input-row textarea {
    flex: 1;
    resize: none;
    font-size: 12.5px;
  }
  .refine-send-btn {
    align-self: flex-end;
    height: 40px;
    padding: 0 14px;
    white-space: nowrap;
  }
  .hunk-label {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    cursor: pointer;
  }
  .refine-hunk-btn {
    font-size: 11px;
    padding: 2px 6px;
    opacity: 0.8;
  }
  .refine-hunk-btn:hover {
    opacity: 1;
    color: var(--accent);
  }
  .spin {
    display: inline-flex;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
