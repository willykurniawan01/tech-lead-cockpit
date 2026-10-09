<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import type { ProjectProgress } from '../lib/projects/project-progress';
  import { boardFilter, NO_TICKET } from '../lib/projects/board-filter.svelte';

  let { progress, loading = false, onrefresh, onopen, onstatus }: { progress: ProjectProgress | null; loading?: boolean; onrefresh?: () => void; onopen?: (id: string) => void; onstatus?: (value: string) => void } = $props();

  /** Filters the open board to this status (click again to clear). */
  function pick(value: string) {
    boardFilter.jiraStatus = boardFilter.jiraStatus === value ? '' : value;
    onstatus?.(boardFilter.jiraStatus);
  }
  const valueOf = (s: { status: string; category: string }) => (s.category === 'none' ? NO_TICKET : s.status.toUpperCase());

  const STAGES = [
    { key: 'merged', label: 'Dev selesai', cls: 'ok' },
    { key: 'review', label: 'Review', cls: 'info' },
    { key: 'inProgress', label: 'Sedang coding', cls: 'warn' },
    { key: 'todo', label: 'To Do', cls: 'idle' },
  ] as const;

  const time = (iso: string) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const pct = (n: number, total: number) => (total ? (n / total) * 100 : 0);
</script>

<section class="pp" aria-label="Progres proyek">
  {#if !progress}
    <div class="pp-loading muted small">{loading ? 'Menghitung progres proyek…' : 'Progres proyek belum dimuat.'}</div>
  {:else}
    <div class="pp-main">
      <div class="pp-total">
        <span class="label">Progres proyek</span>
        <strong>{progress.percent}%</strong>
        <span class="muted small">{progress.stages.total} task</span>
      </div>
      <div class="pp-stages">
        <div class="stack" role="img" aria-label="Sebaran tahap task">
          {#each STAGES as s (s.key)}
            {#if progress.stages[s.key]}<span class="seg {s.cls}" style="width: {pct(progress.stages[s.key], progress.stages.total)}%" title="{s.label}: {progress.stages[s.key]}"></span>{/if}
          {/each}
        </div>
        <div class="legend">
          {#each STAGES as s (s.key)}
            <span class="leg"><span class="dot {s.cls}"></span>{s.label} <strong>{progress.stages[s.key]}</strong></span>
          {/each}
        </div>
      </div>
      <div class="pp-actions">
        <span class="muted small" title="Dihitung dari Jira dan GitLab">{loading ? 'Memuat…' : `Diperbarui ${time(progress.at)}`}</span>
        <button class="icon-btn" onclick={onrefresh} disabled={loading} title="Hitung ulang progres proyek" aria-label="Hitung ulang progres proyek"><Icon name="refresh" size={13} /></button>
      </div>
    </div>

    <div class="pp-rows">
      {#if progress.parts.length > 1}
        <div class="row">
          <span class="row-label">Per sumber</span>
          <div class="chips">
            {#each progress.parts as p (p.id)}
              <button class="part" onclick={() => onopen?.(p.id)} title="Buka di Task Board">
                <Icon name={p.kind === 'ops' ? 'bug' : 'doc'} size={11} />
                <span class="part-title">{p.title}</span>
                <span class="mini"><span style="width: {p.percent}%"></span></span>
                <strong>{p.percent}%</strong>
              </button>
            {/each}
          </div>
        </div>
      {/if}
      {#if progress.statuses.length}
        <div class="row">
          <span class="row-label">Status Jira</span>
          <div class="chips">
            {#each progress.statuses as s (s.status)}
              <button class="status cat-{s.category}" class:picked={boardFilter.jiraStatus === valueOf(s)} aria-pressed={boardFilter.jiraStatus === valueOf(s)} onclick={() => pick(valueOf(s))} title="Tampilkan task berstatus ini di board">{s.status} <strong>{s.count}</strong></button>
            {/each}
          </div>
        </div>
      {/if}
      {#if progress.errors.length}
        <p class="err small"><Icon name="alert" size={12} /> {progress.errors.join(' · ')}</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .pp {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .pp-loading {
    padding: 4px 0;
  }
  .small {
    font-size: 12px;
  }
  .pp-main {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
  }
  .pp-total {
    display: flex;
    flex-direction: column;
    min-width: 110px;
  }
  .pp-total .label {
    font-size: 11.5px;
    color: var(--text-3);
  }
  .pp-total strong {
    font-size: 26px;
    font-weight: 700;
    line-height: 1.1;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .pp-stages {
    flex: 1;
    min-width: 280px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .stack {
    display: flex;
    height: 10px;
    border-radius: 999px;
    overflow: hidden;
    background: var(--surface-hover);
  }
  .seg {
    height: 100%;
  }
  .ok {
    background: var(--ok);
  }
  .info {
    background: var(--accent);
  }
  .warn {
    background: var(--warn);
  }
  .idle {
    background: var(--border-strong);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 12px;
    color: var(--text-2);
  }
  .leg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .leg strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .pp-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }
  .icon-btn {
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text-2);
    cursor: pointer;
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--text);
  }
  .pp-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .row-label {
    flex-shrink: 0;
    width: 76px;
    padding-top: 4px;
    font-size: 11.5px;
    color: var(--text-3);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .part {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .part:hover {
    border-color: var(--accent);
  }
  .part-title {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .part strong {
    font-variant-numeric: tabular-nums;
  }
  .mini {
    width: 44px;
    height: 5px;
    border-radius: 999px;
    background: var(--surface-hover);
    overflow: hidden;
  }
  .mini span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px;
    border-radius: 6px;
    font-size: 11.5px;
    font-weight: 500;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-2);
  }
  .status {
    font-family: inherit;
    cursor: pointer;
  }
  .status:hover {
    filter: brightness(0.97);
  }
  .status.picked {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .status strong {
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .status.cat-indeterminate {
    background: var(--accent-soft);
    border-color: transparent;
    color: var(--accent);
  }
  .status.cat-done {
    background: var(--ok-soft);
    border-color: transparent;
    color: var(--ok);
  }
  .status.cat-none {
    background: var(--warn-soft);
    border-color: transparent;
    color: var(--warn);
  }
  .err {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 0;
    color: var(--err);
  }
</style>
