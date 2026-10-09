<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import type { SectionStatus } from '../lib/tad/validator';
  import type { TadHeading } from '../lib/tad/headings';
  import { draftTitle, drafts } from './drafts.svelte';

  let {
    sections,
    headings = [],
    onnew,
    onimport,
    onjump,
    onjumpheading,
    oncollapse,
  }: {
    sections: SectionStatus[];
    headings?: TadHeading[];
    onnew: () => void;
    onimport?: () => void;
    onjump: (s: SectionStatus) => void;
    onjumpheading?: (h: TadHeading) => void;
    oncollapse?: () => void;
  } = $props();

  let searchQuery = $state('');
  let filterTab = $state<'all' | 'confluence' | 'local'>('all');
  let outlineOpen = $state(true);
  let outlineTab = $state<'headings' | 'sections'>('headings');
  let outlineHeadingQuery = $state('');

  // Inline rename state
  let editingId = $state<string | null>(null);
  let editingValue = $state('');
  let renameInput = $state<HTMLInputElement | null>(null);

  const filteredOutlineHeadings = $derived.by(() => {
    const q = outlineHeadingQuery.trim().toLowerCase();
    if (!q) return headings;
    return headings.filter(
      (h) => h.text.toLowerCase().includes(q) || (h.taskType && h.taskType.toLowerCase().includes(q))
    );
  });

  const rel = new Intl.RelativeTimeFormat('id', { numeric: 'auto' });
  function ago(iso: string): string {
    const mins = Math.round((Date.parse(iso) - Date.now()) / 60000);
    if (Math.abs(mins) < 60) return rel.format(mins, 'minute');
    const hours = Math.round(mins / 60);
    if (Math.abs(hours) < 24) return rel.format(hours, 'hour');
    return rel.format(Math.round(hours / 24), 'day');
  }

  async function remove(id: string, title: string, event: MouseEvent) {
    event.stopPropagation();
    const ok = await confirmDialog({
      title: 'Hapus Draft TAD',
      message: `Hapus draft "${title}"? Draft lokal ini tidak bisa dikembalikan (halaman Confluence tidak ikut terhapus).`,
      confirmText: 'Hapus Draft',
      danger: true,
    });
    if (ok) {
      drafts.remove(id);
    }
  }

  function startRename(id: string, currentTitle: string, event: MouseEvent) {
    event.stopPropagation();
    editingId = id;
    // Strip "TAD — " or "TAD - " prefix for display in input
    editingValue = currentTitle.replace(/^TAD\s+[—-]\s+/, '');
    // Focus input after Svelte renders it
    setTimeout(() => renameInput?.select(), 0);
  }

  function commitRename() {
    if (!editingId) return;
    const newName = editingValue.trim();
    if (!newName) {
      editingId = null;
      return;
    }
    const d = drafts.drafts.find((x) => x.id === editingId);
    if (d) {
      // Replace the H1 line in the markdown (keep "TAD — " prefix convention)
      const fullTitle = newName.startsWith('TAD') ? newName : `TAD — ${newName}`;
      const updated = d.markdown.replace(/^#\s+.+$/m, `# ${fullTitle}`);
      drafts.update(editingId, { markdown: updated });
    }
    editingId = null;
  }

  function cancelRename() {
    editingId = null;
  }

  const confluenceCount = $derived(drafts.drafts.filter((d) => Boolean(d.confluence.pageId)).length);
  const localCount = $derived(drafts.drafts.filter((d) => !d.confluence.pageId).length);

  const filteredDrafts = $derived.by(() => {
    let list = drafts.sorted;

    if (filterTab === 'confluence') {
      list = list.filter((d) => Boolean(d.confluence.pageId));
    } else if (filterTab === 'local') {
      list = list.filter((d) => !d.confluence.pageId);
    }

    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;

    return list.filter((d) => {
      const title = draftTitle(d).toLowerCase();
      const cleanTitle = title.replace(/^tad\s+[—-]\s+/, '');
      const spaceKey = (d.confluence.spaceKey ?? '').toLowerCase();
      const pageId = (d.confluence.pageId ?? '').toLowerCase();
      const jiraKeys = (d.source.jiraKeys ?? []).join(' ').toLowerCase();
      const prdTitle = (d.source.prdTitle ?? '').toLowerCase();
      return (
        title.includes(q) ||
        cleanTitle.includes(q) ||
        spaceKey.includes(q) ||
        pageId.includes(q) ||
        jiraKeys.includes(q) ||
        prdTitle.includes(q)
      );
    });
  });

  const okSectionsCount = $derived(sections.filter((s) => s.status === 'ok').length);

  const STATUS_LABEL: Record<SectionStatus['status'], string> = {
    ok: 'Lengkap',
    warning: 'Ada placeholder/peringatan',
    error: 'Ada error',
    missing: 'Section tidak ada',
  };
</script>


<aside class="sidebar">
  <!-- Sidebar Header -->
  <div class="sidebar-header">
    <div class="header-top">
      <div class="title-row">
        <h3>Daftar TAD</h3>
        <span class="count-badge" title="Total draft">{drafts.drafts.length}</span>
      </div>
      <div class="head-actions">
        {#if onimport}
          <button class="btn btn-sm btn-ghost action-btn" onclick={onimport} title="Import dokumen TAD dari Confluence">
            <Icon name="confluence" size={13} />
            <span>Import</span>
          </button>
        {/if}
        <button class="btn btn-sm btn-primary action-btn" onclick={onnew} title="Buat draft TAD baru dari PRD">
          <Icon name="plus" size={13} />
          <span>Baru</span>
        </button>
        {#if oncollapse}
          <button class="btn btn-sm btn-ghost collapse-btn" onclick={oncollapse} title="Sembunyikan sidebar" aria-label="Sembunyikan sidebar">
            <Icon name="sidebar" size={14} />
          </button>
        {/if}
      </div>
    </div>

    <!-- Search Input -->
    <div class="search-box">
      <span class="search-icon"><Icon name="search" size={13} /></span>
      <input
        type="text"
        placeholder="Cari judul, Jira, space..."
        bind:value={searchQuery}
        aria-label="Cari dokumen TAD"
      />
      {#if searchQuery}
        <button class="clear-btn" onclick={() => (searchQuery = '')} title="Hapus pencarian" aria-label="Hapus pencarian">
          <Icon name="x" size={12} />
        </button>
      {/if}
    </div>

    <!-- Filter Tabs -->
    <div class="filter-tabs" role="tablist" aria-label="Filter jenis dokumen">
      <button
        role="tab"
        class="tab-btn"
        class:active={filterTab === 'all'}
        aria-selected={filterTab === 'all'}
        onclick={() => (filterTab = 'all')}
      >
        <span>Semua</span>
        <span class="tab-count">{drafts.drafts.length}</span>
      </button>
      <button
        role="tab"
        class="tab-btn"
        class:active={filterTab === 'confluence'}
        aria-selected={filterTab === 'confluence'}
        onclick={() => (filterTab = 'confluence')}
      >
        <span>Confluence</span>
        <span class="tab-count">{confluenceCount}</span>
      </button>
      <button
        role="tab"
        class="tab-btn"
        class:active={filterTab === 'local'}
        aria-selected={filterTab === 'local'}
        onclick={() => (filterTab = 'local')}
      >
        <span>Draft</span>
        <span class="tab-count">{localCount}</span>
      </button>
    </div>
  </div>

  <!-- Document List Container -->
  <div class="list-container">
    {#if filteredDrafts.length > 0}
      <ul class="drafts-list" role="list">
        {#each filteredDrafts as d (d.id)}
          {@const title = draftTitle(d).replace(/^TAD\s+[—-]\s+/, '')}
          {@const isConfluence = Boolean(d.confluence.pageId)}
          <li class="draft-item" class:active={d.id === drafts.selectedId}>
            <button class="draft-card" onclick={() => drafts.select(d.id)} title={draftTitle(d)}>
              <div class="card-main">
                <div class="card-icon" class:is-confluence={isConfluence}>
                  <Icon name={isConfluence ? 'confluence' : 'doc'} size={14} />
                </div>
                <div class="card-info">
                  {#if editingId === d.id}
                    <input
                      bind:this={renameInput}
                      class="rename-input"
                      type="text"
                      bind:value={editingValue}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                        if (e.key === 'Escape') cancelRename();
                      }}
                      onblur={commitRename}
                      onclick={(e) => e.stopPropagation()}
                      placeholder="Nama TAD..."
                      aria-label="Edit judul TAD"
                    />
                  {:else}
                    <div class="draft-title" title={draftTitle(d)}>{title}</div>
                  {/if}
                  <div class="draft-meta-row">
                    {#if isConfluence}
                      <span class="meta-chip chip-sync" title="Confluence v{d.confluence.version} {d.confluence.spaceKey ? ` (${d.confluence.spaceKey})` : ''}">
                        v{d.confluence.version}{d.confluence.spaceKey ? ` · ${d.confluence.spaceKey}` : ''}
                      </span>
                    {:else}
                      <span class="meta-chip chip-local" title="Draft lokal (belum di-publish)">
                        Draft
                      </span>
                    {/if}
                    {#if d.source?.jiraKeys?.length}
                      <span class="meta-chip chip-jira" title="Jira keys: {d.source.jiraKeys.join(', ')}">
                        {d.source.jiraKeys[0]}
                      </span>
                    {/if}
                    <span class="meta-time" title={new Date(d.updatedAt).toLocaleString('id')}>
                      {ago(d.updatedAt)}
                    </span>
                  </div>
                </div>
              </div>
            </button>
            <div class="item-actions">
              <button
                class="action-icon-btn edit-btn"
                onclick={(e) => startRename(d.id, draftTitle(d), e)}
                title="Edit judul TAD"
                aria-label="Edit judul {title}"
              >
                <Icon name="edit" size={12} />
              </button>
              <button
                class="action-icon-btn del-btn"
                onclick={(e) => remove(d.id, title, e)}
                title="Hapus draft {title}"
                aria-label="Hapus draft {title}"
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <!-- Empty Filter State -->
      <div class="empty-state">
        {#if searchQuery}
          <div class="empty-icon"><Icon name="search" size={20} /></div>
          <div class="empty-title">Tidak ada hasil</div>
          <div class="empty-desc">Tidak ada TAD yang cocok dengan "{searchQuery}"</div>
          <button class="btn btn-sm btn-ghost reset-btn" onclick={() => (searchQuery = '')}>
            Reset Pencarian
          </button>
        {:else if drafts.drafts.length === 0}
          <div class="empty-icon"><Icon name="doc" size={20} /></div>
          <div class="empty-title">Belum ada TAD</div>
          <div class="empty-desc">Mulai dengan mengimpor dari Confluence atau buat baru dari PRD.</div>
          <div class="empty-actions">
            {#if onimport}
              <button class="btn btn-sm" onclick={onimport}>
                <Icon name="confluence" size={12} /> Import
              </button>
            {/if}
            <button class="btn btn-sm btn-primary" onclick={onnew}>
              <Icon name="plus" size={12} /> Buat Baru
            </button>
          </div>
        {:else}
          <div class="empty-icon"><Icon name="filter" size={20} /></div>
          <div class="empty-title">Kategori Kosong</div>
          <div class="empty-desc">Tidak ada dokumen di tab ini.</div>
          <button class="btn btn-sm btn-ghost reset-btn" onclick={() => (filterTab = 'all')}>
            Tampilkan Semua ({drafts.drafts.length})
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Collapsible TAD Section Outline & Heading Jump -->
  {#if drafts.selected}
    <div class="outline-drawer" class:collapsed={!outlineOpen}>
      <button
        class="outline-header"
        onclick={() => (outlineOpen = !outlineOpen)}
        aria-expanded={outlineOpen}
        title={outlineOpen ? 'Sembunyikan outline' : 'Tampilkan outline'}
      >
        <div class="outline-header-left">
          <span class="chevron" class:rotated={!outlineOpen}><Icon name="chevron" size={13} /></span>
          <h4>Outline Dokumen</h4>
        </div>
        <div class="outline-header-right">
          <span class="outline-badge" class:outline-ok={okSectionsCount === sections.length} title="{headings.length} heading · {okSectionsCount}/{sections.length} bagian lengkap">
            {headings.length > 0 ? `${headings.length} hd` : `${okSectionsCount}/${sections.length}`}
          </span>
        </div>
      </button>

      {#if outlineOpen}
        <!-- Pindah ke heading selector -->
        {#if headings.length > 0}
          <div class="outline-jump-bar">
            <label class="outline-jump-wrap">
              <Icon name="search" size={12} />
              <select
                class="outline-jump-select"
                onchange={(e) => {
                  const id = e.currentTarget.value;
                  const found = headings.find((h) => h.id === id);
                  if (found) onjumpheading?.(found);
                  e.currentTarget.value = '';
                }}
                aria-label="Pindah ke heading tertentu"
                title="Pilih heading untuk auto scroll"
              >
                <option value="" disabled selected>Pindah ke heading…</option>
                {#each headings as h (h.id)}
                  <option value={h.id}>
                    {'  '.repeat(Math.max(0, h.depth - 1))}H{h.depth}: {h.text.slice(0, 30)}{h.text.length > 30 ? '…' : ''} (Ln {h.line})
                  </option>
                {/each}
              </select>
            </label>
          </div>

          <!-- Mode tabs: Heading vs Section -->
          <div class="outline-mode-tabs" role="tablist" aria-label="Tampilan outline">
            <button
              role="tab"
              class="outline-tab-btn"
              class:active={outlineTab === 'headings'}
              onclick={() => (outlineTab = 'headings')}
            >
              Semua Heading ({headings.length})
            </button>
            <button
              role="tab"
              class="outline-tab-btn"
              class:active={outlineTab === 'sections'}
              onclick={() => (outlineTab = 'sections')}
            >
              Section ({okSectionsCount}/{sections.length})
            </button>
          </div>
        {/if}

        {#if outlineTab === 'headings' && headings.length > 0}
          {#if headings.length > 5}
            <div class="outline-filter-box">
              <Icon name="search" size={11} />
              <input
                type="text"
                placeholder="Filter heading / task..."
                bind:value={outlineHeadingQuery}
                aria-label="Filter heading"
              />
              {#if outlineHeadingQuery}
                <button class="clear-btn-xs" onclick={() => (outlineHeadingQuery = '')} title="Reset filter">
                  <Icon name="x" size={10} />
                </button>
              {/if}
            </div>
          {/if}

          <ol class="outline-list">
            {#each filteredOutlineHeadings as h (h.id)}
              <li>
                <button
                  class="sec-item heading-item depth-{h.depth}"
                  onclick={() => onjumpheading?.(h)}
                  title={`${h.text} (Baris ${h.line}) — Klik untuk auto scroll`}
                >
                  <span class="heading-badge depth-badge-{h.depth}">H{h.depth}</span>
                  {#if h.taskType}
                    <span class="task-chip">{h.taskType}</span>
                  {/if}
                  <span class="sec-name">{h.text}</span>
                  <span class="sec-line mono">L{h.line}</span>
                </button>
              </li>
            {:else}
              <li class="empty-outline-hint muted small">Tidak ada heading yang cocok</li>
            {/each}
          </ol>
        {:else}
          <ol class="outline-list">
            {#each sections as s (s.section.id)}
              <li>
                <button
                  class="sec-item"
                  onclick={() => onjump(s)}
                  disabled={s.status === 'missing'}
                  title={`${s.section.guidance} — ${STATUS_LABEL[s.status]}`}
                >
                  <span class="sec-dot dot-{s.status}" aria-label={STATUS_LABEL[s.status]}></span>
                  <span class="sec-num">{s.section.number}</span>
                  <span class="sec-name">{s.section.title}</span>
                </button>
              </li>
            {/each}
          </ol>
        {/if}
      {/if}
    </div>
  {/if}
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }

  /* Header */
  .sidebar-header {
    padding: 12px 12px 8px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--surface);
    flex-shrink: 0;
  }

  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-2);
  }

  .count-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    background: var(--surface-2);
    color: var(--text-3);
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .action-btn {
    padding: 0 7px;
    height: 24px;
    font-size: 11.5px;
    gap: 4px;
  }

  .collapse-btn {
    padding: 0 4px;
    height: 24px;
    width: 24px;
    color: var(--text-3);
  }

  .collapse-btn:hover {
    color: var(--text);
  }

  /* Search Box */
  .search-box {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
  }

  .search-icon {
    position: absolute;
    left: 8px;
    display: flex;
    align-items: center;
    color: var(--text-3);
    pointer-events: none;
  }

  .search-box input {
    width: 100%;
    height: 28px;
    padding: 0 24px 0 26px;
    font-size: 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text);
    transition: all 0.15s ease;
  }

  .search-box input:focus {
    outline: none;
    border-color: var(--accent);
    background: var(--surface);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .search-box input::placeholder {
    color: var(--text-3);
  }

  .clear-btn {
    position: absolute;
    right: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 0;
    background: none;
    color: var(--text-3);
    cursor: pointer;
    border-radius: 50%;
  }

  .clear-btn:hover {
    color: var(--text);
    background: var(--surface-hover);
  }

  /* Filter Tabs */
  .filter-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--surface-2);
    padding: 2px;
    border-radius: var(--radius-sm);
  }

  .tab-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 22px;
    padding: 0 4px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.12s ease;
    white-space: nowrap;
  }

  .tab-btn:hover {
    color: var(--text-2);
  }

  .tab-btn.active {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: var(--shadow);
  }

  .tab-count {
    font-size: 10px;
    opacity: 0.75;
  }

  /* List Container */
  .list-container {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 6px;
  }

  .drafts-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .draft-item {
    position: relative;
    border-radius: var(--radius-sm);
    transition: background 0.12s;
  }

  .draft-item:hover {
    background: var(--surface-hover);
  }

  .draft-item.active {
    background: var(--accent-soft);
  }

  .draft-card {
    display: block;
    width: 100%;
    padding: 8px 46px 8px 8px;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .card-main {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--text-3);
    flex-shrink: 0;
    margin-top: 1px;
  }

  .card-icon.is-confluence {
    background: #0052cc15;
    color: #0052cc;
  }

  .active .card-icon {
    background: var(--surface);
    color: var(--accent);
  }

  .card-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .draft-title {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.3;
  }

  .active .draft-title {
    color: var(--accent);
  }

  .draft-meta-row {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    font-size: 11px;
  }

  .meta-chip {
    display: inline-flex;
    align-items: center;
    height: 16px;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
  }

  .chip-sync {
    background: var(--ok-soft);
    color: var(--ok);
  }

  .chip-local {
    background: var(--surface-2);
    color: var(--text-3);
  }

  .chip-jira {
    background: #0052cc15;
    color: #0052cc;
  }

  .meta-time {
    color: var(--text-3);
    font-size: 11px;
    margin-left: auto;
    white-space: nowrap;
  }

  .rename-input {
    width: 100%;
    height: 22px;
    padding: 0 6px;
    font-size: 12.5px;
    font-weight: 600;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-soft);
  }


  .item-actions {
    position: absolute;
    top: 6px;
    right: 4px;
    display: flex;
    align-items: center;
    gap: 1px;
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .draft-item:hover .item-actions,
  .item-actions:focus-within {
    opacity: 1;
  }

  .action-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-3);
    cursor: pointer;
    transition: all 0.12s ease;
  }

  .edit-btn:hover {
    color: var(--accent);
    background: var(--accent-soft);
  }

  .del-btn:hover {
    color: var(--err);
    background: var(--err-soft);
  }

  /* Empty State */
  .empty-state {
    padding: 24px 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 8px;
  }

  .empty-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text-3);
  }

  .empty-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .empty-desc {
    font-size: 11.5px;
    color: var(--text-3);
    max-width: 220px;
    line-height: 1.4;
  }

  .reset-btn {
    margin-top: 4px;
  }

  .empty-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }

  /* Collapsible Outline Drawer */
  .outline-drawer {
    border-top: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
    max-height: 40%;
    display: flex;
    flex-direction: column;
  }

  .outline-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 12px;
    border: 0;
    background: none;
    cursor: pointer;
    text-align: left;
    transition: background 0.12s;
  }

  .outline-header:hover {
    background: var(--surface-hover);
  }

  .outline-header-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .chevron {
    display: flex;
    align-items: center;
    color: var(--text-3);
    transition: transform 0.15s ease;
  }

  .chevron.rotated {
    transform: rotate(-90deg);
  }

  h4 {
    margin: 0;
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-2);
  }

  .outline-badge {
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 600;
    background: var(--warn-soft);
    color: var(--warn);
  }

  .outline-badge.outline-ok {
    background: var(--ok-soft);
    color: var(--ok);
  }

  .outline-list {
    list-style: none;
    margin: 0;
    padding: 0 8px 8px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sec-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
    cursor: pointer;
    color: var(--text-2);
    font-size: 12px;
    transition: all 0.1s ease;
  }

  .sec-item:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }

  .sec-item:disabled {
    cursor: default;
    color: var(--text-3);
    text-decoration: line-through;
  }

  .sec-num {
    width: 14px;
    text-align: right;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
  }

  .sec-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sec-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dot-ok {
    background: var(--ok);
  }

  .dot-warning {
    background: var(--warn);
  }

  .dot-error,
  .dot-missing {
    background: var(--err);
  }

  /* Outline Jump Bar & Selector */
  .outline-jump-bar {
    padding: 6px 8px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .outline-jump-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3);
  }

  .outline-jump-wrap:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  .outline-jump-select {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text);
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    text-overflow: ellipsis;
  }

  /* Outline Mode Switcher Tabs */
  .outline-mode-tabs {
    display: flex;
    gap: 2px;
    padding: 4px 8px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .outline-tab-btn {
    flex: 1;
    height: 22px;
    padding: 0 4px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text-2);
    font-size: 10.5px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.1s ease;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .outline-tab-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .outline-tab-btn.active {
    background: var(--surface-2);
    color: var(--accent);
    font-weight: 600;
  }

  /* Filter Box */
  .outline-filter-box {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    color: var(--text-3);
  }

  .outline-filter-box input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 11px;
    color: var(--text);
    font-family: inherit;
  }

  .clear-btn-xs {
    border: 0;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    padding: 2px;
    display: flex;
  }

  /* Heading Item Styling */
  .heading-item.depth-1 { font-weight: 600; }
  .heading-item.depth-2 { padding-left: 8px; }
  .heading-item.depth-3 { padding-left: 16px; font-size: 11.5px; }
  .heading-item.depth-4 { padding-left: 22px; font-size: 11px; }

  .heading-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--text-3);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }
  .depth-badge-1 { background: #e0e7ff; color: #3730a3; }
  .depth-badge-2 { background: #e0f2fe; color: #0369a1; }
  .depth-badge-3 { background: #fef3c7; color: #92400e; }

  .task-chip {
    font-size: 9px;
    font-weight: 600;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--accent);
    flex-shrink: 0;
  }

  .sec-line {
    font-size: 9.5px;
    color: var(--text-3);
    flex-shrink: 0;
  }

  .empty-outline-hint {
    padding: 12px;
    text-align: center;
  }
</style>
