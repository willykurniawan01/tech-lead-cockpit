<script lang="ts">
  import { appSettings } from '../lib/settings/store.svelte';
  import { untrack } from 'svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import AgentRunsPanel from '../coder/AgentRunsPanel.svelte';
  import { loadAiSelection } from '../lib/ai/providers.svelte';
  import type { AiSelection } from '../lib/ai/types';
  import { bugs } from '../lib/bugs/client';
  import { renderPreview } from '../lib/markdown/preview';
  import { STATUS_LABELS, TASK_STATUS_LABELS, bugDraftId, type BugCase, type BugCaseInput, type BugJob, type BugTask, type BugTaskProposal } from '../lib/bugs/types';
  import { jira } from '../lib/jira/client';
  import type { JiraProject } from '../lib/jira/types';
  import { fetchServicesInfo, loadServicesRoot } from '../tad/generator-client';
  import type { Draft } from '../tad/drafts.svelte';

  const POLL_MS = 1500;
  const MAX_UPLOAD_MB = 10;

  let list = $state<BugCase[]>([]);
  let loaded = $state(false);
  let current = $state<BugCase | null>(null);
  let form = $state<BugCaseInput>(emptyForm());
  let saving = $state(false);
  let services = $state<string[]>([]);
  const servicesRoot = loadServicesRoot();

  // Logs
  let pasteText = $state('');
  let addingLog = $state(false);
  let previewLog = $state<{ name: string; text: string; truncated: boolean } | null>(null);

  // Analysis
  let ai = $state<AiSelection>(loadAiSelection('generator'));
  let useCodebase = $state(true);
  let instructions = $state('');
  let job = $state<BugJob | null>(null);

  // Discussion with the tracing agent about the case (answered in the background).
  let chatText = $state('');
  let chatJob = $state<BugJob | null>(null);
  const answering = $derived(chatJob?.status === 'running');
  const QUICK = ['Kenapa yakin itu akar masalahnya? Tunjukkan buktinya.', 'Apakah ada service atau fitur lain yang ikut terdampak?', 'Bagaimana cara mereproduksi bug ini di staging?', 'Apa risiko rencana fix ini?'];

  // Tasks from the analysis: Jira settings shared by all tasks, edits kept per task until saved.
  let projects = $state<JiraProject[]>([]);
  let ticketProject = $state('');
  let issueTypes = $state<{ id: string; name: string }[]>([]);
  let ticketType = $state('Bug');
  let fixBase = $state(appSettings.value.workspace.defaultBaseBranch);
  let edits = $state<Record<string, Partial<BugTaskProposal>>>({});
  /** Task id → what it is busy with ("ticket", "fix", …). */
  let busy = $state<Record<string, string>>({});
  let openTask = $state<string | null>(null);
  let runsKey = $state(0);

  function emptyForm(): BugCaseInput {
    return { title: '', description: '', steps: '', expected: '', actual: '', environment: '', serviceHint: '' };
  }

  const dirty = $derived(Boolean(current) && (['title', 'description', 'steps', 'expected', 'actual', 'environment', 'serviceHint'] as const).some((k) => form[k] !== (current as BugCase)[k]));
  const analyzing = $derived(job?.status === 'running');
  /** The structured fields are optional extras to the free-text report; opened for a case that uses them. */
  let detailsOpen = $state(false);
  let optionsOpen = $state(false);
  const DEFAULT_TITLE = 'Bug baru';
  /** AgentRunsPanel lists runs by draft id; a bug's runs use `bug-<id>`. */
  const pseudoDraft = $derived(current ? ({ id: bugDraftId(current.id), markdown: '' } as unknown as Draft) : null);

  $effect(() => {
    untrack(() => void init());
    // `#/bugs/<id>` (e.g. from the "tracing selesai" notification) opens that case.
    const onHash = () => {
      const id = caseFromHash();
      const c = id && list.find((x) => x.id === id);
      if (c && c.id !== current?.id) void open(c);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });

  function caseFromHash(): string | undefined {
    return location.hash.replace(/^#\/?/, '').split(/[?]/)[0].split('/')[1] || undefined;
  }

  async function init() {
    try {
      list = await bugs.list();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
    loaded = true;
    void fetchServicesInfo(servicesRoot)
      .then((s) => (services = s.services))
      .catch(() => {});
    void jira
      .projects()
      .then((p) => {
        projects = p;
        ticketProject ||= p.find((x) => x.key === appSettings.value.jira.defaultProject)?.key ?? p[0]?.key ?? '';
      })
      .catch(() => {});
    const fromHash = caseFromHash();
    const first = list.find((c) => c.id === fromHash) ?? list[0];
    if (first) void open(first);
  }

  async function open(c: BugCase) {
    if (dirty && !(await confirmDialog({ title: 'Buang perubahan?', message: 'Perubahan laporan bug belum disimpan.', confirmText: 'Buang', danger: true }))) return;
    current = c;
    form = { title: c.title, description: c.description, steps: c.steps, expected: c.expected, actual: c.actual, environment: c.environment, serviceHint: c.serviceHint };
    detailsOpen = Boolean(c.steps || c.expected || c.actual || c.environment || c.serviceHint);
    previewLog = null;
    edits = {};
    busy = {};
    openTask = null;
    job = null;
    chatJob = null;
    chatText = '';
    void bugs
      .latestChatJob(c.id)
      .then((j) => {
        if (j?.status === 'running' && current?.id === c.id) {
          chatJob = j;
          void pollChat(j.id);
        }
      })
      .catch(() => {});
    try {
      const j = await bugs.latestJob(c.id);
      if (j?.status === 'running' && current?.id === c.id) {
        job = j;
        void poll(j.id);
      }
    } catch {
      /* no job */
    }
  }

  function replace(c: BugCase) {
    current = c;
    list = [c, ...list.filter((x) => x.id !== c.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function createCase() {
    if (dirty && !(await confirmDialog({ title: 'Buang perubahan?', message: 'Perubahan laporan bug belum disimpan.', confirmText: 'Buang', danger: true }))) return;
    try {
      const c = await bugs.create({ title: DEFAULT_TITLE });
      replace(c);
      await open(c);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function save() {
    if (!current) return;
    saving = true;
    try {
      replace(await bugs.update(current.id, $state.snapshot(form)));
      toasts.show('Laporan bug tersimpan.', 'ok', 1500);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      saving = false;
    }
  }

  async function removeCase() {
    if (!current) return;
    const ok = await confirmDialog({ title: 'Hapus kasus bug?', message: `Hapus "${current.title}" beserta log-nya dari Cockpit? Tiket Jira dan branch fix (bila ada) tidak ikut terhapus.`, confirmText: 'Hapus', danger: true });
    if (!ok) return;
    try {
      await bugs.remove(current.id);
      list = list.filter((x) => x.id !== current!.id);
      current = null;
      if (list[0]) void open(list[0]);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  // Logs ---------------------------------------------------------------------------------

  async function addPasted() {
    if (!current || !pasteText.trim()) return;
    addingLog = true;
    try {
      replace(await bugs.addLog(current.id, `tempel-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.log`, pasteText));
      pasteText = '';
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      addingLog = false;
    }
  }

  async function upload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!current || !files.length) return;
    addingLog = true;
    try {
      for (const f of files) {
        if (f.size > MAX_UPLOAD_MB * 1024 * 1024) {
          toasts.show(`${f.name} melebihi ${MAX_UPLOAD_MB} MB; potong ke rentang waktu kejadian.`, 'err', 5000);
          continue;
        }
        replace(await bugs.addLog(current.id, f.name, await f.text()));
      }
    } catch (err) {
      toasts.show((err as Error).message, 'err');
    } finally {
      addingLog = false;
    }
  }

  async function showLog(name: string) {
    if (!current) return;
    if (previewLog?.name === name) return void (previewLog = null);
    try {
      previewLog = { name, ...(await bugs.readLog(current.id, name)) };
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function removeLog(name: string) {
    if (!current) return;
    try {
      replace(await bugs.removeLog(current.id, name));
      if (previewLog?.name === name) previewLog = null;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  // Tracing ------------------------------------------------------------------------------

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Sends the case to the tracing agent; it runs in the background in the connector. */
  async function sendToTracing() {
    if (!current) return;
    if (current.tasks.some((t) => t.status !== 'proposed') && !(await confirmDialog({ title: 'Trace ulang?', message: 'Task yang sudah punya tiket atau sedang diperbaiki tetap disimpan; usulan task lain diganti hasil tracing baru.', confirmText: 'Trace ulang' }))) return;
    // Fewer steps: a title from the report's first line, and a log still in the paste box goes along.
    if ((!form.title.trim() || form.title === DEFAULT_TITLE) && form.description.trim()) {
      form.title = form.description.trim().split('\n')[0].slice(0, 80);
    }
    if (pasteText.trim()) await addPasted();
    if (dirty) await save();
    try {
      job = await bugs.analyze({ caseId: current.id, ai, useCodebase, servicesRoot, instructions });
      replace({ ...current, status: 'analyzing' });
      toasts.show('Agent tracing berjalan di background. Halaman ini boleh ditinggal; ada notifikasi saat analisa selesai.', 'info', 5000);
      void poll(job.id);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function poll(id: string) {
    const caseId = current?.id;
    while (current?.id === caseId) {
      await sleep(POLL_MS);
      const j = await bugs.job(id).catch(() => null);
      if (!j || current?.id !== caseId) return;
      job = j;
      if (j.status === 'running') continue;
      const fresh = await bugs.get(caseId!).catch(() => null);
      if (fresh) replace(fresh);
      return;
    }
  }

  /** Sends a question to the discussion; the answer comes back in the background. */
  async function sendChat(text = chatText) {
    if (!current || !text.trim()) return;
    if (dirty) await save();
    try {
      chatJob = await bugs.chat({ caseId: current.id, text: text.trim(), ai, useCodebase, servicesRoot });
      chatText = '';
      // Show the question right away; the case on disk has it too.
      replace({ ...current, chat: [...(current.chat ?? []), { id: `local-${Date.now()}`, role: 'user', text: text.trim(), at: new Date().toISOString() }] });
      void pollChat(chatJob.id);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function pollChat(id: string) {
    const caseId = current?.id;
    while (current?.id === caseId) {
      await sleep(POLL_MS);
      const j = await bugs.job(id).catch(() => null);
      if (!j || current?.id !== caseId) return;
      chatJob = j;
      if (j.status === 'running') continue;
      const fresh = await bugs.get(caseId!).catch(() => null);
      if (fresh) replace(fresh);
      if (j.status === 'error') toasts.show(`Agent gagal menjawab: ${j.error}`, 'err', 6000);
      return;
    }
  }

  async function cancelChat() {
    if (chatJob) chatJob = await bugs.cancel(chatJob.id).catch(() => chatJob);
  }

  async function clearChat() {
    if (!current?.chat?.length) return;
    if (!(await confirmDialog({ title: 'Hapus diskusi?', message: 'Semua pesan diskusi kasus ini dihapus. Analisa dan task tidak berubah.', confirmText: 'Hapus', danger: true }))) return;
    try {
      replace(await bugs.clearChat(current.id));
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  /** Re-traces with the discussion's conclusions passed to the agent. */
  async function retraceWithChat() {
    if (!current) return;
    if (!(await confirmDialog({ title: 'Trace ulang memakai diskusi?', message: 'Agent menelusuri ulang dengan kesimpulan diskusi ini. Usulan task diganti; task yang sudah punya tiket atau sedang diperbaiki tetap.', confirmText: 'Trace ulang' }))) return;
    try {
      job = await bugs.analyze({ caseId: current.id, ai, useCodebase, servicesRoot, instructions, withChat: true });
      replace({ ...current, status: 'analyzing' });
      toasts.show('Trace ulang memakai diskusi berjalan di background.', 'info', 4000);
      void poll(job.id);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function cancelAnalysis() {
    if (job) job = await bugs.cancel(job.id).catch(() => job);
    if (current) replace(await bugs.get(current.id).catch(() => current!));
  }

  // Tasks --------------------------------------------------------------------------------

  $effect(() => {
    const p = ticketProject;
    if (!p) return;
    untrack(() =>
      bugs
        .issueTypes(p)
        .then((t) => {
          issueTypes = t;
          if (!t.some((x) => x.name === ticketType)) ticketType = t.find((x) => /bug/i.test(x.name))?.name ?? t[0]?.name ?? 'Bug';
        })
        .catch(() => (issueTypes = [])),
    );
  });

  const val = <K extends keyof BugTaskProposal>(t: BugTask, k: K): BugTaskProposal[K] => (edits[t.id]?.[k] as BugTaskProposal[K] | undefined) ?? t[k];
  function setEdit<K extends keyof BugTaskProposal>(t: BugTask, k: K, v: BugTaskProposal[K]) {
    edits[t.id] = { ...edits[t.id], [k]: v };
  }
  const taskDirty = (t: BugTask) => Object.entries(edits[t.id] ?? {}).some(([k, v]) => v !== t[k as keyof BugTaskProposal]);

  /** Saves a task's pending edits (also before a ticket or a fix uses them). */
  async function saveTask(t: BugTask): Promise<boolean> {
    if (!current || !taskDirty(t)) return true;
    try {
      replace(await bugs.updateTask(current.id, t.id, $state.snapshot(edits[t.id]) ?? {}));
      delete edits[t.id];
      return true;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
      return false;
    }
  }

  async function createTicket(t: BugTask, confirmFirst = true): Promise<boolean> {
    if (!current || !ticketProject) return false;
    if (confirmFirst && !(await confirmDialog({ title: 'Buat tiket Jira?', message: `Membuat ${ticketType} di project ${ticketProject}: "${val(t, 'jiraSummary')}".`, confirmText: 'Buat tiket' }))) return false;
    if (!(await saveTask(t))) return false;
    busy[t.id] = 'ticket';
    try {
      replace(await bugs.ticket({ caseId: current.id, taskId: t.id, projectKey: ticketProject, issueType: ticketType, summary: val(t, 'jiraSummary'), description: val(t, 'jiraDescription') }));
      return true;
    } catch (e) {
      toasts.show(`${t.title}: ${(e as Error).message}`, 'err', 8000);
      return false;
    } finally {
      delete busy[t.id];
    }
  }

  async function createAllTickets() {
    if (!current) return;
    const pending = current.tasks.filter((t) => !t.jira);
    if (!pending.length) return;
    const ok = await confirmDialog({ title: `Buat ${pending.length} tiket Jira?`, message: `Satu ${ticketType} per task di project ${ticketProject}:\n${pending.map((t) => `• ${val(t, 'jiraSummary')}`).join('\n')}`, confirmText: 'Buat semua' });
    if (!ok) return;
    let made = 0;
    for (const t of pending) if (await createTicket(current.tasks.find((x) => x.id === t.id) ?? t, false)) made++;
    toasts.show(`${made} dari ${pending.length} tiket dibuat.`, made === pending.length ? 'ok' : 'err');
  }

  async function startFix(t: BugTask) {
    if (!current) return;
    const ok = await confirmDialog({
      title: 'Kerjakan dengan coder agent?',
      message: `Agent ${val(t, 'profile')} akan membuat branch fix/${t.jira?.key ?? 'agent'}-… dari ${fixBase} di repo ${val(t, 'repo')}, menulis test reproduksi lalu memperbaiki task "${val(t, 'title')}". Hasilnya kamu review sebelum push.`,
      confirmText: 'Mulai',
    });
    if (!ok || !(await saveTask(t))) return;
    busy[t.id] = 'fix';
    try {
      const r = await bugs.fix({ caseId: current.id, taskId: t.id, profile: val(t, 'profile'), baseBranch: fixBase || undefined });
      replace(r.case);
      runsKey++;
      toasts.show('Coder agent mulai mengerjakan task.', 'ok');
    } catch (e) {
      toasts.show((e as Error).message, 'err', 8000);
    } finally {
      delete busy[t.id];
    }
  }

  async function toggleDone(t: BugTask) {
    if (!current) return;
    try {
      replace(await bugs.setTaskStatus(current.id, t.id, t.status === 'fixed' ? 'ticketed' : 'fixed'));
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function removeTask(t: BugTask) {
    if (!current || !(await confirmDialog({ title: 'Hapus task?', message: `Hapus usulan task "${t.title}"?`, confirmText: 'Hapus', danger: true }))) return;
    try {
      replace(await bugs.removeTask(current.id, t.id));
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function addTask() {
    if (!current) return;
    const repo = current.analysis?.repo || current.serviceHint || services[0] || '';
    try {
      const c = await bugs.addTask(current.id, { title: 'Task baru', repo });
      replace(c);
      openTask = c.tasks.at(-1)?.id ?? null;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const SEVERITY: Record<string, string> = { critical: 'Kritis', high: 'Tinggi', medium: 'Sedang', low: 'Rendah' };
  const CONF: Record<string, string> = { high: 'yakin', medium: 'cukup yakin', low: 'kurang yakin' };
</script>

<div class="bugs">
  <aside class="list">
    <div class="list-head">
      <h2>Bug Tracing</h2>
      <button class="btn btn-primary btn-sm" onclick={createCase}><Icon name="plus" size={13} /> Bug baru</button>
    </div>
    <p class="muted small hint">Tulis laporan + log, kirim ke agent tracing (berjalan di background), lalu buat task dari hasil analisanya: tiket Jira dan pengerjaan oleh coder agent.</p>
    {#if loaded && !list.length}<p class="muted small">Belum ada kasus bug.</p>{/if}
    {#each list as c (c.id)}
      <button class="item" class:active={c.id === current?.id} onclick={() => open(c)}>
        <strong>{c.id === current?.id ? form.title || c.title : c.title}</strong>
        <span class="small muted">
          <span class="st st-{c.status}">{STATUS_LABELS[c.status]}</span>
          {c.jira ? ` · ${c.jira.key}` : ''} · {fmt(c.updatedAt)}
        </span>
      </button>
    {/each}
  </aside>

  <section class="main">
    {#if !current}
      <div class="empty">
        <Icon name="bug" size={28} />
        <h2>Belum ada kasus dipilih</h2>
        <p class="muted">Buat kasus bug, isi laporan dan log, lalu kirim ke agent tracing. Task dibuat dari hasil analisanya.</p>
        <button class="btn btn-primary" onclick={createCase}><Icon name="plus" size={14} /> Bug baru</button>
      </div>
    {:else}
      <header class="head">
        <input class="input title" bind:value={form.title} placeholder="Judul singkat bug" aria-label="Judul bug" />
        <span class="st st-{current.status}">{STATUS_LABELS[current.status]}</span>
        {#if current.jira}<a class="chip" href={current.jira.url} target="_blank" rel="noreferrer"><Icon name="jira" size={11} /> {current.jira.key}</a>{/if}
        <span class="grow"></span>
        <button class="btn btn-sm" onclick={save} disabled={!dirty || saving}>{saving ? 'Menyimpan…' : dirty ? 'Simpan' : 'Tersimpan'}</button>
        <button class="btn btn-ghost btn-sm del" onclick={removeCase}><Icon name="trash" size={13} /> Hapus</button>
      </header>

      <div class="body">
        <!-- 1. Report -->
        <section class="card">
          <h3><span class="num">1</span> Laporan</h3>
          <textarea
            class="input"
            rows="5"
            bind:value={form.description}
            aria-label="Laporan bug"
            placeholder="Ceritakan bug-nya dengan bebas: apa yang terjadi, langkah reproduksi, yang diharapkan, environment. Satu paragraf cukup."
          ></textarea>
          <details class="more" bind:open={detailsOpen}>
            <summary class="small muted">Detail terstruktur (opsional)</summary>
            <div class="more-body">
              <div class="grid2">
                <label class="field"><span>Environment</span><input class="input" bind:value={form.environment} placeholder="mis. staging, prod, app v3.2.1" /></label>
                <label class="field">
                  <span>Petunjuk service</span>
                  <input class="input" bind:value={form.serviceHint} list="bug-services" placeholder="mis. core-promo-ultimate" />
                  <datalist id="bug-services">{#each services as s (s)}<option value={s}></option>{/each}</datalist>
                </label>
              </div>
              <label class="field"><span>Langkah reproduksi</span><textarea class="input" rows="3" bind:value={form.steps} placeholder="1. …&#10;2. …"></textarea></label>
              <div class="grid2">
                <label class="field"><span>Yang diharapkan</span><textarea class="input" rows="2" bind:value={form.expected}></textarea></label>
                <label class="field"><span>Yang terjadi</span><textarea class="input" rows="2" bind:value={form.actual} placeholder="mis. error 500, pesan …"></textarea></label>
              </div>
            </div>
          </details>
        </section>

        <!-- 2. Logs -->
        <section class="card">
          <div class="section-head">
            <h3><span class="num">2</span> Log ({current.logs.length})</h3>
            <label class="btn btn-sm upload" class:disabled={addingLog}>
              <Icon name="upload" size={12} /> Upload file log
              <input type="file" multiple accept=".log,.txt,.json,.out,.err,.csv,text/*" onchange={upload} disabled={addingLog} hidden />
            </label>
          </div>
          {#each current.logs as l (l.name)}
            <div class="log-row">
              <Icon name="doc" size={13} />
              <span class="mono">{l.name}</span>
              <span class="muted small">{kb(l.size)} · {l.lines.toLocaleString('id-ID')} baris</span>
              <span class="grow"></span>
              <button class="btn btn-ghost btn-sm" onclick={() => showLog(l.name)}>{previewLog?.name === l.name ? 'Tutup' : 'Lihat'}</button>
              <button class="btn btn-ghost btn-sm" onclick={() => removeLog(l.name)} aria-label="Hapus log {l.name}"><Icon name="trash" size={12} /></button>
            </div>
          {/each}
          {#if previewLog}
            <pre class="log-preview">{previewLog.text}{previewLog.truncated ? '\n… (dipotong)' : ''}</pre>
          {/if}
          <div class="paste">
            <textarea class="input mono" rows="4" bind:value={pasteText} placeholder="Tempel log di sini (sekitar waktu kejadian, termasuk stack trace). Ikut terkirim otomatis saat tracing."></textarea>
            {#if pasteText.trim()}<button class="btn btn-sm" onclick={addPasted} disabled={addingLog}><Icon name="plus" size={12} /> Simpan sebagai log</button>{/if}
          </div>
          <p class="muted small">Log disimpan apa adanya di laptop ini. Sebelum dibaca AI, token, password/PIN, JWT, nomor kartu, nomor HP, dan email disamarkan otomatis.</p>
        </section>

        <!-- 3. Tracing -->
        <section class="card">
          <h3><span class="num">3</span> Agent tracing</h3>
          {#if analyzing}
            <div class="banner">
              <span class="spinner" aria-hidden="true"></span>
              <span>Agent tracing menelusuri bug{useCodebase ? ' di codebase' : ''} di background. Halaman ini boleh ditinggal; ada notifikasi saat analisa selesai. <span class="muted">{job?.progress ?? ''}</span></span>
              <button class="btn btn-sm" onclick={cancelAnalysis}>Batalkan</button>
            </div>
          {:else}
            <div class="ai-row">
              <AiPicker value={ai} onchange={(s) => (ai = s)} />
              <button class="btn btn-primary btn-sm" onclick={sendToTracing} disabled={!form.title.trim() && !form.description.trim()}><Icon name="sparkles" size={13} /> {current.analysis ? 'Trace ulang' : 'Kirim ke agent tracing'}</button>
            </div>
            <details class="more" bind:open={optionsOpen}>
              <summary class="small muted">Opsi lanjutan{useCodebase ? '' : ' · tanpa codebase'}{instructions.trim() ? ' · ada instruksi' : ''}</summary>
              <div class="more-body">
                <label class="check small"><input type="checkbox" bind:checked={useCodebase} /> Telusuri codebase (hanya baca): <code>{servicesRoot}</code></label>
                <input class="input" bind:value={instructions} placeholder="Instruksi tambahan, mis. curigai perubahan minggu lalu di quota" />
              </div>
            </details>
            {#if job?.status === 'error'}
              <p class="err small">Tracing terakhir gagal: {job.error}</p>
              {#if job.rawReply}<details class="raw"><summary class="small">Jawaban mentah AI</summary><pre>{job.rawReply}</pre></details>{/if}
            {/if}
          {/if}

          {#if current.analysis}
            {@const a = current.analysis}
            <div class="analysis">
              <div class="a-head">
                <span class="sev sev-{a.severity}">{SEVERITY[a.severity]}</span>
                <span class="conf c-{a.confidence}">{CONF[a.confidence]}</span>
                {#each a.services as s (s)}<span class="chip mono">{s}</span>{/each}
                <span class="muted small">· {fmt(a.at)} · {a.ai.provider}{a.ai.model ? ` ${a.ai.model}` : ''}</span>
              </div>
              {#if a.touchedRepos?.length}<p class="err small">⚠ Repo berubah selama tracing (seharusnya hanya baca): {a.touchedRepos.join(', ')}. Cek git status repo tersebut.</p>{/if}
              <p class="summary">{a.summary}</p>
              <h4>Root cause</h4>
              <p class="pre">{a.rootCause}</p>
              {#if a.evidence.length}
                <h4>Bukti di kode</h4>
                <ul class="evidence">
                  {#each a.evidence as e, i (i)}<li><code>{e.file}{e.line ? `:${e.line}` : ''}</code> — {e.note}</li>{/each}
                </ul>
              {/if}
              {#if a.logSignals.length}
                <h4>Sinyal di log</h4>
                <pre class="signals">{a.logSignals.join('\n')}</pre>
              {/if}
              {#if a.fixPlan || a.testPlan}
                <div class="grid2">
                  <div><h4>Ringkasan rencana fix</h4><p class="pre">{a.fixPlan || '–'}</p></div>
                  <div><h4>Ringkasan rencana test</h4><p class="pre">{a.testPlan || '–'}</p></div>
                </div>
              {/if}
              {#if a.openQuestions.length}
                <h4>Perlu dikonfirmasi</h4>
                <ul>{#each a.openQuestions as q, i (i)}<li>{q}</li>{/each}</ul>
              {/if}
            </div>
          {:else if !analyzing}
            <p class="muted small">Isi laporan dan tambahkan log, lalu kirim ke agent tracing. Agent menelusuri bug di background dan menghasilkan analisa beserta usulan task.</p>
          {/if}
        </section>

        <!-- Discussion -->
        <section class="card chat">
          <div class="section-head">
            <h3><Icon name="chat" size={14} /> Diskusi dengan agent{current.chat?.length ? ` (${current.chat.length})` : ''}</h3>
            <div class="row">
              {#if current.chat?.some((m) => m.role === 'assistant')}<button class="btn btn-sm" onclick={retraceWithChat} disabled={analyzing || answering} title="Telusuri ulang dengan kesimpulan diskusi ini"><Icon name="refresh" size={12} /> Trace ulang memakai diskusi</button>{/if}
              {#if current.chat?.length}<button class="btn btn-ghost btn-sm" onclick={clearChat} disabled={answering}>Hapus diskusi</button>{/if}
            </div>
          </div>
          <p class="muted small">Tanya lanjutan tentang bug ini. Agent membaca laporan, log (disensor), hasil analisa, dan riwayat diskusi{useCodebase ? ', serta codebase (hanya baca)' : ''}. Jawaban diproses di background.</p>
          <div class="messages">
            {#each current.chat ?? [] as m (m.id)}
              <div class="msg" class:me={m.role === 'user'}>
                <div class="who small muted">{m.role === 'user' ? 'Kamu' : `Agent${m.model ? ` · ${m.model}` : ''}`} · {new Date(m.at).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                {#if m.role === 'assistant'}<div class="md">{@html renderPreview(m.text).html}</div>{:else}<p class="pre">{m.text}</p>{/if}
              </div>
            {:else}
              <div class="quick">
                {#each QUICK as qx (qx)}<button class="chip-btn small" onclick={() => sendChat(qx)} disabled={analyzing}>{qx}</button>{/each}
              </div>
            {/each}
            {#if answering}<div class="msg"><div class="small muted"><Icon name="sparkles" size={12} /> Agent sedang menjawab… {chatJob?.progress ?? ''}</div><button class="btn btn-ghost btn-sm" onclick={cancelChat}>Batalkan</button></div>{/if}
            {#if chatJob?.status === 'error'}<p class="small err-text">Agent gagal menjawab: {chatJob.error}</p>{/if}
          </div>
          <div class="composer">
            <textarea class="input" rows="2" bind:value={chatText} placeholder="Tanya agent, mis. apakah bug ini juga terjadi di endpoint refund? (⌘/Ctrl+Enter untuk kirim)" onkeydown={(e) => (e.key === 'Enter' && (e.metaKey || e.ctrlKey) ? (e.preventDefault(), void sendChat()) : undefined)} disabled={answering}></textarea>
            <div class="row">
              <label class="small"><input type="checkbox" bind:checked={useCodebase} /> boleh baca codebase</label>
              <AiPicker value={ai} onchange={(v) => (ai = v)} disabled={answering} />
              <button class="btn btn-primary btn-sm" onclick={() => sendChat()} disabled={answering || analyzing || !chatText.trim()}><Icon name="send" size={12} /> Kirim</button>
            </div>
          </div>
        </section>

        <!-- 4. Tasks -->
        <section class="card">
          <div class="section-head">
            <h3><span class="num">4</span> Task dari analisa{current.tasks.length ? ` (${current.tasks.length})` : ''}</h3>
            {#if current.analysis && !analyzing}
              <button class="btn btn-ghost btn-sm" onclick={addTask}><Icon name="plus" size={12} /> Task manual</button>
            {/if}
          </div>
          {#if analyzing}
            <p class="muted small">Menunggu agent tracing selesai. Task dibuat dari hasil analisanya.</p>
          {:else if !current.analysis}
            <p class="muted small">Belum ada task. Task (beserta tiket Jira dan pengerjaan oleh coder agent) dibuat dari hasil analisa agent tracing.</p>
          {:else}
            <div class="grid3 jira-row">
              <label class="field">
                <span>Project Jira</span>
                <select class="input" bind:value={ticketProject}>
                  {#if !projects.length}<option value="">(Jira belum terhubung)</option>{/if}
                  {#each projects as p (p.key)}<option value={p.key}>{p.key} · {p.name}</option>{/each}
                </select>
              </label>
              <label class="field">
                <span>Tipe tiket</span>
                <select class="input" bind:value={ticketType}>
                  {#each issueTypes.length ? issueTypes : [{ id: 'bug', name: 'Bug' }] as t (t.id)}<option value={t.name}>{t.name}</option>{/each}
                </select>
              </label>
              <label class="field">
                <span>Branch dasar fix</span>
                <input class="input mono" bind:value={fixBase} placeholder="staging" />
              </label>
            </div>
            {#if current.tasks.some((t) => !t.jira)}
              <div class="row-end">
                <button class="btn btn-sm" onclick={createAllTickets} disabled={!ticketProject || Object.keys(busy).length > 0}><Icon name="jira" size={12} /> Buat tiket untuk {current.tasks.filter((t) => !t.jira).length} task</button>
              </div>
            {/if}
            {#each current.tasks as t (t.id)}
              <article class="task">
                <div class="task-head">
                  <span class="st st-task-{t.status}">{TASK_STATUS_LABELS[t.status]}</span>
                  <input class="input task-title" value={val(t, 'title')} oninput={(e) => setEdit(t, 'title', e.currentTarget.value)} aria-label="Judul task" />
                  <input class="input mono task-repo" value={val(t, 'repo')} oninput={(e) => setEdit(t, 'repo', e.currentTarget.value)} list="bug-services" aria-label="Repo" disabled={t.coderRunIds.length > 0} />
                  <select class="input task-profile" value={val(t, 'profile')} onchange={(e) => setEdit(t, 'profile', e.currentTarget.value as BugTask['profile'])} aria-label="Profil agent">
                    <option value="backend">Backend</option><option value="frontend">Frontend</option>
                  </select>
                  {#if t.jira}<a class="chip" href={t.jira.url} target="_blank" rel="noreferrer"><Icon name="jira" size={11} /> {t.jira.key}</a>{/if}
                </div>
                <button class="toggle small" onclick={() => (openTask = openTask === t.id ? null : t.id)} aria-expanded={openTask === t.id}>{openTask === t.id ? '▾ Sembunyikan detail' : '▸ Rencana fix, test & tiket'}</button>
                {#if openTask === t.id}
                  <div class="grid2">
                    <label class="field"><span>Rencana fix</span><textarea class="input" rows="4" value={val(t, 'fixPlan')} oninput={(e) => setEdit(t, 'fixPlan', e.currentTarget.value)}></textarea></label>
                    <label class="field"><span>Rencana test</span><textarea class="input" rows="4" value={val(t, 'testPlan')} oninput={(e) => setEdit(t, 'testPlan', e.currentTarget.value)}></textarea></label>
                  </div>
                  {#if !t.jira}
                    <label class="field"><span>Judul tiket</span><input class="input" maxlength="250" value={val(t, 'jiraSummary')} oninput={(e) => setEdit(t, 'jiraSummary', e.currentTarget.value)} /></label>
                    <label class="field"><span>Deskripsi tiket</span><textarea class="input" rows="5" value={val(t, 'jiraDescription')} oninput={(e) => setEdit(t, 'jiraDescription', e.currentTarget.value)}></textarea></label>
                  {/if}
                {/if}
                <div class="row-end">
                  {#if taskDirty(t)}<button class="btn btn-sm" onclick={() => saveTask(t)}>Simpan perubahan</button>{/if}
                  {#if t.status === 'proposed'}<button class="btn btn-ghost btn-sm" onclick={() => removeTask(t)} aria-label="Hapus task {t.title}"><Icon name="trash" size={12} /></button>{/if}
                  {#if !t.jira}
                    <button class="btn btn-sm" onclick={() => createTicket(t)} disabled={!!busy[t.id] || !ticketProject || !val(t, 'jiraSummary').trim()}><Icon name="jira" size={12} /> {busy[t.id] === 'ticket' ? 'Membuat…' : 'Buat tiket Jira'}</button>
                  {/if}
                  {#if t.status !== 'proposed'}
                    <button class="btn btn-ghost btn-sm" onclick={() => toggleDone(t)}><Icon name="check" size={12} /> {t.status === 'fixed' ? 'Buka lagi' : 'Tandai selesai'}</button>
                  {/if}
                  <button
                    class="btn btn-primary btn-sm"
                    onclick={() => startFix(t)}
                    disabled={!!busy[t.id] || !val(t, 'repo').trim() || (!t.jira && projects.length > 0)}
                    title={!t.jira && projects.length > 0 ? 'Buat tiket Jira dulu: branch dan commit agent memakai key-nya' : ''}
                  >
                    <Icon name="bot" size={12} /> {busy[t.id] === 'fix' ? 'Memulai…' : t.coderRunIds.length ? 'Jalankan agent lagi' : 'Kerjakan dengan agent'}
                  </button>
                </div>
              </article>
            {/each}
            {#if pseudoDraft && current.coderRunIds.length}
              {#key current.id}
                <AgentRunsPanel draft={pseudoDraft} refreshKey={runsKey} collapsible={false} />
              {/key}
            {/if}
          {/if}
        </section>

      </div>
    {/if}
  </section>
</div>

<style>
  .bugs {
    display: grid;
    grid-template-columns: 280px 1fr;
    height: 100%;
    overflow: hidden;
  }
  .list {
    border-right: 1px solid var(--border);
    padding: 14px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .list-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .list-head h2 {
    margin: 0;
    font-size: 16px;
  }
  .hint {
    margin: 0 0 6px;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: left;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .item:hover {
    background: var(--surface-hover);
  }
  .item.active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .st {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--surface-hover);
  }
  .st-analyzing {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .st-analyzed,
  .st-ticketed {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .st-fixing {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .st-fixed {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .main {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .empty {
    margin: auto;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    max-width: 420px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
  }
  .head .title {
    flex: 1;
    max-width: 520px;
    font-weight: 600;
  }
  .grow {
    flex: 1;
  }
  .del {
    color: var(--err);
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 14px 18px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h4 {
    margin: 6px 0 2px;
    font-size: 12.5px;
  }
  .num {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 11px;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  textarea {
    resize: vertical;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .grid3 {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 10px;
  }
  .small {
    font-size: 12px;
  }
  .upload {
    cursor: pointer;
  }
  .upload.disabled {
    opacity: 0.6;
    pointer-events: none;
  }
  .log-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .log-preview,
  .signals,
  .raw pre {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .paste {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .paste button {
    align-self: flex-start;
  }
  .ai-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .more summary {
    cursor: pointer;
    width: fit-content;
  }
  .more-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    font-size: 13px;
  }
  .banner > span:nth-child(2) {
    flex: 1;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    border-right-color: transparent;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .err {
    color: var(--err);
    margin: 0;
  }
  .chat .messages {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 520px;
    overflow: auto;
    margin: 8px 0;
  }
  .chat .msg {
    align-self: flex-start;
    max-width: 92%;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .chat .msg.me {
    align-self: flex-end;
    background: var(--accent-soft, var(--surface-2));
  }
  .chat .msg .pre {
    margin: 2px 0 0;
    white-space: pre-wrap;
  }
  .chat .md :global(pre) {
    overflow: auto;
  }
  .chat .quick {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chat .quick .chip-btn {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 999px;
    padding: 3px 10px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    font-size: 12px;
  }
  .chat .quick .chip-btn:hover {
    border-color: var(--accent);
  }
  .chat .composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .chat .composer .row,
  .chat .section-head .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .analysis {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
    font-size: 13px;
  }
  .a-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .summary {
    font-weight: 600;
    margin: 6px 0 0;
  }
  .pre {
    white-space: pre-wrap;
    margin: 0;
  }
  .evidence {
    margin: 0;
    padding-left: 18px;
  }
  .sev,
  .conf {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 999px;
  }
  .sev-critical,
  .sev-high {
    background: var(--err-soft);
    color: var(--err);
  }
  .sev-medium {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .sev-low,
  .c-high {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .c-medium {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .c-low {
    background: var(--err-soft);
    color: var(--err);
  }
  .row-end {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .st-task-ticketed {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .st-task-fixing {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .st-task-fixed {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .jira-row {
    margin-bottom: 8px;
  }
  .task {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    margin-top: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
  }
  .task-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .task-title {
    flex: 2;
    min-width: 200px;
    font-weight: 600;
  }
  .task-repo {
    flex: 1;
    min-width: 160px;
  }
  .task-profile {
    width: auto;
  }
  .toggle {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  @media (max-width: 900px) {
    .bugs {
      grid-template-columns: 1fr;
    }
    .list {
      border-right: none;
      border-bottom: 1px solid var(--border);
      max-height: 200px;
    }
    .grid2,
    .grid3 {
      grid-template-columns: 1fr;
    }
  }
</style>
