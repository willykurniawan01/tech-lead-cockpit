<script lang="ts">
  import AiPicker from '../components/AiPicker.svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { loadAiSelection, saveAiSelection } from '../lib/ai/providers.svelte';
  import type { AiSelection } from '../lib/ai/types';
  import { parsePrd } from '../lib/prd/parser';
  import { extractPageId, fetchPrd, type PrdSource } from '../lib/prd/confluence-prd';
  import type { PrdData } from '../lib/prd/types';
  import { blankTad, generateTadSkeleton } from '../lib/tad/generator';
  import { fetchServicesInfo, grantAntigravityRead, loadServicesRoot, saveServicesRoot, type PrdImportResult, type ServicesInfo } from './generator-client';

  let {
    open = $bindable(false),
    oncreate,
  }: {
    open: boolean;
    oncreate: (result: PrdImportResult) => void;
  } = $props();

  const MAX_FILE_MB = 20;

  let prdText = $state('');
  let customAuthor = $state('');
  let customCodeName = $state('');
  let extraFigma = $state<{ title?: string; url: string }[]>([]);
  let removedFigma = $state<string[]>([]);
  let newFigmaUrl = $state('');
  let files = $state<File[]>([]);
  let servicesRoot = $state(loadServicesRoot());
  let services = $state<ServicesInfo | null>(null);
  let checkingServices = $state(false);
  let granting = $state(false);
  let ai = $state<AiSelection>(loadAiSelection('generator'));
  let start = $state<'brainstorm' | 'generate' | 'none'>('brainstorm');
  let fileError = $state('');

  // PRD straight from Confluence: remembered so the TAD can tell when the PRD changes later.
  let confluenceRef = $state('');
  let prdSource = $state<PrdSource | undefined>();
  let fetchingPrd = $state(false);
  let fetchError = $state('');
  /** The text as fetched; manual edits afterwards are allowed but noted. */
  let fetchedText = $state('');

  async function fetchFromConfluence() {
    const id = extractPageId(confluenceRef);
    if (!id) {
      fetchError = 'Tempel link halaman Confluence (…/pages/123/…) atau ID halamannya.';
      return;
    }
    fetchingPrd = true;
    fetchError = '';
    try {
      const { markdown, source } = await fetchPrd(id);
      prdText = markdown;
      fetchedText = markdown;
      prdSource = source;
    } catch (e) {
      fetchError = (e as Error).message;
    } finally {
      fetchingPrd = false;
    }
  }

  const parsed = $derived<PrdData | null>(prdText.trim() ? parsePrd(prdText) : null);
  const figmaLinks = $derived([...(parsed?.figmaLinks ?? []), ...extraFigma].filter((f, i, all) => !removedFigma.includes(f.url) && all.findIndex((x) => x.url === f.url) === i));
  const needsAgyGrant = $derived(ai.provider === 'antigravity' && services?.exists && !services.antigravity.granted);

  async function checkServices() {
    checkingServices = true;
    try {
      services = await fetchServicesInfo(servicesRoot);
    } catch (e) {
      services = { root: servicesRoot, exists: false, services: [], error: (e as Error).message, antigravity: { granted: false, settingsFile: '' } };
    } finally {
      checkingServices = false;
    }
  }

  // Re-check the codebase folder whenever the dialog opens or the path settles.
  $effect(() => {
    if (!open) return;
    const root = servicesRoot;
    const t = setTimeout(() => {
      if (root === servicesRoot) checkServices();
    }, 400);
    return () => clearTimeout(t);
  });

  async function grant() {
    if (!services?.exists) return;
    granting = true;
    try {
      const status = await grantAntigravityRead(services.root);
      services = { ...services, antigravity: status };
    } catch (e) {
      services = services && { ...services, error: (e as Error).message };
    } finally {
      granting = false;
    }
  }

  function reset() {
    prdText = '';
    customAuthor = '';
    customCodeName = '';
    confluenceRef = '';
    prdSource = undefined;
    fetchError = '';
    fetchedText = '';
    extraFigma = [];
    removedFigma = [];
    newFigmaUrl = '';
    files = [];
    fileError = '';
  }

  function readPrdFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    file.text().then((t) => {
      prdText = t;
      prdSource = undefined; // a file has no page to follow
    });
  }

  function addFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const picked = [...(input.files ?? [])];
    input.value = '';
    const tooBig = picked.filter((f) => f.size > MAX_FILE_MB * 1024 * 1024);
    fileError = tooBig.length ? `Lewati ${tooBig.map((f) => f.name).join(', ')}: melebihi ${MAX_FILE_MB} MB.` : '';
    files = [...files, ...picked.filter((f) => f.size <= MAX_FILE_MB * 1024 * 1024 && !files.some((x) => x.name === f.name))];
  }

  function addFigma() {
    const url = newFigmaUrl.trim();
    if (!/^https:\/\/([\w-]+\.)*figma\.com\//.test(url)) return;
    extraFigma = [...extraFigma, { url }];
    removedFigma = removedFigma.filter((u) => u !== url);
    newFigmaUrl = '';
  }

  function setAi(sel: AiSelection) {
    ai = sel;
    saveAiSelection('generator', sel);
  }

  function generate() {
    if (!parsed) return;
    saveServicesRoot(servicesRoot.trim());
    const markdown = generateTadSkeleton(parsed, {
      author: customAuthor.trim() || parsed.metadata.techLead || '@TechLead',
      codeName: customCodeName.trim() || parsed.metadata.codeName,
      figmaLinks,
      supportingDocs: files.map((f) => f.name),
    });
    oncreate({ markdown, prdMarkdown: prdText, prdSource, figmaLinks, files, servicesRoot: servicesRoot.trim(), ai, start: services?.exists ? start : 'none' });
    open = false;
    reset();
  }

  function blank() {
    oncreate({ markdown: blankTad('Untitled Document'), figmaLinks: [], files: [], servicesRoot: servicesRoot.trim(), ai, start: 'none' });
    open = false;
    reset();
  }

  const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
</script>

<Modal bind:open title="Import PRD & Generate TAD" subtitle="Input: PRD, Figma, dan dokumen pendukung. AI menganalisa codebase untuk menentukan service dan task." width={980} height={700}>
  <div class="grid">
    <div class="left">
      <section class="block">
        <div class="block-head">
          <h3>1. PRD</h3>
          <label class="btn btn-sm file-btn">
            <Icon name="upload" size={14} /> Upload .md
            <input type="file" accept=".md,.markdown,.txt" onchange={readPrdFile} />
          </label>
          {#if prdText}<button class="btn btn-sm btn-ghost" onclick={() => ((prdText = ''), (prdSource = undefined))}>Bersihkan</button>{/if}
        </div>
        <form
          class="confluence-row"
          onsubmit={(e) => {
            e.preventDefault();
            void fetchFromConfluence();
          }}
        >
          <Icon name="confluence" size={15} />
          <input class="input" bind:value={confluenceRef} placeholder="Atau tempel link halaman PRD di Confluence…" />
          <button class="btn btn-sm" disabled={fetchingPrd || !confluenceRef.trim()}>{fetchingPrd ? 'Mengambil…' : 'Ambil'}</button>
        </form>
        {#if fetchError}<p class="hint warn">{fetchError}</p>{/if}
        {#if prdSource}
          <p class="hint ok-hint">
            <Icon name="check" size={12} /> Dari Confluence: <strong>{prdSource.title}</strong> (versi {prdSource.version}). TAD akan memberi tahu kalau halaman ini diperbarui.
            {#if fetchedText && prdText !== fetchedText}<span class="warn"> Isi sudah kamu ubah manual; cek update tetap membandingkan dengan versi Confluence.</span>{/if}
          </p>
        {/if}
        <textarea class="input mono" rows={9} bind:value={prdText} placeholder="Tempel isi PRD (export Markdown dari Confluence): tabel metadata, Objective, Requirements, link Figma…"></textarea>
      </section>

      <section class="block">
        <div class="block-head"><h3>2. Figma</h3><span class="muted small">{figmaLinks.length} link</span></div>
        {#if figmaLinks.length}
          <ul class="list">
            {#each figmaLinks as f (f.url)}
              <li>
                <Icon name="external" size={13} />
                <a href={f.url} target="_blank" rel="noreferrer" title={f.url}>{f.title || f.url}</a>
                <button class="btn btn-ghost btn-sm" onclick={() => ((removedFigma = [...removedFigma, f.url]), (extraFigma = extraFigma.filter((x) => x.url !== f.url)))} aria-label="Hapus link"><Icon name="x" size={12} /></button>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="inline">
          <input class="input" bind:value={newFigmaUrl} placeholder="https://www.figma.com/design/…" onkeydown={(e) => e.key === 'Enter' && addFigma()} />
          <button class="btn btn-sm" onclick={addFigma} disabled={!/^https:\/\/([\w-]+\.)*figma\.com\//.test(newFigmaUrl.trim())}><Icon name="plus" size={13} /> Tambah</button>
        </div>
        <p class="hint muted">AI tidak bisa membuka Figma langsung. Untuk konteks layar, upload ekspor PNG/PDF dari Figma sebagai dokumen pendukung.</p>
      </section>

      <section class="block">
        <div class="block-head">
          <h3>3. Dokumen pendukung</h3>
          <label class="btn btn-sm file-btn">
            <Icon name="upload" size={14} /> Tambah file
            <input type="file" multiple accept=".md,.markdown,.txt,.json,.yaml,.yml,.csv,.pdf,.png,.jpg,.jpeg,.webp,.html,.xml,.proto,.graphql,.sql" onchange={addFiles} />
          </label>
        </div>
        {#if files.length}
          <ul class="list">
            {#each files as f (f.name)}
              <li>
                <Icon name="doc" size={13} />
                <span class="name">{f.name}</span>
                <span class="muted small">{kb(f.size)}</span>
                <button class="btn btn-ghost btn-sm" onclick={() => (files = files.filter((x) => x !== f))} aria-label="Hapus file"><Icon name="x" size={12} /></button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="hint muted">Mis. dokumentasi API partner (PDF/OpenAPI), ekspor layar Figma, catatan meeting. Maks {MAX_FILE_MB} MB per file.</p>
        {/if}
        {#if fileError}<p class="hint warn">{fileError}</p>{/if}
      </section>
    </div>

    <aside class="right">
      {#if parsed}
        <div class="card meta">
          <div class="row"><span class="lbl">Judul</span><strong>{parsed.metadata.title}</strong></div>
          <div class="row"><span class="lbl">Requirement</span><span>{parsed.requirements.length}</span></div>
          <div class="row"><span class="lbl">Tech Lead</span><span>{parsed.metadata.techLead || '-'}</span></div>
          <label class="field-sm"><span>Author TAD</span><input class="input" bind:value={customAuthor} placeholder={parsed.metadata.techLead || '@TechLead'} /></label>
          <label class="field-sm"><span>Code Name</span><input class="input mono" bind:value={customCodeName} placeholder={parsed.metadata.codeName || 'CODE-NAME'} /></label>
        </div>
      {:else}
        <div class="card empty muted small"><Icon name="doc" size={24} /> Tempel atau upload PRD untuk melihat ringkasannya.</div>
      {/if}

      <div class="card">
        <h3>Codebase yang dianalisa</h3>
        <input class="input mono small" bind:value={servicesRoot} aria-label="Folder codebase" />
        {#if checkingServices}
          <p class="hint muted">Memeriksa folder…</p>
        {:else if services?.exists}
          <p class="hint ok"><Icon name="check" size={12} /> {services.services.length} service ditemukan. AI hanya membaca, tidak mengubah.</p>
        {:else if services}
          <p class="hint warn">{services.error}</p>
        {/if}
      </div>

      <div class="card">
        <h3>AI</h3>
        <AiPicker value={ai} onchange={setAi} />
        {#if needsAgyGrant}
          <div class="grant">
            <p class="hint">Antigravity CLI perlu izin membaca folder codebase. Aplikasi akan menambahkan <code>read_file</code> (izin baca) dan <code>deny write_file</code> untuk folder ini ke <code>{services?.antigravity.settingsFile}</code>.</p>
            <button class="btn btn-sm" onclick={grant} disabled={granting}>{granting ? 'Menyimpan…' : 'Izinkan baca codebase'}</button>
          </div>
        {/if}
        <fieldset class="start" disabled={!services?.exists}>
          <legend>Setelah draft dibuat</legend>
          <label class="check"><input type="radio" bind:group={start} value="brainstorm" /> <span><strong>Brainstorm scope dulu</strong> (disarankan): AI menyusun rencana scope ringkas untuk didiskusikan sebelum TAD ditulis.</span></label>
          <label class="check"><input type="radio" bind:group={start} value="generate" /> <span>Langsung generate TAD lengkap</span></label>
          <label class="check"><input type="radio" bind:group={start} value="none" /> <span>Jangan jalankan AI dulu</span></label>
        </fieldset>
      </div>
    </aside>
  </div>

  {#snippet footer()}
    <button class="btn btn-ghost" onclick={blank}>Template kosong</button>
    <span style="flex:1"></span>
    <button class="btn" onclick={() => (open = false)}>Batal</button>
    <button class="btn btn-primary" onclick={generate} disabled={!parsed || !parsed.metadata.title.trim()}>
      <Icon name="sparkles" /> {!services?.exists || start === 'none' ? 'Buat draft' : start === 'brainstorm' ? 'Buat draft & brainstorm' : 'Buat draft & generate'}
    </button>
  {/snippet}
</Modal>

<style>
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: 16px;
  }
  @media (max-width: 800px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  .left,
  .right {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .block-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--text-2);
  }
  .block-head h3 {
    flex: 1;
  }
  .file-btn {
    position: relative;
    overflow: hidden;
  }
  .file-btn input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: 12.5px;
  }
  .list a,
  .list .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inline {
    display: flex;
    gap: 6px;
  }
  .hint {
    margin: 0;
    font-size: 12px;
    display: flex;
    gap: 4px;
    align-items: flex-start;
  }
  .hint.ok {
    color: var(--ok);
  }
  .hint.warn {
    color: var(--warn);
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-2);
  }
  .card.empty {
    align-items: center;
    text-align: center;
    padding: 20px 12px;
  }
  .meta .row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 12.5px;
  }
  .lbl {
    color: var(--text-3);
  }
  .field-sm {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
    color: var(--text-2);
  }
  .field-sm .input {
    min-height: 30px;
    padding: 4px 8px;
  }
  .small {
    font-size: 12px;
  }
  .grant {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
  }
  .grant code {
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .grant .btn {
    align-self: flex-start;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 12.5px;
  }
  .check input {
    margin-top: 3px;
  }
  .start {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .start legend {
    padding: 0;
    margin-bottom: 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }
  .confluence-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    color: var(--text-3);
  }
  .confluence-row input {
    flex: 1;
    min-width: 0;
  }
  .ok-hint {
    color: var(--ok);
  }
</style>
