<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { connector } from '../lib/confluence/client';
  import { buildMerged, mergeSummary, threeWayMerge, type MergeSection, type SectionStatus } from '../lib/confluence/merge';
  import { storageToMarkdown } from '../lib/confluence/storage-to-markdown';
  import { lineDiff, type DiffLine } from '../lib/diff';
  import { drafts, type Draft } from './drafts.svelte';

  /**
   * Brings edits made directly in Confluence into the draft: three-way merge per section between
   * the version the draft is based on, the draft, and the page now. The merge is one revision, so
   * it can be rolled back from Revisi.
   */
  let { open = $bindable(false), draft, onmerged }: { open: boolean; draft: Draft; onmerged?: () => void } = $props();

  let loading = $state(false);
  let error = $state('');
  let sections = $state<MergeSection[]>([]);
  let remote = $state<{ version: number; markdown: string; title: string } | null>(null);
  let meta = $state<{ by?: string; when?: string } | null>(null);
  let showSame = $state(false);
  let openKey = $state<string | null>(null);
  let wasOpen = false;

  const baseVersion = $derived(draft.confluence.version ?? 0);
  const summary = $derived(mergeSummary(sections));
  const visible = $derived(sections.filter((s) => showSame || s.status !== 'same'));

  $effect(() => {
    if (open && !wasOpen) untrack(() => void load());
    wasOpen = open;
  });

  async function load() {
    const pageId = draft.confluence.pageId;
    if (!pageId) return;
    loading = true;
    error = '';
    sections = [];
    remote = null;
    try {
      const [page, info] = await Promise.all([connector.page({ id: pageId }), connector.pageVersion(pageId).catch(() => null)]);
      meta = info;
      const remoteMd = storageToMarkdown(page.storage ?? '', page.title).markdown;
      remote = { version: page.version, markdown: remoteMd, title: page.title };
      // Without a known base (very old drafts) every difference is shown as a decision.
      const baseMd = baseVersion > 0 ? storageToMarkdown((await connector.pageAt(pageId, baseVersion)).storage, page.title).markdown : '';
      sections = threeWayMerge(baseMd, draft.markdown, remoteMd);
      openKey = sections.find((s) => s.status === 'conflict')?.key ?? null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  const LABEL: Record<SectionStatus, string> = {
    same: 'Sama',
    remote: 'Diambil dari Confluence',
    local: 'Perubahan Cockpit dipertahankan',
    conflict: 'Konflik: berubah di keduanya',
    'added-remote': 'Baru di Confluence',
    'added-local': 'Baru di Cockpit',
    'removed-remote': 'Dihapus di Confluence',
    'removed-local': 'Dihapus di Cockpit',
  };
  const TONE: Record<SectionStatus, string> = {
    same: '',
    remote: 'tone-remote',
    'added-remote': 'tone-remote',
    'removed-remote': 'tone-remote',
    local: 'tone-local',
    'added-local': 'tone-local',
    'removed-local': 'tone-local',
    conflict: 'tone-conflict',
  };

  /** What changed against the base, for one side. */
  function diffOf(from: string | undefined, to: string | undefined): DiffLine[] {
    return lineDiff((from ?? '').split('\n'), (to ?? '').split('\n')).filter((l, i, all) => l.type !== 'same' || all[i - 1]?.type !== 'same' || all[i + 1]?.type !== 'same');
  }

  function finish(markdown: string, summaryText: string) {
    if (!remote) return;
    drafts.applyRevision(draft.id, markdown, summaryText);
    // The draft is now based on the page as it is: publishing can update it safely.
    drafts.update(draft.id, { confluence: { ...draft.confluence, version: remote.version } });
    drafts.saveNow();
    open = false;
    onmerged?.();
  }

  function applyMerge() {
    if (!remote) return;
    finish(buildMerged(sections), `Gabung perubahan Confluence v${baseVersion} → v${remote.version}`);
    toasts.show(`Perubahan Confluence v${remote.version} digabung ke draft. Versi sebelumnya ada di Revisi.`, 'ok', 5000);
  }

  async function takeAllRemote() {
    if (!remote) return;
    const ok = await confirmDialog({
      title: 'Ambil semua dari Confluence?',
      message: `Isi draft diganti dengan halaman Confluence v${remote.version}. Perubahan di Cockpit yang belum dipublish hilang dari draft (masih bisa dikembalikan dari Revisi).`,
      confirmText: 'Ganti dengan Confluence',
      danger: true,
    });
    if (!ok) return;
    finish(remote.markdown, `Ambil ulang dari Confluence v${remote.version}`);
    toasts.show(`Draft diganti dengan Confluence v${remote.version}.`, 'ok', 4000);
  }

  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '');
</script>

<Modal bind:open title="Gabungkan perubahan dari Confluence" subtitle="Halaman diubah langsung di Confluence setelah draft ini terakhir diimpor/dipublish" width={980}>
  <div class="merge">
    {#if loading}
      <p class="muted">Mengambil versi Confluence dan menghitung perbedaan…</p>
    {:else if error}
      <p class="err">{error}</p>
      <button class="btn btn-sm" onclick={load}>Coba lagi</button>
    {:else if remote}
      <div class="head">
        <span>Draft berbasis <strong>v{baseVersion || '?'}</strong> · Confluence sekarang <strong>v{remote.version}</strong>{meta?.by ? ` · terakhir diubah ${meta.by}` : ''}{meta?.when ? `, ${fmt(meta.when)}` : ''}</span>
      </div>
      <div class="summary">
        <span class="pill tone-remote">{summary.fromRemote} bagian dari Confluence</span>
        <span class="pill tone-local">{summary.keptLocal} perubahan Cockpit dipertahankan</span>
        <span class="pill tone-conflict">{summary.conflicts} konflik</span>
        <span class="pill">{summary.same} sama</span>
        <span class="grow"></span>
        <label class="check small"><input type="checkbox" bind:checked={showSame} /> Tampilkan yang sama</label>
      </div>
      {#if !baseVersion}
        <p class="note">Versi dasar draft tidak diketahui (draft lama), jadi setiap perbedaan perlu kamu putuskan.</p>
      {/if}

      <div class="list">
        {#each visible as s (s.key)}
          <article class="sec {TONE[s.status]}">
            <button class="sec-head" onclick={() => (openKey = openKey === s.key ? null : s.key)} aria-expanded={openKey === s.key}>
              <span class="caret">{openKey === s.key ? '▾' : '▸'}</span>
              <strong class="sec-title">{s.title}</strong>
              <span class="pill {TONE[s.status]}">{LABEL[s.status]}</span>
            </button>
            {#if s.status === 'conflict'}
              <div class="choice" role="radiogroup" aria-label="Pilih versi {s.title}">
                <label><input type="radio" bind:group={s.choice} value="local" /> Pakai versi Cockpit</label>
                <label><input type="radio" bind:group={s.choice} value="remote" /> Pakai versi Confluence</label>
              </div>
            {/if}
            {#if openKey === s.key}
              <div class="diffs" class:two={s.status === 'conflict'}>
                {#if s.status === 'conflict' || s.status.endsWith('local')}
                  <div>
                    <h4>Perubahan di Cockpit</h4>
                    <pre class="diff">{#each diffOf(s.base, s.local) as l, i (i)}<span class="d-{l.type}">{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}</span>{'\n'}{/each}</pre>
                  </div>
                {/if}
                {#if s.status === 'conflict' || s.status.endsWith('remote')}
                  <div>
                    <h4>Perubahan di Confluence</h4>
                    <pre class="diff">{#each diffOf(s.base, s.remote) as l, i (i)}<span class="d-{l.type}">{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}</span>{'\n'}{/each}</pre>
                  </div>
                {/if}
                {#if s.status === 'same'}<pre class="diff">{s.local}</pre>{/if}
              </div>
            {/if}
          </article>
        {:else}
          <p class="muted">Tidak ada perbedaan isi; hanya nomor versi yang berubah. Terapkan untuk menandai draft sudah sinkron.</p>
        {/each}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <div class="foot">
      <button class="btn btn-ghost btn-sm" onclick={takeAllRemote} disabled={!remote || loading}><Icon name="download" size={13} /> Ambil semua dari Confluence</button>
      <span class="grow"></span>
      <button class="btn btn-sm" onclick={() => (open = false)}>Nanti</button>
      <button class="btn btn-primary btn-sm" onclick={applyMerge} disabled={!remote || loading}><Icon name="check" size={13} /> Terapkan gabungan{summary.conflicts ? ` (${summary.conflicts} konflik dipilih)` : ''}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .merge {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .head {
    font-size: 13px;
  }
  .summary {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .pill {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--surface-hover);
    white-space: nowrap;
  }
  .tone-remote.pill {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .tone-local.pill {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .tone-conflict.pill {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .grow {
    flex: 1;
  }
  .small {
    font-size: 12px;
  }
  .check {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .note {
    margin: 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    font-size: 12.5px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sec {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .sec.tone-conflict {
    border-color: var(--warn);
  }
  .sec-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }
  .sec-title {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .choice {
    display: flex;
    gap: 16px;
    margin: 6px 0 0 20px;
    font-size: 12.5px;
  }
  .diffs {
    display: grid;
    gap: 8px;
    margin-top: 8px;
  }
  .diffs.two {
    grid-template-columns: 1fr 1fr;
  }
  .diffs h4 {
    margin: 0 0 4px;
    font-size: 12px;
  }
  .diff {
    margin: 0;
    max-height: 320px;
    overflow: auto;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-size: 11.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .d-add {
    color: var(--ok);
  }
  .d-del {
    color: var(--err);
    text-decoration: line-through;
  }
  .d-same {
    color: var(--text-2, var(--text));
    opacity: 0.7;
  }
  .err {
    color: var(--err);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  @media (max-width: 800px) {
    .diffs.two {
      grid-template-columns: 1fr;
    }
  }
</style>
