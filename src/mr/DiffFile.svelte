<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import type { MrFileChange } from '../lib/gitlab/types';

  let {
    file,
    open = $bindable(true),
    wrap = false,
  }: {
    file: MrFileChange;
    open?: boolean;
    wrap?: boolean;
  } = $props();

  let localWrap = $state<boolean | null>(null);
  const isWrapped = $derived(localWrap ?? wrap);

  type Row =
    | { kind: 'hunk'; text: string }
    | { kind: 'add' | 'del' | 'ctx'; oldNo?: number; newNo?: number; text: string };

  /** Unified diff → rows with old/new line numbers. */
  const rows = $derived.by(() => {
    const out: Row[] = [];
    let oldNo = 0;
    let newNo = 0;
    for (const line of file.diff.split('\n')) {
      if (line.startsWith('@@')) {
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
        if (m) {
          oldNo = Number(m[1]);
          newNo = Number(m[2]);
        }
        out.push({ kind: 'hunk', text: line });
      } else if (line.startsWith('+')) {
        out.push({ kind: 'add', newNo: newNo++, text: line.slice(1) });
      } else if (line.startsWith('-')) {
        out.push({ kind: 'del', oldNo: oldNo++, text: line.slice(1) });
      } else if (line.startsWith('\\')) {
        continue; // "\ No newline at end of file"
      } else if (out.length) {
        out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
      }
    }
    // A diff ends with "\n": drop the empty context row it produces.
    const last = out.at(-1);
    if (last && last.kind === 'ctx' && !last.text) out.pop();
    return out;
  });

  const label = $derived(
    file.renamedFile ? `${file.oldPath} → ${file.newPath}` : file.newPath,
  );
</script>

<section class="file" id="file-{file.newPath}">
  <div class="file-head">
    <button class="file-head-btn" onclick={() => (open = !open)} aria-expanded={open}>
      <span class="chev" class:closed={!open}><Icon name="chevron" size={14} /></span>
      <span class="path mono" title={label}>{label}</span>
      {#if file.newFile}<span class="tag tag-new">baru</span>{/if}
      {#if file.deletedFile}<span class="tag tag-del">dihapus</span>{/if}
      {#if file.renamedFile}<span class="tag">rename</span>{/if}
    </button>
    <div class="file-head-actions">
      <span class="stats">
        <span class="add">+{file.additions}</span>
        <span class="del">−{file.deletions}</span>
      </span>
      <button
        type="button"
        class="head-tool-btn"
        class:active={isWrapped}
        onclick={() => (localWrap = !isWrapped)}
        title={isWrapped ? 'Nonaktifkan wrap (mode scroll horizontal)' : 'Bungkus baris panjang (word wrap)'}
        aria-label="Toggle word wrap"
      >
        <Icon name="split" size={12} />
        <span class="tool-label">{isWrapped ? 'Unwrap' : 'Wrap'}</span>
      </button>
      <button
        type="button"
        class="head-tool-btn"
        onclick={() => {
          navigator.clipboard.writeText(file.newPath);
        }}
        title="Salin path file"
        aria-label="Salin path"
      >
        <Icon name="copy" size={12} />
      </button>
    </div>
  </div>
  {#if open}
    {#if file.truncated}
      <p class="note muted">Diff tidak ditampilkan (file besar/biner atau melebihi batas). Buka di GitLab untuk melihatnya.</p>
    {:else if !rows.length}
      <p class="note muted">Tidak ada perubahan isi (hanya rename/mode).</p>
    {:else}
      <div class="table-wrap">
        <table class="mono" class:is-wrapped={isWrapped}>
          <tbody>
            {#each rows as r, i (i)}
              {#if r.kind === 'hunk'}
                <tr class="hunk"><td class="hunk-cell" colspan="3">{r.text}</td></tr>
              {:else}
                <tr class={r.kind}>
                  <td class="ln ln-old">{r.oldNo ?? ''}</td>
                  <td class="ln ln-new">{r.newNo ?? ''}</td>
                  <td class="code" class:wrap={isWrapped}><span class="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>{r.text}</td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</section>

<style>
  .file {
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--surface);
    min-width: 0;
    max-width: 100%;
    width: 100%;
    box-sizing: border-box;
  }
  .file-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    background: var(--surface-2);
    position: sticky;
    top: 0;
    z-index: 3;
    border-bottom: 1px solid var(--border);
    box-sizing: border-box;
  }
  .file-head-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 8px 12px;
    background: transparent;
    border: 0;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .chev {
    display: inline-flex;
    color: var(--text-3);
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .chev.closed {
    transform: rotate(-90deg);
  }
  .path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 500;
  }
  .file-head-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-right: 10px;
    flex-shrink: 0;
  }
  .stats {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-right: 4px;
    font-size: 12px;
    font-weight: 500;
  }
  .head-tool-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 7px;
    font-size: 11px;
    color: var(--text-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .head-tool-btn:hover {
    color: var(--text);
    border-color: var(--border-hover, var(--text-3));
  }
  .head-tool-btn.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .tool-label {
    font-size: 10.5px;
    font-weight: 500;
  }
  .tag {
    flex-shrink: 0;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text-2);
    font-size: 11px;
  }
  .tag-new {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .tag-del {
    background: var(--err-soft);
    color: var(--err);
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--err);
  }
  .note {
    margin: 0;
    padding: 12px;
    font-size: 13px;
  }
  .table-wrap {
    overflow-x: auto;
    overflow-y: hidden;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .table-wrap::-webkit-scrollbar {
    height: 7px;
  }
  .table-wrap::-webkit-scrollbar-track {
    background: var(--surface-2);
  }
  .table-wrap::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 4px;
  }
  .table-wrap::-webkit-scrollbar-thumb:hover {
    background: var(--text-3);
  }
  table {
    width: 100%;
    min-width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 12px;
    line-height: 1.5;
  }
  td {
    padding: 0 8px;
    vertical-align: top;
  }
  .ln {
    width: 1%;
    min-width: 44px;
    color: var(--text-3);
    text-align: right;
    user-select: none;
    white-space: nowrap;
    position: sticky;
    z-index: 1;
    background: var(--surface);
    font-size: 11px;
    padding: 0 8px;
  }
  .ln-old {
    left: 0;
  }
  .ln-new {
    left: 44px;
    border-right: 1px solid var(--border);
  }
  tr.add .ln {
    background: var(--ok-soft);
  }
  tr.del .ln {
    background: var(--err-soft);
  }
  tr.hunk .hunk-cell {
    padding: 4px 10px;
    background: var(--accent-soft);
    color: var(--accent);
    position: sticky;
    left: 0;
    z-index: 1;
    font-size: 11.5px;
    font-weight: 500;
  }
  .code {
    white-space: pre;
    tab-size: 4;
    padding: 0 10px;
  }
  .code.wrap {
    white-space: pre-wrap;
    word-break: break-all;
    overflow-wrap: anywhere;
  }
  .sign {
    display: inline-block;
    width: 14px;
    color: var(--text-3);
    user-select: none;
  }
  tr.add {
    background: var(--ok-soft);
  }
  tr.del {
    background: var(--err-soft);
  }
</style>
