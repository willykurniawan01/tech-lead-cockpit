<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { lineDiff, type DiffLine } from '../lib/diff';
  import { drafts, type Draft, type Revision } from './drafts.svelte';

  let {
    draft,
    open = $bindable(false),
  }: {
    draft: Draft;
    open: boolean;
  } = $props();

  let selectedRevId = $state<string>('');

  $effect(() => {
    if (open && draft.revisions.length > 0) {
      if (!selectedRevId || !draft.revisions.some((r) => r.id === selectedRevId)) {
        selectedRevId = draft.revisions[0].id;
      }
    }
  });

  const selectedIndex = $derived(draft.revisions.findIndex((r) => r.id === selectedRevId));
  const selectedRev = $derived<Revision | undefined>(draft.revisions[selectedIndex]);
  // Revisions are newest first, so the predecessor is the next item.
  const previousRev = $derived<Revision | undefined>(draft.revisions[selectedIndex + 1]);
  const diffLines = $derived<DiffLine[]>(
    selectedRev ? lineDiff((previousRev?.markdown ?? '').split('\n'), selectedRev.markdown.split('\n')) : []
  );

  const CONTEXT = 2;
  /** Changed lines plus a little context; long unchanged runs collapse into a gap marker. */
  const visibleLines = $derived.by(() => {
    if (!previousRev) return diffLines;
    const keep = diffLines.map(() => false);
    diffLines.forEach((l, i) => {
      if (l.type === 'same') return;
      for (let j = Math.max(0, i - CONTEXT); j <= Math.min(diffLines.length - 1, i + CONTEXT); j++) keep[j] = true;
    });
    const out: (DiffLine | { type: 'gap'; text: string })[] = [];
    diffLines.forEach((l, i) => {
      if (keep[i]) out.push(l);
      else if (out.at(-1)?.type !== 'gap') out.push({ type: 'gap', text: '' });
    });
    return out;
  });

  const stats = $derived({
    added: diffLines.filter((l) => l.type === 'add').length,
    deleted: diffLines.filter((l) => l.type === 'del').length,
  });

  async function rollback() {
    if (!selectedRev) return;
    const ok = await confirmDialog({
      title: 'Rollback Dokumen',
      message: `Yakin ingin rollback dokumen ke revisi "${selectedRev.summary}"?`,
      confirmText: 'Rollback Dokumen',
      danger: true,
    });
    if (ok) {
      drafts.rollback(draft.id, selectedRev.id);
      toasts.show(`Dokumen berhasil di-rollback ke "${selectedRev.summary}".`, 'ok');
      open = false;
    }
  }
</script>

<Modal bind:open title="Riwayat Revisi & Rollback" subtitle="Setiap perubahan dari Chat AI atau import disimpan sebagai revisi." width={960} height={640}>
  <div class="rev-grid">
    <div class="rev-list">
      <h4>Daftar Revisi ({draft.revisions.length})</h4>
      <div class="items">
        {#each draft.revisions as rev, i (rev.id)}
          <button
            class="rev-item {rev.id === selectedRevId ? 'active' : ''}"
            onclick={() => (selectedRevId = rev.id)}
          >
            <div class="rev-head">
              <span class="rev-idx">#{draft.revisions.length - i}</span>
              <span class="rev-time">{new Date(rev.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
            </div>
            <div class="rev-summary">{rev.summary}</div>
            {#if i === 0}
              <span class="chip chip-ok current-badge">Versi Saat Ini</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>

    <div class="diff-viewer">
      {#if selectedRev}
        <div class="diff-header">
          <div class="diff-info">
            <strong>{selectedRev.summary}</strong>
            <span class="muted small">{new Date(selectedRev.timestamp).toLocaleString()}</span>
          </div>
          <div class="diff-stats">
            {#if previousRev}
              <span class="badge add">+{stats.added}</span>
              <span class="badge del">-{stats.deleted}</span>
            {/if}
            {#if selectedRev.id !== draft.revisions[0]?.id}
              <button class="btn btn-sm btn-warn rollback-btn" onclick={rollback}>
                <Icon name="history" size={13} /> Rollback ke versi ini
              </button>
            {/if}
          </div>
        </div>

        <p class="muted small diff-caption">
          {previousRev ? `Perubahan dibanding revisi #${draft.revisions.length - selectedIndex - 1}` : 'Revisi awal — seluruh isi dokumen.'}
        </p>
        <div class="diff-body mono">
          {#each visibleLines as line, idx (idx)}
            {#if line.type === 'gap'}
              <div class="line gap"><span class="prefix"></span><span class="text">⋯</span></div>
            {:else}
              <div class="line {previousRev ? line.type : 'same'}">
                <span class="prefix">{previousRev && line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
                <span class="text">{line.text || ' '}</span>
              </div>
            {/if}
          {:else}
            <div class="line same"><span class="prefix"></span><span class="text">Tidak ada perubahan isi.</span></div>
          {/each}
        </div>
      {:else}
        <div class="empty-diff">Pilih revisi untuk melihat perbandingan diff.</div>
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <span style="flex:1"></span>
    <button class="btn" onclick={() => (open = false)}>Tutup</button>
  {/snippet}
</Modal>

<style>
  .rev-grid {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 16px;
    height: 520px;
    min-height: 0;
  }
  @media (max-width: 760px) {
    .rev-grid {
      grid-template-columns: 1fr;
      height: auto;
    }
  }
  .rev-list {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    padding-right: 12px;
    min-height: 0;
  }
  h4 {
    margin: 0 0 10px;
    font-size: 13px;
    color: var(--text-2);
  }
  .items {
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rev-item {
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .rev-item:hover {
    border-color: var(--accent);
  }
  .rev-item.active {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .rev-head {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--text-3);
  }
  .rev-idx {
    font-weight: 700;
    color: var(--accent);
  }
  .rev-summary {
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text);
  }
  .current-badge {
    align-self: flex-start;
    font-size: 10px;
    padding: 1px 6px;
  }
  .diff-viewer {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .diff-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
    gap: 12px;
  }
  .diff-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .diff-stats {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .badge {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
  }
  .badge.add {
    background: #dcfff1;
    color: #216e4e;
  }
  .badge.del {
    background: #ffebe6;
    color: #ae2a19;
  }
  .btn-warn {
    background: #e56910;
    color: white;
    border: 0;
  }
  .btn-warn:hover {
    background: #c25400;
  }
  .diff-body {
    flex: 1;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.45;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
  }
  .line {
    display: flex;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .line.add {
    background: #dcfff1;
    color: #164b35;
  }
  .line.del {
    background: #ffebe6;
    color: #7f1d1d;
  }
  .prefix {
    width: 20px;
    user-select: none;
    color: var(--text-3);
    flex-shrink: 0;
  }
  .line.add .prefix {
    color: #216e4e;
    font-weight: bold;
  }
  .line.del .prefix {
    color: #ae2a19;
    font-weight: bold;
  }
  .text {
    flex: 1;
  }
  .line.gap {
    color: var(--text-3);
    padding: 2px 0;
  }
  .diff-caption {
    margin: 0 0 8px;
  }
  .empty-diff {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-3);
  }
</style>
