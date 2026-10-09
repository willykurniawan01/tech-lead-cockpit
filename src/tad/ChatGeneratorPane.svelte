<script lang="ts">
  import { untrack } from 'svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import AiUsageMeter from '../components/AiUsageMeter.svelte';
  import { aiUsage } from '../lib/ai/usage.svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { toasts } from '../components/toast.svelte';
  import { aiProviders, loadAiSelection, saveAiSelection } from '../lib/ai/providers.svelte';
  import type { AiSelection } from '../lib/ai/types';
  import type { GeneratorJob } from '../lib/generator/types';
  import { api } from '../lib/api-base';
  import { renderPreview } from '../lib/markdown/preview';
  import { drafts, type Draft } from './drafts.svelte';
  import { ANALYSIS_PROMPT, BRAINSTORM_PROMPT, deleteDoc, fetchServicesInfo, grantAntigravityRead, servicesRootFor, startGeneratorJob, uploadDoc, withPdfPassword, type ServicesInfo } from './generator-client';

  let {
    draft,
    open = $bindable(false),
    onopenrevisions,
    onreview,
    mode = $bindable('edit'),
    onscope,
    onapprovescope,
    prefill = $bindable(''),
  }: {
    draft: Draft;
    open: boolean;
    onopenrevisions: () => void;
    /** Opens the review dialog for the draft's pending AI proposal. */
    onreview: () => void;
    /** brainstorm: discuss and update the scope plan only; edit: change the TAD. */
    mode?: 'brainstorm' | 'edit';
    /** Shows the scope plan in the main area. */
    onscope: () => void;
    onapprovescope: () => void;
    /** Instruction put in the input box by another part of the workspace; the user still sends it. */
    prefill?: string;
  } = $props();

  const POLL_MS = 1500;
  const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };

  const REVIEW_KEY = 'tlc.tad.reviewMode';
  function loadReviewMode(): boolean {
    try {
      return localStorage.getItem(REVIEW_KEY) !== 'off';
    } catch {
      return true;
    }
  }
  let reviewMode = $state(loadReviewMode());
  function setReviewMode(on: boolean) {
    reviewMode = on;
    try {
      localStorage.setItem(REVIEW_KEY, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
  }

  let inputPrompt = $state('');

  $effect(() => {
    if (!prefill) return;
    inputPrompt = prefill;
    mode = 'edit';
    prefill = '';
  });
  let ai = $state<AiSelection>(loadAiSelection('generator'));
  let job = $state<GeneratorJob | null>(null);
  let starting = $state(false);
  let now = $state(Date.now());
  let chatBoxEl: HTMLDivElement | undefined = $state();
  let isWide = $state(false);

  const running = $derived(starting || job?.status === 'running');
  const pendingProposal = $derived(draft.proposal);
  const elapsed = $derived(job ? Math.max(0, Math.round((now - Date.parse(job.startedAt)) / 1000)) : 0);
  const recentEvents = $derived(job?.events.slice(-6) ?? []);

  const brainstormSuggestions = [
    { label: 'Susun rencana scope', prompt: BRAINSTORM_PROMPT },
    { label: 'Keluarkan mobile dari scope', prompt: 'Task mobile (MOBILE-FE) di luar scope TAD ini. Hapus dari usulan task dan catat di bagian Di Luar Scope.' },
    { label: 'Tanpa service baru', prompt: 'Jangan membuat service baru. Tempatkan semua perubahan di service existing yang paling sesuai, jelaskan alasannya.' },
    { label: 'Jelaskan pertanyaan terbuka', prompt: 'Jelaskan pertanyaan terbuka di SCOPE.md satu per satu beserta dampaknya bila dijawab ya/tidak.' },
  ];
  const editSuggestions = [
    { label: 'Analisa codebase & susun scope', prompt: ANALYSIS_PROMPT },
    { label: 'Validasi coverage requirement PRD', prompt: 'Periksa apakah setiap requirement PRD sudah tercakup task di Development Scope. Tambahkan task yang kurang beserta Detail Task-nya.' },
    { label: 'Lengkapi Detail Task yang masih TODO', prompt: 'Lengkapi semua Detail Task yang masih berisi TODO, dengan merujuk pola di codebase Services.' },
    { label: 'Tambahkan Deployment Notes & Rollback', prompt: 'Tambahkan section # Deployment Notes dan ## Rollback (urutan deploy per service, migration, verifikasi, langkah rollback) berdasarkan task di Development Scope.' },
  ];
  const refineSuggestions = [
    { label: 'Lengkapi Detail Task TODO', prompt: 'Lengkapi semua Detail Task yang masih berisi TODO atau belum lengkap pada usulan sebelumnya.' },
    { label: 'Tambahkan error response 4xx & 5xx', prompt: 'Tambahkan format response error (4xx & 5xx) dan validasi field pada setiap endpoint API yang diusulkan.' },
    { label: 'Perjelas skema JSON payload', prompt: 'Perjelas skema JSON payload request dan response secara mendetail di tabel Detail Task.' },
    { label: 'Sederhanakan rancangan arsitektur', prompt: 'Sederhanakan arsitektur dan diagram Mermaid agar lebih modular dan mudah diimplementasi.' },
  ];
  const suggestions = $derived(
    pendingProposal ? refineSuggestions : mode === 'brainstorm' ? brainstormSuggestions : editSuggestions
  );

  // The codebase the AI reads (read-only): shown so it is clear what brainstorm/generate can trace.
  // Antigravity can only read it after the user grants it once.
  let services = $state<ServicesInfo | null>(null);
  let granting = $state(false);
  let editingRoot = $state(false);
  let rootInput = $state('');
  const servicesRoot = $derived(servicesRootFor(draft));
  const needsAgyGrant = $derived(ai.provider === 'antigravity' && services?.exists === true && !services.antigravity.granted);
  $effect(() => {
    const root = servicesRoot;
    services = null;
    fetchServicesInfo(root)
      .then((info) => {
        if (root === servicesRoot) services = info;
      })
      .catch(() => {});
  });

  function editRoot() {
    rootInput = servicesRoot;
    editingRoot = true;
  }

  function saveRoot() {
    const root = rootInput.trim();
    drafts.update(draft.id, { servicesRoot: root || undefined });
    drafts.saveNow();
    editingRoot = false;
  }

  // The settings block (AI, limits, hints, codebase) folds into one line once the chat has
  // messages, so it never squeezes the conversation out of view.
  let settingsOpen = $state(false);
  $effect(() => {
    void draft.id;
    settingsOpen = untrack(() => draft.chatHistory.length === 0);
  });
  const usageMax = $derived(Math.max(0, ...(aiUsage.get(ai.provider)?.windows ?? []).map((w) => w.usedPercent)));
  const providerLabel = $derived(aiProviders.get(ai.provider)?.label ?? ai.provider);

  async function grant() {
    if (!services?.exists) return;
    granting = true;
    try {
      services = { ...services, antigravity: await grantAntigravityRead(services.root) };
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      granting = false;
    }
  }

  function setAi(sel: AiSelection) {
    ai = sel;
    saveAiSelection('generator', sel);
  }

  // Follow new messages and agent progress, unless the user scrolled up to read; jump down on draft switch.
  let stickToBottom = true;
  let lastDraftId = '';
  function onChatScroll() {
    if (!chatBoxEl) return;
    stickToBottom = chatBoxEl.scrollHeight - chatBoxEl.scrollTop - chatBoxEl.clientHeight < 80;
  }
  $effect(() => {
    void draft.chatHistory.length;
    void job?.events.length;
    if (draft.id !== lastDraftId) {
      lastDraftId = draft.id;
      stickToBottom = true;
    }
    if (chatBoxEl && stickToBottom) chatBoxEl.scrollTop = chatBoxEl.scrollHeight;
  });

  // Resume a job started before a reload or while another draft was selected.
  $effect(() => {
    const pending = draft.pendingJobId;
    const draftId = draft.id;
    job = null;
    if (!pending) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      await poll(draftId, pending);
      if (!stop && drafts.drafts.find((d) => d.id === draftId)?.pendingJobId === pending) setTimeout(tick, POLL_MS);
    };
    tick();
    const clock = setInterval(() => (now = Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(clock);
    };
  });

  async function poll(draftId: string, jobId: string) {
    let res: Response;
    try {
      res = await fetch(api(`/api/connector/chat/jobs?id=${encodeURIComponent(jobId)}`), { headers: HEADERS });
    } catch {
      return; // connector restarting; try again on the next tick
    }
    if (res.status === 404) {
      drafts.update(draftId, { pendingJobId: undefined });
      drafts.addChatMessage(draftId, { sender: 'assistant', text: 'Job AI tidak ditemukan lagi (connector di-restart penuh). Silakan kirim ulang instruksinya.', isError: true });
      return;
    }
    if (!res.ok) return;
    const latest = (await res.json()) as GeneratorJob;
    if (draftId === draft.id) {
      job = latest;
      // After a reload, show the mode of the job that is actually running.
      if (latest.status === 'running' && latest.kind) mode = latest.kind;
    }
    if (latest.status !== 'running') finish(draftId, latest);
  }

  function finish(draftId: string, finished: GeneratorJob) {
    const r = finished.result;
    void aiUsage.load(true);
    const sessions = { ...(drafts.drafts.find((d) => d.id === draftId)?.aiSessions ?? {}) };
    if (finished.status === 'error' || r?.error) {
      delete sessions[finished.ai.provider];
    } else if (r?.sessionId) {
      sessions[finished.ai.provider] = r.sessionId;
    }
    drafts.update(draftId, {
      pendingJobId: undefined,
      aiSessions: sessions,
    });
    const who = finished.ai.provider === 'claude' ? 'Claude CLI' : finished.ai.provider === 'antigravity' ? 'Antigravity CLI' : finished.ai.provider === '9router' ? '9Router' : 'InferHub';
    if (finished.status === 'cancelled') {
      drafts.addChatMessage(draftId, { sender: 'system', text: 'Proses AI dibatalkan. TAD tidak diubah.' });
      return;
    }
    if (finished.kind === 'brainstorm' && r?.scopeChanged && r.updatedScopeMarkdown) {
      // The scope plan is a discussion document: updates land directly, the TAD stays untouched.
      drafts.update(draftId, { scopePlan: r.updatedScopeMarkdown, scopeStatus: 'draft' });
      drafts.addChatMessage(draftId, {
        sender: 'assistant',
        text: `${r.partial ? `${who} berhenti sebelum selesai: ${r.error}\n\n` : ''}${r.reply || 'Rencana scope diperbarui.'}`,
        isError: r.partial,
      });
      toasts.show('Rencana scope diperbarui.', 'ok', 3000);
      if (draftId === draft.id) onscope();
      return;
    }
    if (finished.status === 'error' && r?.partial && r.updatedTadMarkdown) {
      deliver(draftId, finished, r.updatedTadMarkdown, r.baseTadMarkdown, `${who} berhenti sebelum selesai: ${r.error}\n\nPerubahan yang sudah dibuat tetap disimpan. Periksa bagian akhir TAD, lalu minta AI melanjutkan bila perlu.`, true);
      return;
    }
    if (finished.status === 'error' || !r) {
      drafts.addChatMessage(draftId, { sender: 'assistant', text: `${who}: ${r?.error ?? 'gagal tanpa keterangan.'}`, isError: true });
      toasts.show('Generator gagal. Lihat pesan di panel chat.', 'err');
      return;
    }
    if (r.changed && r.updatedTadMarkdown) {
      deliver(draftId, finished, r.updatedTadMarkdown, r.baseTadMarkdown, r.reply || 'TAD.md diperbarui.', false);
      return;
    }
    drafts.addChatMessage(draftId, { sender: 'assistant', text: r.reply || '(AI tidak memberi balasan teks.)' });
  }

  /** In review mode the edit becomes a proposal; otherwise it is applied right away as a revision. */
  function deliver(draftId: string, finished: GeneratorJob, proposed: string, base: string | undefined, text: string, partial: boolean) {
    const d = drafts.drafts.find((x) => x.id === draftId);
    if (!d) return;
    if (reviewMode) {
      const existingProposal = d.proposal;
      const proposal = drafts.setProposal(draftId, {
        provider: finished.ai.provider,
        prompt: finished.prompt,
        reply: text,
        base: existingProposal?.base ?? base ?? d.markdown,
        proposed,
        partial,
      });
      drafts.addChatMessage(draftId, { sender: 'assistant', text: `${text}\n\nUsulan perubahan menunggu review sebelum masuk ke TAD.`, isError: partial, proposalId: proposal?.id });
      toasts.show('Usulan AI siap direview.', 'info', 4000);
      if (draftId === draft.id) onreview();
      return;
    }
    const who = finished.ai.provider === 'claude' ? 'Claude' : finished.ai.provider === 'antigravity' ? 'Antigravity' : finished.ai.provider === '9router' ? '9Router' : 'InferHub';
    const revisionId = drafts.applyRevision(draftId, proposed, `AI (${who}${partial ? ', sebagian' : ''}): ${finished.prompt.slice(0, 40)}`)?.id;
    drafts.addChatMessage(draftId, { sender: 'assistant', text, isError: partial, revisionId });
    toasts.show(partial ? 'AI berhenti sebelum selesai; hasil sebagian diterapkan.' : 'TAD diperbarui oleh AI.', partial ? 'info' : 'ok', 4000);
  }

  // Attachments --------------------------------------------------------------------------
  // Files go to the draft's docs/ (the folder the AI reads, same as "Figma & Dokumen"); the next
  // message names them so the AI treats them as the main context of that instruction.

  const ACCEPT = '.pdf,.md,.markdown,.txt,.json,.yaml,.yml,.csv,.png,.jpg,.jpeg,.webp,.html,.htm,.xml,.proto,.graphql,.sql';
  const MAX_ATTACH_MB = 20;
  let attachments = $state<string[]>([]);
  let attaching = $state(0);
  let dragOver = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  /** Local previews of image attachments (name → object URL), so a pasted screenshot can be checked before sending. */
  let previews = $state<Record<string, string>>({});
  let previewOpen = $state(false);
  let previewName = $state('');

  function dropPreview(name: string) {
    if (previews[name]) URL.revokeObjectURL(previews[name]);
    delete previews[name];
  }
  function openPreview(name: string) {
    previewName = name;
    previewOpen = true;
  }
  $effect(() => () => Object.values(previews).forEach((u) => URL.revokeObjectURL(u)));

  /** The name the connector stores a file under (same rule as workspace-docs safeDocName). */
  const storedDocName = (name: string) =>
    (name.split(/[\\/]/).pop() ?? '')
      .replace(/[^\w.\- ()&]+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120)
      .trim();

  async function attach(files: File[]) {
    for (const f of files) {
      if (f.size > MAX_ATTACH_MB * 1024 * 1024) {
        toasts.show(`${f.name} melebihi ${MAX_ATTACH_MB} MB.`, 'err');
        continue;
      }
      attaching++;
      try {
        const docs = await withPdfPassword(f.name, (password) => uploadDoc(draft.id, f, password));
        if (!docs) continue;
        drafts.update(draft.id, { supportingDocs: docs });
        const saved = storedDocName(f.name);
        const added = docs.find((d) => d.name === saved)?.name ?? saved;
        if (!attachments.includes(added)) attachments = [...attachments, added];
        if (f.type.startsWith('image/')) {
          dropPreview(added);
          previews[added] = URL.createObjectURL(f);
        }
      } catch (e) {
        toasts.show(`${f.name}: ${(e as Error).message}`, 'err', 6000);
      } finally {
        attaching--;
      }
    }
  }

  function pickFiles(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    void attach(files);
  }

  /** Screenshots pasted into the input are attached as images. */
  function onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    void attach(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${stamp}${i ? `-${i}` : ''}.${f.type.split('/')[1] || 'png'}`, { type: f.type }))));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (running) return;
    void attach(Array.from(e.dataTransfer?.files ?? []));
  }

  /** Removing a chip before sending also removes the uploaded file. */
  async function removeAttachment(name: string) {
    attachments = attachments.filter((a) => a !== name);
    dropPreview(name);
    if (previewName === name) previewOpen = false;
    try {
      drafts.update(draft.id, { supportingDocs: await deleteDoc(draft.id, name) });
    } catch {
      /* keep it in docs/; it is harmless */
    }
  }

  async function send() {
    const typed = inputPrompt.trim();
    if ((!typed && !attachments.length) || running || attaching) return;
    const sent = attachments;
    const text = typed || 'Baca lampiran berikut dan gunakan sebagai konteks.';
    inputPrompt = '';
    attachments = [];
    sent.forEach(dropPreview);
    previewOpen = false;
    starting = true;
    const isRefining = Boolean(pendingProposal);
    const withFiles = sent.length
      ? `${text}\n\nLampiran untuk instruksi ini (sudah ada di folder docs/): ${sent.map((n) => `docs/${n}`).join(', ')}. Baca file-file ini lebih dulu dan jadikan konteks utama instruksi di atas.`
      : text;
    const promptToSend = isRefining ? `Revisi / Refine usulan sebelumnya: ${withFiles}` : withFiles;
    const workingMarkdown = isRefining && pendingProposal ? pendingProposal.proposed : undefined;
    const shown = sent.length ? `${text}\n\n${sent.map((n) => `📎 ${n}`).join('\n')}` : text;
    drafts.addChatMessage(draft.id, {
      sender: 'user',
      text: isRefining ? `[Refine Usulan AI] ${shown}` : shown,
    });
    try {
      const { job: started, alreadyRunning } = await startGeneratorJob(
        draft,
        promptToSend,
        ai,
        mode,
        workingMarkdown,
      );
      if (alreadyRunning) toasts.show('AI masih mengerjakan instruksi sebelumnya untuk draft ini.', 'info');
      job = started;
      drafts.update(draft.id, { pendingJobId: started.id });
      drafts.saveNow();
    } catch (err) {
      drafts.addChatMessage(draft.id, { sender: 'assistant', text: `Gagal menjalankan generator: ${(err as Error).message}`, isError: true });
      toasts.show('Gagal memulai generator', 'err');
    } finally {
      starting = false;
    }
  }

  async function cancel() {
    if (!job) return;
    await fetch(api('/api/connector/chat/jobs/cancel'), { method: 'POST', headers: HEADERS, body: JSON.stringify({ id: job.id }) }).catch(() => {});
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function fmtElapsed(sec: number): string {
    const m = Math.floor(sec / 60);
    return m ? `${m}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
  }
</script>

{#if open}
  <aside
    class="chat-pane"
    class:wide={isWide}
    class:drag-over={dragOver}
    ondragover={(e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        dragOver = true;
      }
    }}
    ondragleave={(e) => {
      if (e.currentTarget === e.target) dragOver = false;
    }}
    ondrop={onDrop}
  >
    <header class="header">
      <div class="title-block">
        <h3><Icon name="sparkles" size={15} /> Generator Chat AI</h3>
        <small class="muted">Mengedit TAD.md di folder kerja draft</small>
      </div>
      <div class="header-actions">
        <button
          class="btn btn-sm btn-ghost toggle-wide-btn"
          onclick={() => (isWide = !isWide)}
          title={isWide ? "Kembali ke ukuran standar (380px)" : "Perlebar panel chat (620px) untuk membaca tabel dengan leluasa"}
          aria-label={isWide ? "Ukuran standar" : "Perlebar panel"}
        >
          <Icon name={isWide ? 'minimize' : 'maximize'} size={13} />
          <span>{isWide ? 'Standar' : 'Lebar'}</span>
        </button>
        <button class="btn btn-sm btn-ghost" onclick={onopenrevisions} title="Riwayat revisi & rollback">
          <Icon name="history" size={14} /> Revisi ({draft.revisions.length})
        </button>
        <button class="btn btn-sm btn-ghost icon-only" onclick={() => (open = false)} title="Tutup chat">✕</button>
      </div>
    </header>

    <div class="ai-row">
      <div class="ai-summary">
        <div class="mode" role="group" aria-label="Mode chat">
          <button class:active={mode === 'brainstorm'} aria-pressed={mode === 'brainstorm'} onclick={() => (mode = 'brainstorm')} disabled={running} title="Diskusi rencana scope, TAD tidak diubah">Brainstorm scope</button>
          <button class:active={mode === 'edit'} aria-pressed={mode === 'edit'} onclick={() => (mode = 'edit')} disabled={running} title="Mengedit TAD">Edit TAD</button>
        </div>
        <button class="settings-toggle" onclick={() => (settingsOpen = !settingsOpen)} aria-expanded={settingsOpen} title={settingsOpen ? 'Sembunyikan pengaturan AI' : 'Pengaturan AI, limit, review, dan codebase'}>
          <Icon name="sparkles" size={12} />
          <span class="sum-text">{providerLabel}{ai.model ? ` · ${ai.model}` : ''}</span>
          {#if usageMax > 0}<span class="sum-limit" class:warn={usageMax >= 70} class:err={usageMax >= 90}>limit {usageMax}%</span>{/if}
          {#if services && !services.exists}<span class="sum-limit err">codebase ✗</span>{/if}
          <span class="caret">{settingsOpen ? '▴' : '▾'}</span>
        </button>
      </div>
      {#if settingsOpen}
        <div class="ai-settings">
          <AiPicker value={ai} onchange={setAi} disabled={running} />
          <div class="usage-row"><AiUsageMeter provider={ai.provider} compact /></div>
          {#if draft.confluence?.pageId}
            <p class="mode-hint existing" title="Draft tertaut ke halaman Confluence">
              <strong>Melanjutkan TAD existing.</strong>
              {mode === 'brainstorm'
                ? 'Scope saat ini diambil dari Development Scope; AI hanya menganalisa perubahan baru.'
                : 'AI hanya mengubah bagian yang diminta, mengikuti format tabel task yang ada, tanpa scan ulang seluruh codebase.'}
            </p>
          {/if}
          <label class="review-toggle" title="Perubahan AI ditinjau dulu sebelum masuk ke TAD">
            <input type="checkbox" checked={reviewMode} onchange={(e) => setReviewMode(e.currentTarget.checked)} />
            Review dulu sebelum diterapkan
          </label>
          <div class="codebase" class:missing={services && !services.exists}>
            {#if editingRoot}
              <input class="input mono small" bind:value={rootInput} placeholder="~/Code/Services" title="Satu folder berisi semua repo service (satu subfolder per repo); AI hanya memindai repo di folder ini" aria-label="Folder codebase" onkeydown={(e) => e.key === 'Enter' && saveRoot()} />
              <button class="btn btn-sm" onclick={saveRoot}>Simpan</button>
              <button class="btn btn-sm btn-ghost" onclick={() => (editingRoot = false)}>Batal</button>
            {:else}
              <span title="AI boleh membaca folder ini (hanya baca) untuk menelusuri service yang terdampak">
                Codebase: <code>{servicesRoot}</code>
                {#if services?.exists}· {services.services.length} service{:else if services}· <strong>tidak ditemukan</strong>: AI tidak bisa menganalisa repo{/if}
                {#if !draft.servicesRoot}<span class="muted">(default)</span>{/if}
              </span>
              <button class="link-btn" onclick={editRoot} disabled={running}>Ubah</button>
            {/if}
          </div>
        </div>
      {/if}
      {#if mode === 'brainstorm'}
        <p class="mode-hint">AI hanya memperbarui <button class="link-btn" onclick={onscope}>Rencana Scope</button>, TAD tidak diubah.{#if draft.scopePlan && draft.scopeStatus !== 'agreed'} Sudah sesuai? <button class="link-btn" onclick={onapprovescope} disabled={running}>Setujui & generate TAD</button>{/if}</p>
      {/if}
      {#if needsAgyGrant}
        <div class="grant">
          <span>Antigravity belum boleh membaca codebase <code>{services?.root}</code>.</span>
          <button class="btn btn-sm" onclick={grant} disabled={granting}>{granting ? 'Menyimpan…' : 'Izinkan baca codebase'}</button>
        </div>
      {/if}
    </div>

    <div class="messages" bind:this={chatBoxEl} onscroll={onChatScroll}>
      {#if draft.chatHistory.length === 0}
        <div class="empty">
          <p class="muted">Kirim instruksi untuk meminta AI mengedit TAD.md berdasarkan PRD.md di folder kerja lokal.</p>
        </div>
      {/if}

      {#each draft.chatHistory as msg (msg.id)}
        <div class="msg {msg.sender} {msg.isError ? 'msg-error' : ''}">
          <div class="msg-bubble">
            {#if msg.sender === 'user'}
              <div class="msg-content user-content">{msg.text}</div>
            {:else}
              <div class="msg-content">
                {@html renderPreview(msg.text).html}
              </div>
            {/if}
            {#if msg.proposalId && pendingProposal?.id === msg.proposalId}
              <div class="rev-tag">
                <span>Menunggu review</span>
                <button class="link-btn" onclick={onreview}>Review usulan</button>
              </div>
            {/if}
            {#if msg.revisionId}
              <div class="rev-tag">
                <span>Dokumen diperbarui</span>
                <button class="link-btn" onclick={onopenrevisions}>Lihat diff / rollback</button>
              </div>
            {/if}
          </div>
          <span class="time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      {/each}


      {#if running}
        <div class="msg assistant progress-msg">
          <div class="msg-bubble progress">
            <div class="progress-head">
              <span class="dot"></span>
              <strong>{(job?.ai ?? ai).provider === 'claude' ? 'Claude CLI' : (job?.ai ?? ai).provider === 'antigravity' ? 'Antigravity CLI' : (job?.ai ?? ai).provider === '9router' ? '9Router' : 'InferHub'}</strong>
              {#if (job?.ai ?? ai).model}<span class="chip">{(job?.ai ?? ai).model}</span>{/if}
              <span class="muted elapsed">{fmtElapsed(elapsed)}</span>
            </div>
            <ul class="events">
              {#each recentEvents as ev, i (ev.at + ':' + i)}
                <li class="ev-{ev.kind}">
                  <Icon name={ev.kind === 'tool' ? 'edit' : ev.kind === 'tool-error' ? 'alert' : ev.kind === 'info' ? 'refresh' : 'sparkles'} size={12} />
                  <span>{ev.text}</span>
                </li>
              {:else}
                <li class="ev-info"><Icon name="refresh" size={12} /><span>Menyiapkan…</span></li>
              {/each}
            </ul>
            {#if elapsed > 90}
              <p class="muted hint">Instruksi besar (mis. memecah seluruh PRD) bisa memakan 5–15 menit. Kamu boleh pindah halaman; progres tetap berjalan.</p>
            {/if}
            {#if job}
              <button class="btn btn-sm cancel" onclick={cancel}>Batalkan</button>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <div class="footer">
      {#if pendingProposal}
        <div class="proposal-banner">
          <div class="proposal-banner-info">
            <span class="proposal-banner-title"><Icon name="sparkles" size={13} /> Usulan AI menunggu review</span>
            <span class="proposal-banner-sub">Review usulan atau ketik instruksi di bawah untuk me-refine hasil generate.</span>
          </div>
          <button class="btn btn-sm btn-primary" onclick={onreview}>Review</button>
        </div>
      {/if}
      <div class="suggestions">
        {#each suggestions as s}
          <button class="sug-pill" onclick={() => (inputPrompt = s.prompt)} disabled={running} title={s.prompt}>{s.label}</button>
        {/each}
      </div>

      {#if attachments.length || attaching}
        <div class="attachments" aria-label="Lampiran">
          {#each attachments as a (a)}
            {#if previews[a]}
              <span class="att-image" title="Tersimpan di docs/{a}">
                <button class="thumb" onclick={() => openPreview(a)} aria-label="Lihat gambar {a}">
                  <img src={previews[a]} alt={a} />
                </button>
                <button class="thumb-remove" onclick={() => removeAttachment(a)} aria-label="Hapus lampiran {a}" disabled={running}><Icon name="x" size={10} /></button>
              </span>
            {:else}
              <span class="att-chip mono" title="Tersimpan di docs/{a}">
                <Icon name="paperclip" size={11} /> {a}
                <button onclick={() => removeAttachment(a)} aria-label="Hapus lampiran {a}" disabled={running}><Icon name="x" size={10} /></button>
              </span>
            {/if}
          {/each}
          {#if attaching}<span class="att-chip muted">Mengunggah…</span>{/if}
        </div>
      {/if}
      <div class="input-row">
        <button class="btn btn-ghost attach-btn" onclick={() => fileInput?.click()} disabled={running} title="Lampirkan file (PDF, gambar, dokumen API, dll). Bisa juga paste screenshot atau drag & drop ke panel ini." aria-label="Lampirkan file">
          <Icon name="paperclip" size={16} />
        </button>
        <input bind:this={fileInput} type="file" multiple accept={ACCEPT} onchange={pickFiles} hidden />
        <textarea
          onpaste={onPaste}
          class="input mono"
          rows={2}
          bind:value={inputPrompt}
          onkeydown={handleKeydown}
          placeholder={pendingProposal ? "Ketik instruksi untuk me-refine usulan AI (Enter untuk kirim)..." : "Instruksikan AI untuk menambah task, update API, atau merevisi TAD... (Enter untuk kirim)"}
          disabled={running}
        ></textarea>
        <button class="btn btn-primary send-btn" onclick={send} disabled={(!inputPrompt.trim() && !attachments.length) || running || attaching > 0} title={pendingProposal ? 'Kirim instruksi refine ke AI' : 'Kirim instruksi ke AI'} aria-label="Kirim instruksi">
          <Icon name="sparkles" size={16} />
        </button>
      </div>
    </div>
  </aside>
{/if}

<Modal bind:open={previewOpen} title="Pratinjau lampiran" subtitle={previewName ? `docs/${previewName}` : undefined} width={960}>
  {#if previews[previewName]}
    <div class="image-preview"><img src={previews[previewName]} alt={previewName} /></div>
  {/if}
  {#snippet footer()}
    <button class="btn btn-danger" onclick={() => removeAttachment(previewName)} disabled={running}><Icon name="trash" size={13} /> Hapus lampiran</button>
    <button class="btn btn-primary" onclick={() => (previewOpen = false)}>Oke</button>
  {/snippet}
</Modal>

<style>
  .chat-pane {
    display: flex;
    flex-direction: column;
    width: 380px;
    height: 100%;
    border-left: 1px solid var(--border);
    background: var(--surface);
    min-height: 0;
    flex-shrink: 0;
    transition: width 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .chat-pane.wide {
    width: 620px;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }
  .title-block h3 {
    margin: 0;
    font-size: 13.5px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .toggle-wide-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11.5px;
    padding: 2px 7px;
    height: 26px;
  }
  .icon-only {
    padding: 4px 8px;
    font-size: 12px;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 160px;
  }
  .empty {
    text-align: center;
    padding: 30px 10px;
    font-size: 12.5px;
  }
  .msg {
    display: flex;
    flex-direction: column;
    max-width: 90%;
  }
  .msg.user {
    align-self: flex-end;
  }
  .msg.assistant,
  .msg.system {
    align-self: flex-start;
    max-width: 100%;
    width: 100%;
  }
  .msg-bubble {
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.5;
    word-break: normal;
    overflow-wrap: break-word;
    max-width: 100%;
    box-sizing: border-box;
  }
  .user .msg-bubble {
    background: var(--accent);
    color: #fff;
    border-bottom-right-radius: 2px;
  }
  .assistant .msg-bubble {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-bottom-left-radius: 2px;
  }
  .system .msg-bubble {
    background: var(--accent-soft);
    color: var(--text-2);
    font-size: 12px;
  }
  .msg-error .msg-bubble {
    background: var(--err-soft);
    border-color: var(--err);
    color: var(--err);
  }
  .user-content {
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* --- RICH MARKDOWN CONTENT IN CHAT --- */
  .msg-content {
    min-width: 0;
    max-width: 100%;
  }
  .msg-content :global(p) {
    margin: 0 0 8px;
    line-height: 1.55;
  }
  .msg-content :global(p:last-child) {
    margin-bottom: 0;
  }
  .msg-content :global(h1),
  .msg-content :global(h2),
  .msg-content :global(h3),
  .msg-content :global(h4) {
    margin: 12px 0 6px;
    font-weight: 600;
    color: var(--text);
    line-height: 1.35;
  }
  .msg-content :global(h1:first-child),
  .msg-content :global(h2:first-child),
  .msg-content :global(h3:first-child),
  .msg-content :global(h4:first-child) {
    margin-top: 0;
  }
  .msg-content :global(h1) { font-size: 15px; }
  .msg-content :global(h2) { font-size: 14px; }
  .msg-content :global(h3) { font-size: 13.5px; }
  .msg-content :global(h4) { font-size: 13px; }

  .msg-content :global(ul),
  .msg-content :global(ol) {
    margin: 4px 0 8px;
    padding-left: 20px;
  }
  .msg-content :global(li) {
    margin: 2px 0;
    line-height: 1.5;
  }

  .msg-content :global(code) {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1.5px 5px;
    border-radius: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--accent);
  }
  .user .msg-content :global(code) {
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.3);
    color: #fff;
  }
  .msg-content :global(pre) {
    margin: 8px 0;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.45;
  }
  .msg-content :global(pre code) {
    padding: 0;
    background: none;
    border: none;
    color: inherit;
  }
  .msg-content :global(.code-block) {
    position: relative;
    margin: 8px 0;
  }
  .msg-content :global(.code-block pre) {
    margin: 0;
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .msg-content :global(.code-lang) {
    position: absolute;
    top: 4px;
    right: 8px;
    font-size: 10px;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--text-3);
    pointer-events: none;
  }

  /* --- TABLE FORMATTING: Rapi, Bersih, Bergaris, dan Auto-Scroll --- */
  .msg-content :global(table) {
    border-collapse: separate;
    border-spacing: 0;
    margin: 10px 0;
    width: 100%;
    max-width: 100%;
    font-size: 12px;
    line-height: 1.45;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .msg-content :global(thead) {
    background: var(--surface-2);
  }
  .msg-content :global(th) {
    background: var(--surface-2);
    color: var(--text);
    font-weight: 600;
    font-size: 11.5px;
    padding: 8px 12px;
    text-align: left;
    vertical-align: middle;
    border-bottom: 2px solid var(--border-strong);
    border-right: 1px solid var(--border);
    white-space: nowrap;
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .msg-content :global(th:first-child) {
    border-top-left-radius: 7px;
  }
  .msg-content :global(th:last-child) {
    border-top-right-radius: 7px;
    border-right: 0;
  }
  .msg-content :global(td) {
    padding: 7px 12px;
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    vertical-align: top;
    color: var(--text);
    min-width: 90px;
  }
  .msg-content :global(td:last-child) {
    border-right: 0;
  }
  .msg-content :global(tr:last-child td) {
    border-bottom: 0;
  }
  .msg-content :global(tr:last-child td:first-child) {
    border-bottom-left-radius: 7px;
  }
  .msg-content :global(tr:last-child td:last-child) {
    border-bottom-right-radius: 7px;
  }
  .msg-content :global(tbody tr:nth-child(even)) {
    background: rgba(0, 0, 0, 0.02);
  }
  :root[data-theme='dark'] .msg-content :global(tbody tr:nth-child(even)) {
    background: rgba(255, 255, 255, 0.025);
  }
  .msg-content :global(tbody tr:hover) {
    background: var(--surface-hover);
  }
  .msg-content :global(td code) {
    font-size: 11px;
    padding: 1px 4px;
    background: var(--surface-2);
    word-break: break-all;
  }
  .msg-content :global(.lozenge) {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    line-height: 1.3;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .msg-content :global(.lozenge-green) { background: #e3fcef; color: #006644; }
  .msg-content :global(.lozenge-red) { background: #ffebe6; color: #bf2600; }
  .msg-content :global(.lozenge-yellow) { background: #fff0b3; color: #172b4d; }
  .msg-content :global(.lozenge-blue) { background: #deebff; color: #0747a6; }
  .msg-content :global(.lozenge-grey) { background: #f4f5f7; color: #42526e; }

  .msg-content :global(.callout) {
    margin: 8px 0;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12.5px;
    border-left: 3px solid var(--accent);
    background: var(--surface-2);
  }
  .msg-content :global(.callout-title) {
    font-weight: 600;
    margin-bottom: 4px;
    color: var(--text);
  }
  .time {
    font-size: 10px;
    color: var(--text-3);
    margin-top: 3px;
    align-self: flex-end;
  }
  .rev-tag {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
    font-size: 11.5px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .link-btn {
    background: none;
    border: 0;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    font-size: 11.5px;
    padding: 0;
  }
  .ai-row {
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    /* Never taller than ~45% of the pane: the conversation keeps its room. */
    max-height: 45%;
    overflow-y: auto;
    flex-shrink: 0;
  }
  .ai-summary {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ai-summary .mode {
    flex: 1;
    margin-top: 0;
  }
  .settings-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 55%;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .settings-toggle:hover {
    border-color: var(--accent);
  }
  .sum-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sum-limit {
    font-weight: 600;
    color: var(--ok);
  }
  .sum-limit.warn {
    color: var(--warn);
  }
  .sum-limit.err {
    color: var(--err);
  }
  .caret {
    opacity: 0.6;
  }
  .ai-settings {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
  }
  .usage-row {
    margin-top: 6px;
  }
  .mode {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    margin-top: 6px;
    padding: 2px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .mode button {
    height: 26px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-2);
    cursor: pointer;
    font-size: 12.5px;
    font-weight: 500;
  }
  .mode button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
  }
  .mode-hint {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--text-2);
  }
  .mode-hint.existing {
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
  }
  .codebase {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 11.5px;
    color: var(--text-2, var(--text));
  }
  .codebase code {
    font-size: 11px;
  }
  .codebase.missing {
    color: var(--err);
  }
  .codebase .input {
    flex: 1;
    min-width: 200px;
  }
  .review-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-2);
    cursor: pointer;
  }
  .proposal-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    font-size: 12.5px;
  }
  .proposal-banner-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .proposal-banner-title {
    display: flex;
    align-items: center;
    gap: 5px;
    font-weight: 600;
    font-size: 12px;
    color: var(--accent);
  }
  .proposal-banner-sub {
    font-size: 11px;
    color: var(--text-2);
    line-height: 1.35;
  }
  .grant {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 12px;
  }
  .grant span {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .grant code {
    font-size: 11px;
  }
  .progress-msg {
    max-width: 100%;
    width: 100%;
  }
  .progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .progress-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
  }
  .progress-head .chip {
    height: 18px;
    font-size: 11px;
  }
  .elapsed {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .events {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
    color: var(--text-2);
  }
  .events li {
    display: flex;
    gap: 6px;
    align-items: flex-start;
  }
  .events li :global(svg) {
    margin-top: 3px;
    color: var(--text-3);
  }
  .events li span {
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .ev-tool span {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .ev-tool-error {
    color: var(--err);
  }
  .hint {
    margin: 0;
    font-size: 11.5px;
  }
  .cancel {
    align-self: flex-start;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s infinite alternate;
  }
  @keyframes pulse {
    from {
      opacity: 0.3;
      transform: scale(0.8);
    }
    to {
      opacity: 1;
      transform: scale(1.2);
    }
  }
  .footer {
    padding: 10px;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-height: 68px;
    overflow-y: auto;
  }
  .sug-pill {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2px 8px;
    font-size: 11px;
    color: var(--text-2);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .sug-pill:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .input-row {
    display: flex;
    gap: 8px;
  }
  .input-row textarea {
    flex: 1;
    resize: none;
    font-size: 12.5px;
  }
  .send-btn {
    align-self: flex-end;
    height: 42px;
    padding: 0 14px;
  }
  .attach-btn {
    align-self: flex-end;
    height: 42px;
    padding: 0 10px;
  }
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .att-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-hover);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .att-chip button {
    display: inline-flex;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
  }
  .att-chip button:hover {
    opacity: 1;
  }
  .attachments {
    align-items: center;
  }
  .att-image {
    position: relative;
    display: inline-flex;
  }
  .thumb {
    display: block;
    width: 64px;
    height: 48px;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-hover);
    cursor: zoom-in;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .thumb:hover {
    border-color: var(--accent);
  }
  .thumb-remove {
    position: absolute;
    top: -6px;
    right: -6px;
    display: inline-flex;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-2);
    cursor: pointer;
  }
  .thumb-remove:hover:not(:disabled) {
    color: var(--err);
  }
  .image-preview {
    display: flex;
    justify-content: center;
    max-height: 70vh;
    overflow: auto;
    background: var(--bg);
    border-radius: 6px;
  }
  .image-preview img {
    max-width: 100%;
    height: auto;
    object-fit: contain;
  }
  .chat-pane.drag-over {
    outline: 2px dashed var(--accent);
    outline-offset: -6px;
  }
</style>
