<script lang="ts">
  import { appSettings } from '../lib/settings/store.svelte';
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { parseMermaid } from '../lib/markdown/mermaid';
  import { parsePrd } from '../lib/prd/parser';
  import { mergeIssues, validateMermaid, validateTad, type Issue, type SectionStatus } from '../lib/tad/validator';
  import { extractTadHeadings, type TadHeading } from '../lib/tad/headings';
  import ChatGeneratorPane from './ChatGeneratorPane.svelte';
  import DraftSidebar from './DraftSidebar.svelte';
  import ExportMenu from './ExportMenu.svelte';
  import IssuesPanel from './IssuesPanel.svelte';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import PreviewPane from './PreviewPane.svelte';
  import PrdImportDialog from './PrdImportDialog.svelte';
  import ConfluenceImportDialog from './ConfluenceImportDialog.svelte';
  import { ANALYSIS_PROMPT, BRAINSTORM_PROMPT, GENERATE_FROM_SCOPE_PROMPT, startGeneratorJob, uploadDoc, withPdfPassword, type PrdImportResult } from './generator-client';
  import PublishDialog from './PublishDialog.svelte';
  import RevisionHistoryModal from './RevisionHistoryModal.svelte';
  import ProposalReview from './ProposalReview.svelte';
  import ScopePlanPanel from './ScopePlanPanel.svelte';
  import TadProjectChip from './TadProjectChip.svelte';
  import ConfluenceSyncBanner from './ConfluenceSyncBanner.svelte';
  import JiraTicketsBanner from './JiraTicketsBanner.svelte';
  import PrdSync from './PrdSync.svelte';
  import DocsFigmaModal from './DocsFigmaModal.svelte';
  import { loadAiSelection } from '../lib/ai/providers.svelte';
  import { draftTitle, drafts } from './drafts.svelte';

  type Mode = 'edit' | 'split' | 'preview';
  const MODE_KEY = 'tlc.tad.viewMode';
  const SIDEBAR_KEY = 'tlc.tad.sidebarOpen';

  function savedMode(): Mode {
    try {
      const m = localStorage.getItem(MODE_KEY);
      return m === 'edit' || m === 'preview' ? m : 'split';
    } catch {
      return 'split';
    }
  }

  function savedSidebarOpen(): boolean {
    try {
      const s = localStorage.getItem(SIDEBAR_KEY);
      return s !== null ? s === 'true' : true;
    } catch {
      return true;
    }
  }

  let mode = $state<Mode>(savedMode());
  let sidebarOpen = $state(savedSidebarOpen());
  let isEditing = $state(false);

  function startEditing() {
    isEditing = true;
    if (mode === 'preview') {
      setMode('split');
    }
    toasts.show('Mode edit aktif. Klik "Selesai Edit" jika sudah selesai.', 'info', 2000);
  }

  function stopEditing() {
    isEditing = false;
    drafts.saveNow();
    toasts.show('Draft tersimpan di perangkat ini. Mode View Only aktif.', 'ok', 2000);
  }

  function toggleEditing() {
    if (isEditing) {
      stopEditing();
    } else {
      startEditing();
    }
  }

  function onWorkspaceKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
      const target = e.target as HTMLElement;
      if (target && target.tagName === 'INPUT') return;
      e.preventDefault();
      toggleEditing();
    }
  }

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen));
    } catch {
      /* ignore */
    }
  }
  let prdImportOpen = $state(false);
  let confluenceImportOpen = $state(false);
  let publishOpen = $state(false);
  let issuesOpen = $state(false);
  let chatOpen = $state(false);
  let revisionsOpen = $state(false);
  let reviewOpen = $state(false);
  let docsFigmaOpen = $state(false);
  /** Main area: the TAD itself, or the scope plan agreed during brainstorming. */
  let view = $state<'tad' | 'scope'>('tad');
  /** Instruction handed to the chat panel (e.g. after a PRD update); the user still sends it. */
  let chatPrefill = $state('');

  /** Chat pane mode; brainstorming only touches SCOPE.md. */
  let chatMode = $state<'brainstorm' | 'edit'>('edit');
  let editor: MarkdownEditor | undefined = $state();
  let preview: PreviewPane | undefined = $state();

  const draft = $derived(drafts.selected);
  const markdown = $derived(draft?.markdown ?? '');
  const prdMarkdown = $derived(draft?.prdMarkdown ?? '');
  const parsedPrd = $derived(prdMarkdown ? parsePrd(prdMarkdown) : undefined);
  const title = $derived(draft ? draftTitle(draft) : '');
  const baseValidation = $derived(validateTad(markdown, parsedPrd));

  // Mermaid parsing is async and loads the library, so it trails the sync checks.
  let mermaidIssues = $state<{ md: string; issues: Issue[] }>({ md: '', issues: [] });
  $effect(() => {
    const md = markdown;
    if (!md.includes('```mermaid')) {
      mermaidIssues = { md, issues: [] };
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const issues = await validateMermaid(md, parseMermaid);
      if (!cancelled) mermaidIssues = { md, issues };
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  });
  const validation = $derived(mergeIssues(baseValidation, mermaidIssues.md === markdown ? mermaidIssues.issues : []));
  const headings = $derived(extractTadHeadings(markdown));

  function setMode(m: Mode) {
    mode = m;
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  }

  function jumpToSection(s: SectionStatus) {
    if (s.line === undefined) return;
    if (mode !== 'preview') {
      editor?.scrollToSectionId(s.section.id);
    }
    if (mode !== 'edit') preview?.scrollToSection(s.section.id);
  }

  function jumpToHeading(h: TadHeading) {
    if (mode === 'preview') setMode('split');
    requestAnimationFrame(() => {
      editor?.scrollToHeading(h);
      if (mode !== 'edit' && h.sectionId) {
        preview?.scrollToSection(h.sectionId);
      }
    });
  }

  function jumpToIssue(issue: Issue) {
    if (mode === 'preview') setMode('split');
    // Wait a frame so the editor exists after a mode switch.
    requestAnimationFrame(() => editor?.scrollToLine(issue.line));
  }

  function onchange(value: string) {
    if (draft) drafts.update(draft.id, { markdown: value });
  }

  function save() {
    drafts.saveNow();
    toasts.show('Draft tersimpan di perangkat ini.', 'ok', 2000);
  }

  async function createFromPrd(r: PrdImportResult) {
    const prd = r.prdMarkdown ? parsePrd(r.prdMarkdown) : undefined;
    const source = { jiraKeys: [], figmaUrl: r.figmaLinks[0]?.url, prdTitle: prd?.metadata.title };
    const created = drafts.create(r.markdown, source, r.prdMarkdown, prd ? `Import PRD: ${prd.metadata.title}` : 'Draft Baru');
    drafts.update(created.id, { figmaLinks: r.figmaLinks, servicesRoot: r.servicesRoot, ...(r.prdSource ? { prdSource: r.prdSource } : {}) });

    const failed: string[] = [];
    let docs: { name: string; size: number; encrypted?: boolean }[] = [];
    for (const f of r.files) {
      try {
        const uploaded = await withPdfPassword(f.name, (password) => uploadDoc(created.id, f, password));
        if (uploaded) docs = uploaded;
        else failed.push(`${f.name} (password tidak diisi)`);
      } catch (e) {
        failed.push(`${f.name} (${(e as Error).message})`);
      }
    }
    drafts.update(created.id, { supportingDocs: docs });
    if (failed.length) toasts.show(`Gagal upload: ${failed.join(', ')}`, 'err', 8000);

    if (r.start === 'none') {
      toasts.show('Draft TAD dibuat. Buka Rencana Scope atau Chat AI untuk mulai.', 'ok');
      return;
    }
    const brainstorm = r.start === 'brainstorm';
    const draftNow = drafts.drafts.find((d) => d.id === created.id)!;
    try {
      const { job } = await startGeneratorJob(draftNow, brainstorm ? BRAINSTORM_PROMPT : ANALYSIS_PROMPT, r.ai, brainstorm ? 'brainstorm' : 'edit');
      drafts.addChatMessage(created.id, {
        sender: 'user',
        text: brainstorm
          ? 'Analisa PRD, Figma, dokumen pendukung, dan codebase Services, lalu susun rencana scope untuk didiskusikan.'
          : 'Analisa PRD, Figma, dokumen pendukung, dan codebase Services, lalu susun Development Analysis, Development Scope, dan Detail Task.',
      });
      drafts.update(created.id, { pendingJobId: job.id });
      chatMode = brainstorm ? 'brainstorm' : 'edit';
      view = brainstorm ? 'scope' : 'tad';
      chatOpen = true;
      toasts.show(brainstorm ? 'Draft dibuat. AI menyusun rencana scope (beberapa menit).' : 'Draft dibuat. AI mulai menganalisa codebase (bisa beberapa menit).', 'ok');
    } catch (e) {
      drafts.addChatMessage(created.id, { sender: 'assistant', text: `Gagal memulai AI: ${(e as Error).message}`, isError: true });
      chatOpen = true;
    }
  }

  function openBrainstorm() {
    chatMode = 'brainstorm';
    chatOpen = true;
  }

  async function approveScope() {
    if (!draft?.scopePlan?.trim()) return;
    const ok = await confirmDialog({
      title: 'Setujui Rencana Scope',
      message: 'Setujui rencana scope ini dan minta AI menulis TAD lengkap berdasarkan rencana tersebut?',
      confirmText: 'Setujui & Buat TAD',
    });
    if (!ok) return;
    drafts.update(draft.id, { scopeStatus: 'agreed' });
    drafts.addChatMessage(draft.id, { sender: 'user', text: 'Scope disetujui. Susun TAD lengkap sesuai rencana scope.' });
    const current = drafts.drafts.find((d) => d.id === draft.id)!;
    try {
      const { job, alreadyRunning } = await startGeneratorJob(current, GENERATE_FROM_SCOPE_PROMPT, loadAiSelection('generator'), 'edit');
      if (alreadyRunning) toasts.show('AI masih mengerjakan instruksi sebelumnya.', 'info');
      drafts.update(current.id, { pendingJobId: job.id });
      chatMode = 'edit';
      chatOpen = true;
      view = 'tad';
    } catch (e) {
      drafts.addChatMessage(current.id, { sender: 'assistant', text: `Gagal memulai generate TAD: ${(e as Error).message}`, isError: true });
      chatOpen = true;
    }
  }

  // New drafts without an agreed scope start in brainstorming; agreed ones go straight to editing.
  // Always reset isEditing to false (view-only mode) when draft changes.
  $effect(() => {
    void draft?.id;
    untrack(() => {
      isEditing = false;
      if (draft?.scopeStatus === 'agreed') chatMode = 'edit';
      else if (draft?.scopePlan) chatMode = 'brainstorm';
    });
  });
</script>

<svelte:window onkeydown={onWorkspaceKeyDown} />

<div class="ws" class:sidebar-collapsed={!sidebarOpen}>
  {#if sidebarOpen}
    <DraftSidebar
      sections={validation.sections}
      headings={headings}
      onnew={() => (prdImportOpen = true)}
      onimport={() => (confluenceImportOpen = true)}
      onjump={jumpToSection}
      onjumpheading={jumpToHeading}
      oncollapse={toggleSidebar}
    />
  {/if}

  {#if draft}
    <section class="main">
      <header class="toolbar">
        <div class="title-block">
          <div class="title-row">
            {#if !sidebarOpen}
              <button
                class="btn btn-ghost btn-sm sidebar-toggle-btn"
                onclick={toggleSidebar}
                title="Tampilkan daftar TAD"
                aria-label="Tampilkan daftar TAD"
              >
                <Icon name="sidebar" size={15} />
              </button>
            {/if}
            <h1 title={title}>{title}</h1>
          </div>
          <div class="meta">
            {#if draft.source?.prdTitle}
              <span class="chip chip-accent">PRD: {draft.source.prdTitle}</span>
            {/if}
            <TadProjectChip {draft} />
            <PrdSync
              {draft}
              onaskai={(prompt) => {
                chatPrefill = prompt;
                chatOpen = true;
              }}
            />
            <button
              type="button"
              class="chip chip-interactive"
              onclick={() => (docsFigmaOpen = true)}
              title="Kelola URL Figma dan Dokumen Partner/Pendukung"
            >
              <Icon name="paperclip" size={12} />
              <span>
                Figma & Dokumen
                {#if (draft.figmaLinks?.length || (draft.source?.figmaUrl ? 1 : 0)) || draft.supportingDocs?.length}
                  ({(draft.figmaLinks?.length || (draft.source?.figmaUrl ? 1 : 0)) + (draft.supportingDocs?.length ?? 0)})
                {/if}
              </span>
            </button>
            {#if draft.source?.figmaUrl}
              <a class="chip" href={draft.source.figmaUrl} target="_blank" rel="noreferrer" title="Buka desain Figma">
                <Icon name="external" size={11} /> Figma
              </a>
            {/if}
            {#if draft.confluence.pageId}
              <a class="chip {draft.confluence.status === 'draft' ? 'chip-accent' : 'chip-ok'}" href={draft.confluence.url || `${appSettings.value.confluence.baseUrl}/pages/viewpage.action?pageId=${draft.confluence.pageId}`} target="_blank" rel="noreferrer">
                <Icon name="confluence" size={12} /> Confluence v{draft.confluence.version} {#if draft.confluence.status === 'draft'}<span class="mono">(Draft)</span>{/if} {#if draft.confluence.spaceKey}({draft.confluence.spaceKey}){/if} <Icon name="external" size={11} />
              </a>
            {:else}
              <span class="chip">Draft Lokal</span>
            {/if}
            {#if draft.source?.jiraKeys?.length}
              <span class="chip chip-jira" title="Jira keys: {draft.source.jiraKeys.join(', ')}">
                <Icon name="jira" size={11} /> {draft.source.jiraKeys.join(', ')}
              </span>
            {/if}
            {#if draft.proposal}
              <button class="chip chip-warn proposal-chip" onclick={() => (reviewOpen = true)}><Icon name="sparkles" size={12} /> Usulan AI menunggu review</button>
            {/if}
            {#if !isEditing}
              <span class="chip chip-view-only" title="Mode View Only aktif — Dokumen terlindungi dari ketikan tidak sengaja">
                <Icon name="lock" size={11} /> View Only
              </span>
            {:else}
              <span class="chip chip-editing" title="Mode Edit aktif — Dokumen dapat diedit. Klik 'Selesai Edit' jika sudah selesai.">
                <Icon name="edit" size={11} /> Mode Edit
              </span>
            {/if}
          </div>
        </div>

        <div class="actions">
          <div class="segmented" role="group" aria-label="Isi">
            <button class:active={view === 'scope'} onclick={() => (view = 'scope')} aria-pressed={view === 'scope'} title="Rencana scope hasil brainstorming">
              <Icon name="list" size={15} /><span>Rencana Scope</span>{#if draft.scopePlan && draft.scopeStatus !== 'agreed'}<span class="dot-warn" aria-label="belum disetujui"></span>{/if}
            </button>
            <button class:active={view === 'tad'} onclick={() => (view = 'tad')} aria-pressed={view === 'tad'} title="Dokumen TAD"><Icon name="doc" size={15} /><span>TAD</span></button>
          </div>
          {#if view === 'tad'}
            {#if !isEditing}
              <button
                type="button"
                class="btn btn-sm btn-edit-tad"
                onclick={startEditing}
                title="Buka mode edit untuk mengubah isi TAD (Cmd+E)"
              >
                <Icon name="edit" size={14} />
                <span>Edit TAD</span>
              </button>
            {:else}
              <button
                type="button"
                class="btn btn-sm btn-done-edit"
                onclick={stopEditing}
                title="Selesai mengedit dan kunci kembali ke mode View Only (Cmd+E)"
              >
                <Icon name="check" size={14} />
                <span>Selesai Edit</span>
              </button>
            {/if}

            <div class="segmented" role="group" aria-label="Mode tampilan">
              <button class:active={mode === 'edit'} onclick={() => setMode('edit')} aria-pressed={mode === 'edit'} title="Editor Dokumen (Tampilan Word / Rich Text)"><Icon name="edit" size={15} /><span>Editor</span></button>
              <button class:active={mode === 'split'} onclick={() => setMode('split')} aria-pressed={mode === 'split'} title="Editor Dokumen + Preview Confluence"><Icon name="split" size={15} /><span>Split</span></button>
              <button class:active={mode === 'preview'} onclick={() => setMode('preview')} aria-pressed={mode === 'preview'} title="Pratinjau Confluence"><Icon name="eye" size={15} /><span>Preview</span></button>
            </div>
          {/if}

          <button class="btn btn-sm {chatOpen ? 'btn-primary' : ''} {draft.pendingJobId ? 'btn-pulsing' : ''}" onclick={() => (chatOpen = !chatOpen)} title="Buka Chat AI Generator (Claude CLI)">
            <Icon name="sparkles" size={14} />
            <span>Chat AI</span>
            {#if draft.pendingJobId}
              <span class="pulsing-dot" aria-label="AI sedang aktif"></span>
            {/if}
          </button>

          <button class="btn btn-sm" onclick={() => (revisionsOpen = true)} title="Riwayat revisi dan rollback">
            <Icon name="history" size={14} /> <span>Revisi ({draft.revisions.length})</span>
          </button>

          <ExportMenu {draft} {title} />

          <button class="btn btn-primary" onclick={() => (publishOpen = true)}>
            <Icon name="upload" /> {draft.confluence.pageId ? (draft.confluence.status === 'draft' ? 'Update / Publish Draft' : 'Update Confluence') : 'Publish'}
          </button>
        </div>
      </header>
      {#key draft.id}<ConfluenceSyncBanner {draft} /><JiraTicketsBanner {draft} />{/key}

      <div class="workspace-content">
        {#if view === 'scope'}
          <div class="panes">
            <ScopePlanPanel {draft} busy={Boolean(draft.pendingJobId)} onbrainstorm={openBrainstorm} onapprove={approveScope} />
          </div>
        {:else}
        <div class="panes mode-{mode}">
          {#if mode !== 'preview'}
            <div class="pane">
              {#key draft.id}
                <MarkdownEditor
                  bind:this={editor}
                  value={markdown}
                  readOnly={!isEditing}
                  {onchange}
                  onsave={save}
                  onrequestedit={startEditing}
                />
              {/key}
            </div>
          {/if}
          {#if mode !== 'edit'}
            <div class="pane">
              <PreviewPane bind:this={preview} {markdown} />
            </div>
          {/if}
        </div>
        {/if}

        {#if chatOpen}
          <ChatGeneratorPane {draft} bind:open={chatOpen} bind:mode={chatMode} bind:prefill={chatPrefill} onopenrevisions={() => (revisionsOpen = true)} onreview={() => (reviewOpen = true)} onscope={() => (view = 'scope')} onapprovescope={approveScope} />
        {/if}
      </div>

      <IssuesPanel result={validation} bind:open={issuesOpen} onjump={jumpToIssue} />
    </section>
  {:else}
    <section class="empty">
      {#if !sidebarOpen}
        <div class="empty-top-bar">
          <button
            class="btn btn-sm"
            onclick={toggleSidebar}
            title="Tampilkan daftar TAD"
          >
            <Icon name="sidebar" size={14} /> Buka Daftar TAD
          </button>
        </div>
      {/if}
      <div class="empty-card">
        <div class="empty-icon"><Icon name="doc" size={28} /></div>
        <h1>TAD Workspace</h1>
        <p class="muted">Susun Technical Architecture Document dari PRD dan Figma, gunakan Claude CLI untuk memecah task, validasi kelengkapannya, lalu publish rapi ke Confluence.</p>
        <ol class="steps">
          <li><strong>Import PRD</strong> — metadata, Objective, tabel Requirements, dan link Figma diekstrak otomatis.</li>
          <li><strong>Generator AI &amp; Editor</strong> — jalankan Claude CLI di folder kerja per TAD untuk mengedit TAD, dengan riwayat revisi dan tombol rollback.</li>
          <li><strong>Validasi</strong> — memastikan setiap task di Development Scope punya Detail Task, dan setiap requirement PRD tercakup.</li>
          <li><strong>Publish Confluence</strong> — format tadgen (tabel Document Info, tabel 2 kolom, Jira macro, code macro lebar).</li>
        </ol>
        <div class="empty-actions">
          <button class="btn btn-primary" onclick={() => (prdImportOpen = true)}><Icon name="sparkles" /> Import PRD &amp; Buat TAD</button>
          <button class="btn" onclick={() => (confluenceImportOpen = true)}><Icon name="confluence" /> Import dari Confluence</button>
        </div>
      </div>
    </section>
  {/if}
</div>

<PrdImportDialog bind:open={prdImportOpen} oncreate={createFromPrd} />
<ConfluenceImportDialog bind:open={confluenceImportOpen} />
{#if draft}
  <PublishDialog bind:open={publishOpen} {draft} validation={validation} />
  <RevisionHistoryModal bind:open={revisionsOpen} {draft} />
  <ProposalReview bind:open={reviewOpen} {draft} />
  <DocsFigmaModal bind:open={docsFigmaOpen} {draft} />
{/if}

<style>
  .chip-interactive {
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--surface);
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .chip-interactive:hover {
    background: var(--surface-hover);
    border-color: var(--border-strong);
  }
  .dot-warn {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
  }
  .proposal-chip {
    border: 0;
    cursor: pointer;
  }
  .ws {
    display: grid;
    grid-template-columns: 290px 1fr;
    height: 100%;
    min-height: 0;
    transition: grid-template-columns 0.15s ease;
  }
  .ws.sidebar-collapsed {
    grid-template-columns: 1fr;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .title-block {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .sidebar-toggle-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    padding: 0 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-2);
    background: var(--surface-2);
  }
  .sidebar-toggle-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .chip-jira {
    background: #0052cc15;
    color: #0052cc;
  }
  .chip-view-only {
    background: #f4f5f7;
    color: #42526e;
    border: 1px solid #dfe1e6;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 500;
  }
  .chip-editing {
    background: #deebff;
    color: #0747a6;
    border: 1px solid #b3d4ff;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
  }
  .btn-edit-tad {
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    color: var(--text);
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: all 0.15s ease;
  }
  .btn-edit-tad:hover {
    background: var(--surface-hover);
    border-color: var(--accent);
    color: var(--accent);
  }
  .btn-done-edit {
    background: #00875a;
    border: 1px solid #00875a;
    color: #fff;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    box-shadow: 0 1px 3px rgba(0, 135, 90, 0.3);
    transition: all 0.15s ease;
  }
  .btn-done-edit:hover {
    background: #006644;
    border-color: #006644;
  }
  .btn-pulsing {
    position: relative;
    border-color: var(--accent);
  }
  .pulsing-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 0 var(--accent);
    animation: pulse 1.5s infinite;
  }
  @keyframes pulse {
    0% {
      transform: scale(0.95);
      box-shadow: 0 0 0 0 rgba(47, 91, 234, 0.7);
    }
    70% {
      transform: scale(1);
      box-shadow: 0 0 0 6px rgba(47, 91, 234, 0);
    }
    100% {
      transform: scale(0.95);
      box-shadow: 0 0 0 0 rgba(47, 91, 234, 0);
    }
  }
  h1 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .meta a {
    text-decoration: none;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .segmented {
    display: inline-flex;
    padding: 2px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .segmented button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-2);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
  }
  .segmented button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
  }
  .workspace-content {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }
  .panes {
    flex: 1;
    min-height: 0;
    display: grid;
  }
  .panes.mode-split {
    grid-template-columns: 1fr 1fr;
  }
  .pane {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .mode-split .pane:first-child {
    border-right: 1px solid var(--border);
  }
  .empty {
    position: relative;
    display: grid;
    place-items: center;
    padding: 24px;
    overflow: auto;
  }
  .empty-top-bar {
    position: absolute;
    top: 14px;
    left: 14px;
  }
  .empty-card {
    max-width: 540px;
    text-align: center;
  }
  .empty-icon {
    display: inline-grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 14px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .empty h1 {
    font-size: 22px;
    margin: 14px 0 6px;
    white-space: normal;
  }
  .steps {
    text-align: left;
    margin: 20px 0 24px;
    padding-left: 22px;
    line-height: 1.8;
    color: var(--text-2);
  }
  .empty-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    flex-wrap: wrap;
  }

  @media (max-width: 1100px) {
    .ws {
      grid-template-columns: 220px 1fr;
    }
    .segmented span {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .ws {
      grid-template-columns: 1fr;
    }
    .ws > :global(aside) {
      display: none;
    }
    .panes.mode-split {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 1fr;
    }
  }
</style>
