<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { toasts } from '../components/toast.svelte';
  import { connector } from '../lib/confluence/client';
  import { buildHunks, lineDiff } from '../lib/diff';
  import { trackedHunk } from '../lib/html-diff';
  import { renderPreview } from '../lib/markdown/preview';
  import { extractPageId, fetchPrd, type PrdSource } from '../lib/prd/confluence-prd';
  import { parsePrd } from '../lib/prd/parser';
  import { drafts, type Draft } from './drafts.svelte';
  import PreviewPane from './PreviewPane.svelte';

  let { draft, onaskai }: { draft: Draft; onaskai: (prompt: string) => void } = $props();

  const CHECK_EVERY_MS = 10 * 60_000;
  const MIN_GAP_MS = 60_000;

  const source = $derived(draft.prdSource);
  const outdated = $derived(Boolean(source?.latestVersion && source.latestVersion > source.version));

  let checking = $state(false);
  let checkError = $state('');
  let lastCheck = 0;

  /** Only the version is compared here; content is fetched when the user wants to see it. */
  async function check(force = false) {
    const s = draft.prdSource;
    if (!s || checking || (!force && Date.now() - lastCheck < MIN_GAP_MS)) return;
    lastCheck = Date.now();
    checking = true;
    try {
      const page = await connector.page({ id: s.pageId });
      checkError = '';
      const now = new Date().toISOString();
      drafts.update(draft.id, { prdSource: { ...s, latestVersion: page.version > s.version ? page.version : undefined, checkedAt: now } });
      if (force && page.version <= s.version) toasts.show(`PRD masih versi terbaru (v${s.version}).`, 'ok');
    } catch (e) {
      checkError = (e as Error).message;
    } finally {
      checking = false;
    }
  }

  // On open, every 10 minutes, and when the window regains focus.
  $effect(() => {
    if (!draft.prdSource?.pageId) return;
    void check();
    const t = setInterval(() => void check(), CHECK_EVERY_MS);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  });

  // ── Review the change ──
  let diffOpen = $state(false);
  let incoming = $state<{ markdown: string; source: PrdSource } | null>(null);
  let loadingDiff = $state(false);
  let linking = $state(false);
  let linkRef = $state('');

  const diff = $derived(incoming ? lineDiff((draft.prdMarkdown ?? '').split('\n'), incoming.markdown.split('\n')) : []);
  const hunks = $derived(buildHunks(diff));
  const tracked = $derived(hunks.map((h) => ({ h, ...trackedHunk(diff, h, (md) => renderPreview(md).html) })));

  async function openDiff(pageId = draft.prdSource?.pageId) {
    if (!pageId) return;
    loadingDiff = true;
    try {
      incoming = await fetchPrd(pageId);
      diffOpen = true;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      loadingDiff = false;
    }
  }

  /** Change summary for the AI: which sections changed and the changed lines themselves. */
  function changePrompt(from: number | undefined, to: number): string {
    const sections = [...new Set(hunks.map((h) => h.section))];
    const changed = diff
      .filter((l) => l.type !== 'same' && l.text.trim())
      .map((l) => `${l.type === 'add' ? '+' : '-'} ${l.text}`)
      .join('\n')
      .slice(0, 6_000);
    return [
      `PRD "${incoming?.source.title ?? draft.prdSource?.title}" di Confluence diperbarui${from ? ` dari versi ${from}` : ''} ke versi ${to}; PRD.md sudah berisi versi terbaru.`,
      `Bagian PRD yang berubah: ${sections.join(', ') || '-'}.`,
      'Sesuaikan TAD dengan perubahan ini saja: tambah/ubah task, Detail Task, atau Development Scope yang terdampak, tanpa mengubah bagian yang tidak terkait. Sebutkan di balasan task mana yang berubah dan kenapa.',
      '',
      'Ringkasan baris yang berubah (+ ditambah, - dihapus):',
      changed,
    ].join('\n');
  }

  function apply(askAi: boolean) {
    if (!incoming) return;
    const from = draft.prdSource?.version;
    const to = incoming.source.version;
    const prompt = changePrompt(from, to);
    const prd = parsePrd(incoming.markdown);
    drafts.update(draft.id, {
      prdMarkdown: incoming.markdown,
      prdSource: { ...incoming.source, latestVersion: undefined },
      source: { ...draft.source, prdTitle: prd.metadata.title || incoming.source.title },
    });
    drafts.addChatMessage(draft.id, {
      sender: 'system',
      text: `PRD diperbarui dari Confluence${from ? ` (v${from} → v${to})` : ` (v${to})`}: ${hunks.length} bagian berubah${hunks.length ? ` (${[...new Set(hunks.map((h) => h.section))].slice(0, 6).join(', ')})` : ''}.`,
    });
    diffOpen = false;
    toasts.show(`PRD diperbarui ke versi ${to}.`, 'ok');
    if (askAi && hunks.length) onaskai(prompt);
    incoming = null;
  }

  async function link() {
    const id = extractPageId(linkRef);
    if (!id) return toasts.show('Tempel link halaman PRD di Confluence atau ID-nya.', 'err');
    linking = true;
    try {
      await openDiff(id);
    } finally {
      linking = false;
    }
  }
</script>

{#if source}
  {#if outdated}
    <div class="banner warn" role="status">
      <Icon name="alert" size={15} />
      <span>
        <strong>PRD di Confluence diperbarui</strong>: versi {source.version} → {source.latestVersion}. TAD ini masih berdasarkan versi {source.version}.
      </span>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" onclick={() => openDiff()} disabled={loadingDiff}>{loadingDiff ? 'Mengambil…' : 'Lihat perubahan'}</button>
    </div>
  {:else}
    <span class="sync muted" title={checkError || `Terakhir dicek ${source.checkedAt ? new Date(source.checkedAt).toLocaleString('id-ID') : '-'}`}>
      <Icon name={checkError ? 'alert' : 'confluence'} size={12} />
      PRD v{source.version}{checkError ? ' · gagal cek' : ' · terbaru'}
      <button class="link" onclick={() => check(true)} disabled={checking}>{checking ? 'mengecek…' : 'cek'}</button>
      {#if source.url}<a class="link" href={source.url} target="_blank" rel="noreferrer">buka</a>{/if}
    </span>
  {/if}
{:else}
  <form
    class="sync link-form"
    onsubmit={(e) => {
      e.preventDefault();
      void link();
    }}
  >
    <Icon name="confluence" size={12} />
    <input class="input" bind:value={linkRef} placeholder="Tautkan PRD ke halaman Confluence (link)…" />
    <button class="btn btn-sm" disabled={linking || !linkRef.trim()}>{linking ? '…' : 'Tautkan'}</button>
  </form>
{/if}

<Modal
  bind:open={diffOpen}
  title={draft.prdSource ? 'Perubahan PRD' : 'Tautkan PRD ke Confluence'}
  subtitle={incoming ? `${incoming.source.title} · versi ${draft.prdSource?.version ?? '?'} → ${incoming.source.version}` : ''}
  width={1100}
>
  {#if incoming}
    {#if !hunks.length}
      <p class="muted">Isi PRD sama dengan yang dipakai TAD ini{draft.prdSource ? '' : '; draft akan ditautkan ke halaman ini untuk cek update berikutnya'}.</p>
    {:else}
      <p class="legend">
        <ins class="tc-add-sample">teks baru</ins> ditambahkan · <del class="tc-del-sample">teks lama</del> dihapus · {hunks.length} bagian berubah
      </p>
      <div class="hunks">
        {#each tracked as t (t.h.id)}
          <section class="hunk">
            <header>{t.h.section}{#if t.formatOnly}<span class="fmt">format saja</span>{/if}</header>
            <PreviewPane html={t.html} embedded />
          </section>
        {/each}
      </div>
    {/if}
  {/if}
  {#snippet footer()}
    <span class="spacer"></span>
    <button class="btn" onclick={() => ((diffOpen = false), (incoming = null))}>Nanti</button>
    {#if hunks.length}
      <button class="btn" onclick={() => apply(false)}>Perbarui PRD saja</button>
      <button class="btn btn-primary" onclick={() => apply(true)}><Icon name="sparkles" size={14} /> Perbarui PRD & siapkan instruksi AI</button>
    {:else}
      <button class="btn btn-primary" onclick={() => apply(false)}>{draft.prdSource ? 'Tandai sudah terbaru' : 'Tautkan'}</button>
    {/if}
  {/snippet}
</Modal>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 10px;
    font-size: 13px;
  }
  .banner.warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .spacer {
    flex: 1;
  }
  .sync {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
    text-decoration: underline;
  }
  .link-form input {
    min-height: 26px;
    padding: 2px 8px;
    font-size: 12px;
    width: 260px;
  }
  .legend {
    margin: 0 0 8px;
    font-size: 12.5px;
    color: var(--text-2);
  }
  .tc-add-sample {
    color: #006644;
    background: #e3fcef;
  }
  .tc-del-sample {
    color: #bf2600;
    background: #ffebe6;
  }
  .hunks {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 62vh;
    overflow: auto;
    padding: 10px;
    border-radius: 10px;
    background: var(--surface-2);
  }
  .hunk {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--page-bg);
    flex-shrink: 0;
  }
  .hunk header {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 12px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .fmt {
    padding: 0 7px;
    border-radius: 999px;
    background: var(--surface-hover);
    font-size: 11.5px;
    font-weight: 500;
  }
</style>
