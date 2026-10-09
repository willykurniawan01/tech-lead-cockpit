<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { bugs } from '../lib/bugs/client';
  import type { BugCase } from '../lib/bugs/types';
  import { DEFAULT_DONE_DAYS, type EstimateProject, type ProjectJiraFilter } from '../lib/estimate/types';
  import { gitlab, OPEN_MR_KEY } from '../lib/gitlab/client';
  import type { MrSummary } from '../lib/gitlab/types';
  import { jira } from '../lib/jira/client';
  import type { JiraProject } from '../lib/jira/types';
  import { hasOpsSources, loadOpsProgress, rowRef, type OpsProgress } from '../lib/projects/ops-tasks';
  import { getTaskDevProgress, type ProgressTaskRow } from '../lib/tad/progress-report';
  import { boardFilter, matchesJiraStatus, statusOptions } from '../lib/projects/board-filter.svelte';

  let { project = $bindable() }: { project: EstimateProject } = $props();

  let data = $state<OpsProgress | null>(null);
  let loading = $state(false);
  let jiraBase = $state<string | undefined>();
  let sourcesOpen = $state(!hasOpsSources(project));

  // --- Load, and reload when the sources change --------------------------------------------
  const sourcesSig = $derived(JSON.stringify([project.jiraFilter ?? null, project.bugCaseIds ?? [], project.manualTasks ?? []]));
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  async function load() {
    const mine = ++seq;
    loading = true;
    try {
      const next = await loadOpsProgress($state.snapshot(project) as EstimateProject);
      if (mine === seq) data = next;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      if (mine === seq) loading = false;
    }
  }

  $effect(() => {
    void sourcesSig;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => untrack(() => void load()), data ? 600 : 0);
    return () => clearTimeout(reloadTimer);
  });

  $effect(() => {
    jira
      .status()
      .then((s) => (jiraBase = s.configured ? s.baseUrl : undefined))
      .catch(() => {});
  });

  // --- Sources: Jira filter and Bug Tracing cases ------------------------------------------
  const ISSUE_TYPES = ['Bug', 'Task', 'Improvement', 'Story', 'Sub-task'];
  let jiraProjects = $state<JiraProject[]>([]);
  let allCases = $state<BugCase[]>([]);
  let filter = $state<ProjectJiraFilter>(emptyFilter());

  function emptyFilter(): ProjectJiraFilter {
    return project.jiraFilter ? structuredClone($state.snapshot(project.jiraFilter) as ProjectJiraFilter) : { projectKey: '', issueTypes: ['Bug'], doneDays: DEFAULT_DONE_DAYS };
  }

  $effect(() => {
    if (!sourcesOpen) return;
    untrack(() => {
      filter = emptyFilter();
      if (!jiraProjects.length) jira.projects().then((p) => (jiraProjects = p)).catch(() => {});
      bugs.list().then((c) => (allCases = c)).catch(() => {});
    });
  });

  function toggleType(t: string) {
    filter.issueTypes = filter.issueTypes.includes(t) ? filter.issueTypes.filter((x) => x !== t) : [...filter.issueTypes, t];
  }

  function applyFilter() {
    if (!filter.projectKey) {
      project.jiraFilter = undefined;
    } else {
      project.jiraFilter = {
        projectKey: filter.projectKey,
        issueTypes: filter.issueTypes,
        ...(filter.label?.trim() ? { label: filter.label.trim() } : {}),
        ...(filter.epicKey?.trim() ? { epicKey: filter.epicKey.trim().toUpperCase() } : {}),
        ...(filter.activeSprint ? { activeSprint: true } : {}),
        doneDays: Number.isFinite(Number(filter.doneDays)) ? Math.max(0, Math.round(Number(filter.doneDays))) : DEFAULT_DONE_DAYS,
      };
    }
    toasts.show('Filter Jira disimpan.', 'ok', 1500);
  }

  function toggleCase(id: string) {
    const ids = project.bugCaseIds ?? [];
    project.bugCaseIds = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  }

  // --- Manual tasks --------------------------------------------------------------------------
  let newTitle = $state('');
  let newRepo = $state('');
  let newKey = $state('');

  function addManual(e: SubmitEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    const jiraKey = newKey.trim().toUpperCase();
    project.manualTasks = [
      ...(project.manualTasks ?? []),
      { id: crypto.randomUUID(), title, ...(newRepo.trim() ? { repo: newRepo.trim() } : {}), ...(/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(jiraKey) ? { jiraKey } : {}), createdAt: new Date().toISOString() },
    ];
    newTitle = '';
    newRepo = '';
    newKey = '';
  }

  function toggleManualDone(id: string) {
    project.manualTasks = (project.manualTasks ?? []).map((m) => (m.id === id ? { ...m, done: !m.done } : m));
  }

  async function removeManual(id: string, title: string) {
    if (!(await confirmDialog({ title: 'Hapus task manual?', message: `Hapus "${title}" dari proyek ini?`, confirmText: 'Hapus', danger: true }))) return;
    project.manualTasks = (project.manualTasks ?? []).filter((m) => m.id !== id);
  }

  function unlinkCase(id: string) {
    project.bugCaseIds = (project.bugCaseIds ?? []).filter((x) => x !== id);
  }

  /** A ticket becomes a Bug Tracing case (key in the title, so it replaces the ticket's row here). */
  async function traceTicket(r: ProgressTaskRow) {
    const issue = r.issues[0]?.issue;
    const key = r.issues[0]?.key;
    if (!key) return;
    try {
      const c = await bugs.create({ title: `${key} · ${issue?.summary ?? r.task.title}`.slice(0, 200), description: `Tiket Jira ${key}${issue ? ` (${issue.issueType}, ${issue.status})` : ''}: ${issue?.summary ?? r.task.title}` });
      project.bugCaseIds = [...(project.bugCaseIds ?? []), c.id];
      location.hash = `#/bugs/${c.id}`;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  // --- MR linking (same as the TAD Task Board) ------------------------------------------------
  const stateLabel: Record<MrSummary['state'], string> = { opened: 'open', merged: 'merged', closed: 'closed', locked: 'locked' };
  let manualFor = $state<string | null>(null);
  let manualUrl = $state('');
  let manualBusy = $state(false);

  async function linkMr(key: string) {
    if (!manualUrl.trim()) return;
    manualBusy = true;
    try {
      await gitlab.addManualMr(key, manualUrl.trim());
      manualFor = null;
      manualUrl = '';
      toasts.show('MR ditautkan; progres dihitung ulang.', 'ok');
      await load();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      manualBusy = false;
    }
  }

  function openMr(m: MrSummary) {
    try {
      sessionStorage.setItem(OPEN_MR_KEY, m.webUrl);
    } catch {
      /* the page still opens */
    }
    location.hash = '#/mr';
  }

  // --- Table: search and filters ---------------------------------------------------------------
  type Row = ProgressTaskRow;
  type RowFilter = 'all' | 'open' | 'jira' | 'bug' | 'manual' | 'attention';
  let query = $state('');
  let rowFilter = $state<RowFilter>('all');
  const rows = $derived(data?.rows ?? []);
  const isDone = (r: Row) => getTaskDevProgress(r).stage === 'merged';
  const FILTERS: { id: RowFilter; label: string; test: (r: Row) => boolean }[] = [
    { id: 'all', label: 'Semua', test: () => true },
    { id: 'open', label: 'Belum selesai', test: (r) => !isDone(r) },
    { id: 'jira', label: 'Tiket Jira', test: (r) => r.source === 'jira' },
    { id: 'bug', label: 'Bug Tracing', test: (r) => r.source === 'bug' },
    { id: 'manual', label: 'Manual', test: (r) => r.source === 'manual' },
    { id: 'attention', label: 'Perlu perhatian', test: (r) => r.flags.some((f) => f.tone !== 'info') },
  ];
  const filterCount = $derived(Object.fromEntries(FILTERS.map((f) => [f.id, rows.filter(f.test).length])) as Record<RowFilter, number>);
  const haystack = (r: Row) =>
    [r.task.title, r.task.service, ...r.issues.flatMap(({ key, issue }) => [key, issue?.status, issue?.assignee?.displayName, issue?.issueType]), ...r.mrs.flatMap((m) => [m.title, `${m.projectPath.split('/').pop()}!${m.iid}`, m.sourceBranch])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  const visibleRows = $derived.by(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const test = FILTERS.find((f) => f.id === rowFilter)!.test;
    return rows.filter((r) => test(r) && matchesJiraStatus(r.issues, boardFilter.jiraStatus) && (!terms.length || terms.every((t) => haystack(r).includes(t))));
  });
  const jiraStatuses = $derived(statusOptions(rows));
  // A status picked elsewhere that this board doesn't have would hide every row: show it anyway so it can be cleared.
  const statusChoices = $derived(
    boardFilter.jiraStatus && !jiraStatuses.some((o) => o.value === boardFilter.jiraStatus) ? [...jiraStatuses, { value: boardFilter.jiraStatus, label: boardFilter.jiraStatus, count: 0 }] : jiraStatuses,
  );

  const stats = $derived.by(() => {
    const stages = rows.map((r) => getTaskDevProgress(r));
    const percent = rows.length ? Math.round(stages.reduce((a, s) => a + s.percent, 0) / rows.length) : 0;
    return {
      percent,
      total: rows.length,
      done: stages.filter((s) => s.stage === 'merged').length,
      review: stages.filter((s) => s.stage === 'review').length,
      coding: stages.filter((s) => s.stage === 'in_progress').length,
      attention: rows.filter((r) => r.flags.some((f) => f.tone !== 'info')).length,
    };
  });

  const SOURCE_LABEL: Record<string, string> = { jira: 'Jira', bug: 'Bug', manual: 'Manual' };
  const STAGE_CLASS: Record<string, string> = { merged: 'st-done', review: 'st-review', in_progress: 'st-coding', todo: 'st-todo' };
  const manualOf = (id: string) => project.manualTasks?.find((m) => m.id === id);
</script>

<div class="ops">
  <header class="ops-head">
    <div>
      <h2>Tiket &amp; Bug</h2>
      <p class="muted small">Pekerjaan di luar TAD: tiket Jira dari filter proyek, perbaikan dari Bug Tracing, dan task manual. Progres dihitung seperti task TAD (MR merged = selesai), dan ikut Laporan Terjadwal.</p>
    </div>
    <div class="head-actions">
      <button class="btn btn-sm" class:active-btn={sourcesOpen} onclick={() => (sourcesOpen = !sourcesOpen)}><Icon name="filter" size={13} /> Sumber task</button>
      <button class="btn btn-sm" onclick={load} disabled={loading}><Icon name="refresh" size={13} /> {loading ? 'Memuat…' : 'Muat ulang'}</button>
    </div>
  </header>

  {#if sourcesOpen}
    <section class="card sources">
      <div class="source">
        <h3><Icon name="jira" size={14} /> Tiket Jira</h3>
        <div class="grid">
          <label class="field">
            <span>Project</span>
            <select class="input" bind:value={filter.projectKey}>
              <option value="">— Tidak pakai filter Jira —</option>
              {#if filter.projectKey && !jiraProjects.some((p) => p.key === filter.projectKey)}<option value={filter.projectKey}>{filter.projectKey}</option>{/if}
              {#each jiraProjects as p (p.key)}<option value={p.key}>{p.key} · {p.name}</option>{/each}
            </select>
          </label>
          <label class="field"><span>Label (opsional)</span><input class="input" bind:value={filter.label} placeholder="mis. bugfix" disabled={!filter.projectKey} /></label>
          <label class="field"><span>Epic (opsional)</span><input class="input mono" bind:value={filter.epicKey} placeholder="mis. MU-1200" disabled={!filter.projectKey} /></label>
          <label class="field"><span>Tetap tampil setelah selesai</span><span class="inline"><input class="input days" type="number" min="0" max="365" bind:value={filter.doneDays} disabled={!filter.projectKey} /> hari</span></label>
        </div>
        <div class="types" role="group" aria-label="Jenis tiket">
          <span class="muted small">Jenis:</span>
          {#each ISSUE_TYPES as t (t)}
            <button type="button" class="pill" class:on={filter.issueTypes.includes(t)} aria-pressed={filter.issueTypes.includes(t)} onclick={() => toggleType(t)} disabled={!filter.projectKey}>{t}</button>
          {/each}
          <label class="check small"><input type="checkbox" bind:checked={filter.activeSprint} disabled={!filter.projectKey} /> Hanya sprint aktif</label>
          <span class="grow"></span>
          <button class="btn btn-sm btn-primary" onclick={applyFilter}>Simpan filter</button>
        </div>
      </div>

      <div class="source">
        <h3><Icon name="bug" size={14} /> Kasus Bug Tracing</h3>
        {#if !allCases.length}
          <p class="muted small">Belum ada kasus di Bug Tracing.</p>
        {:else}
          <div class="cases">
            {#each allCases as c (c.id)}
              <label class="case" class:on={project.bugCaseIds?.includes(c.id)}>
                <input type="checkbox" checked={project.bugCaseIds?.includes(c.id) ?? false} onchange={() => toggleCase(c.id)} />
                <span class="case-title">{c.title}</span>
                <span class="muted small">{c.tasks.length} task</span>
              </label>
            {/each}
          </div>
        {/if}
      </div>
    </section>
  {/if}

  <form class="card add" onsubmit={addManual}>
    <Icon name="plus" size={14} />
    <input class="input title-in" bind:value={newTitle} placeholder="Tambah task manual, mis. &quot;Naikkan timeout callback biller&quot;" aria-label="Judul task manual" />
    <input class="input mono repo-in" bind:value={newRepo} placeholder="repo (opsional)" aria-label="Repo" />
    <input class="input mono key-in" bind:value={newKey} placeholder="Jira key (opsional)" aria-label="Jira key" />
    <button class="btn btn-sm btn-primary" type="submit" disabled={!newTitle.trim()}>Tambah</button>
  </form>

  {#if !data && loading}
    <p class="muted">Memuat tiket dan bug…</p>
  {:else if !rows.length}
    <div class="empty card">
      <Icon name="bug" size={26} />
      <p>Belum ada task di luar TAD. Atur <strong>Sumber task</strong> (filter Jira atau kasus Bug Tracing), atau tambah task manual di atas.</p>
    </div>
  {:else}
    <div class="stats">
      <div class="stat stat-progress">
        <span class="stat-label">Progres</span>
        <strong class="stat-value">{stats.percent}%</strong>
        <span class="stat-bar"><span style="width: {stats.percent}%"></span></span>
      </div>
      <div class="stat"><span class="stat-label">Task</span><strong class="stat-value">{stats.total}</strong></div>
      <div class="stat stat-ok"><span class="stat-label">Selesai</span><strong class="stat-value">{stats.done}</strong></div>
      <div class="stat stat-info"><span class="stat-label">Review / QA</span><strong class="stat-value">{stats.review}</strong></div>
      <div class="stat stat-info"><span class="stat-label">Sedang coding</span><strong class="stat-value">{stats.coding}</strong></div>
      <div class="stat" class:stat-warn={stats.attention > 0}><span class="stat-label">Perlu perhatian</span><strong class="stat-value">{stats.attention}</strong></div>
    </div>
  {/if}

  {#if data?.jiraError}<p class="note err small"><Icon name="alert" size={13} /> Jira: {data.jiraError}</p>{/if}
  {#if data?.gitlabError}<p class="note err small"><Icon name="alert" size={13} /> GitLab: {data.gitlabError}</p>{/if}
  {#if data?.jiraTruncated}<p class="note muted small"><Icon name="alert" size={13} /> Filter Jira mengembalikan 100 tiket (batas); persempit dengan label, epic, atau sprint aktif.</p>{/if}
  {#if data?.missingBugCases.length}<p class="note muted small"><Icon name="alert" size={13} /> {data.missingBugCases.length} kasus bug yang ditautkan sudah tidak ada. <button class="link-btn" onclick={() => (project.bugCaseIds = (project.bugCaseIds ?? []).filter((x) => !data?.missingBugCases.includes(x)))}>Lepaskan</button></p>{/if}

  {#if rows.length}
    <div class="table-toolbar">
      <label class="search">
        <Icon name="search" size={14} />
        <input type="search" bind:value={query} placeholder="Cari task, Jira key, status, assignee, repo, MR…" aria-label="Cari task" />
      </label>
      <div class="filters" role="group" aria-label="Filter task">
        {#each FILTERS as f (f.id)}
          <button type="button" class:active={rowFilter === f.id} aria-pressed={rowFilter === f.id} onclick={() => (rowFilter = f.id)}>{f.label} <span class="count">{filterCount[f.id]}</span></button>
        {/each}
      </div>
      <label class="status-select" class:on={boardFilter.jiraStatus}>
              <span>Status Jira</span>
              <select bind:value={boardFilter.jiraStatus} aria-label="Filter status Jira">
                <option value="">Semua</option>
                {#each statusChoices as o (o.value)}<option value={o.value}>{o.label} ({o.count})</option>{/each}
              </select>
            </label>
            {#if query || rowFilter !== 'all' || boardFilter.jiraStatus}<span class="muted small shown">{visibleRows.length} dari {rows.length}</span>{/if}
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr><th>Task</th><th>Jira</th><th>MR</th><th>Progres</th><th class="act"><span class="sr-only">Aksi</span></th></tr></thead>
        <tbody>
          {#each visibleRows as r (r.task.no)}
            {@const ref = rowRef(r)}
            {@const prog = getTaskDevProgress(r)}
            <tr>
              <td class="task">
                <span class="title">{r.task.title}</span>
                <span class="meta">
                  <span class="src src-{r.source}">{SOURCE_LABEL[r.source ?? ''] ?? 'TAD'}</span>
                  {#if r.task.service}<span class="muted small mono">{r.task.service}</span>{/if}
                </span>
                {#each r.flags as f, i (i)}<div class="flag tone-{f.tone}"><Icon name="alert" size={11} /> {f.text}</div>{/each}
              </td>
              <td>
                {#each r.issues as { key, issue } (key)}
                  <div class="issue">
                    {#if jiraBase}<a class="mono key" href="{jiraBase}/browse/{key}" target="_blank" rel="noreferrer">{key}</a>{:else}<span class="mono key">{key}</span>{/if}
                    {#if issue}
                      <span class="jstatus cat-{issue.statusCategory ?? 'new'}">{issue.status}</span>
                      {#if issue.assignee}<span class="muted small">{issue.assignee.displayName}</span>{/if}
                    {/if}
                  </div>
                {:else}
                  <span class="muted small">—</span>
                {/each}
              </td>
              <td>
                {#each r.mrs as m (m.ref)}
                  <button class="mr" onclick={() => openMr(m)} title="Buka di MR Review: {m.title}">
                    <span class="mono">{m.projectPath.split('/').pop()}!{m.iid}</span>
                    <span class="mr-state st-{m.state}">{m.draft && m.state === 'opened' ? 'draft' : stateLabel[m.state]}</span>
                  </button>
                {:else}
                  <span class="muted small">{loading ? '…' : '—'}</span>
                {/each}
                {#if r.task.jiraKeys[0]}
                  {#if manualFor === r.task.no}
                    <form class="mr-form" onsubmit={(e) => { e.preventDefault(); void linkMr(r.task.jiraKeys[0]); }}>
                      <!-- svelte-ignore a11y_autofocus -->
                      <input class="input input-xs mono" bind:value={manualUrl} placeholder="Link MR GitLab" autofocus aria-label="Link MR" />
                      <button class="btn btn-primary btn-xs" type="submit" disabled={manualBusy || !manualUrl.trim()}>Tautkan</button>
                      <button class="btn btn-ghost btn-xs" type="button" onclick={() => (manualFor = null)}>Batal</button>
                    </form>
                  {:else}
                    <button class="link-btn" onclick={() => { manualFor = r.task.no; manualUrl = ''; }}>+ MR manual</button>
                  {/if}
                {/if}
              </td>
              <td><span class="stage {STAGE_CLASS[prog.stage]}">{prog.stageLabel}</span></td>
              <td class="act">
                {#if ref?.source === 'manual'}
                  {@const m = manualOf(ref.id)}
                  <button class="btn btn-xs" onclick={() => toggleManualDone(ref.id)} title={m?.done ? 'Tandai belum selesai' : 'Tandai selesai'}><Icon name="check" size={11} /> {m?.done ? 'Buka lagi' : 'Selesai'}</button>
                  <button class="btn btn-ghost btn-xs" onclick={() => removeManual(ref.id, r.task.title)} aria-label="Hapus task manual"><Icon name="trash" size={11} /></button>
                {:else if ref?.source === 'bug'}
                  <a class="btn btn-xs" href="#/bugs/{ref.id}"><Icon name="eye" size={11} /> Buka kasus</a>
                  <button class="btn btn-ghost btn-xs" onclick={() => unlinkCase(ref.id)} title="Lepas kasus ini dari proyek"><Icon name="x" size={11} /></button>
                {:else if ref?.source === 'jira' && !isDone(r)}
                  <button class="btn btn-xs" onclick={() => traceTicket(r)} title="Buat kasus Bug Tracing dari tiket ini: analisa AI, lalu fix oleh agent"><Icon name="bug" size={11} /> Trace bug</button>
                {/if}
              </td>
            </tr>
          {/each}
          {#if !visibleRows.length}
            <tr><td colspan="5" class="no-match muted">{#if loading}Memuat status Jira dan MR…{:else}Tidak ada task yang cocok.{/if} <button class="link-btn" onclick={() => { query = ''; rowFilter = 'all'; boardFilter.jiraStatus = ''; }}>Reset pencarian</button></td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .ops {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    overflow-y: auto;
    padding: 16px 22px 24px;
    box-sizing: border-box;
  }
  .ops-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .ops-head h2 {
    margin: 0;
    font-size: 19px;
    font-weight: 500;
  }
  .ops-head p {
    margin: 2px 0 0;
    max-width: 720px;
  }
  .head-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }
  .active-btn {
    border-color: var(--accent);
    color: var(--accent);
  }
  .small {
    font-size: 12.5px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
  }
  .sources {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: 18px;
    padding: 14px 16px;
  }
  .source {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .source h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 13.5px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-2);
  }
  .inline {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .days {
    width: 80px;
  }
  .types {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .pill {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .pill.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .pill:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: 6px;
  }
  .grow {
    flex: 1;
  }
  .cases {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 200px;
    overflow-y: auto;
  }
  .case {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 8px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .case:hover {
    background: var(--surface-hover);
  }
  .case.on {
    background: var(--accent-soft);
  }
  .case-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    color: var(--text-3);
  }
  .title-in {
    flex: 1;
    min-width: 180px;
  }
  .repo-in,
  .key-in {
    width: 160px;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 32px;
    text-align: center;
    color: var(--text-2);
  }
  .empty p {
    margin: 0;
    max-width: 460px;
  }
  .stats {
    display: grid;
    grid-template-columns: minmax(180px, 1.6fr) repeat(5, minmax(100px, 1fr));
    gap: 10px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
  }
  .stat-label {
    font-size: 11.5px;
    color: var(--text-3);
  }
  .stat-value {
    font-size: 20px;
    font-weight: 600;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }
  .stat-progress {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .stat-progress .stat-value,
  .stat-info .stat-value {
    color: var(--accent);
  }
  .stat-bar {
    height: 5px;
    margin-top: 4px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    overflow: hidden;
  }
  .stat-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 0.3s ease;
  }
  .stat-ok .stat-value {
    color: var(--ok);
  }
  .stat-warn {
    background: var(--warn-soft);
    border-color: color-mix(in srgb, var(--warn) 30%, transparent);
  }
  .stat-warn .stat-value {
    color: var(--warn);
  }
  .note {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
  .err {
    color: var(--err);
  }
  .table-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 240px;
    max-width: 420px;
    padding: 0 12px;
    height: 34px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-3);
  }
  .search:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 13px;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .filters button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-2);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }
  .filters button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }
  .filters .count {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 11px;
  }
  .filters button.active .count {
    background: color-mix(in srgb, var(--accent-text) 22%, transparent);
    color: var(--accent-text);
  }
  .shown {
    margin-left: auto;
  }
  .status-select {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 4px 0 11px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12.5px;
  }
  .status-select.on {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }
  .status-select select {
    border: none;
    outline: none;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    max-width: 200px;
    cursor: pointer;
  }
  .table-wrap {
    max-height: 64vh;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    position: sticky;
    top: 0;
    z-index: 2;
    padding: 10px 12px;
    background: var(--surface-2);
    color: var(--text-2);
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
  }
  td {
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    vertical-align: top;
  }
  tbody tr:hover td {
    background: var(--surface-hover);
  }
  .task {
    min-width: 260px;
  }
  .task .title {
    display: block;
    font-weight: 500;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 3px;
  }
  .src {
    padding: 0 7px;
    border-radius: 999px;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .src-jira {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .src-bug {
    background: var(--err-soft);
    color: var(--err);
  }
  .src-manual {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .flag {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 4px;
    font-size: 11.5px;
  }
  .tone-warn {
    color: var(--warn);
  }
  .tone-err {
    color: var(--err);
  }
  .issue {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
  }
  .key {
    color: var(--accent);
    text-decoration: none;
    font-size: 12px;
  }
  .jstatus {
    padding: 1px 7px;
    border-radius: 4px;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    background: var(--surface-2);
    color: var(--text-2);
  }
  .jstatus.cat-indeterminate {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .jstatus.cat-done {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .mr {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin: 0 4px 4px 0;
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .mr-state {
    font-size: 10.5px;
    font-weight: 600;
  }
  .mr-state.st-merged {
    color: var(--ok);
  }
  .mr-state.st-opened {
    color: var(--accent);
  }
  .mr-state.st-closed {
    color: var(--text-3);
  }
  .mr-form {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .link-btn {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .stage {
    display: inline-block;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 500;
    white-space: nowrap;
  }
  .st-done {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .st-review {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .st-coding {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .st-todo {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .act {
    white-space: nowrap;
    text-align: right;
  }
  .act :global(.btn) {
    margin-left: 4px;
  }
  .btn-xs {
    padding: 2px 8px;
    font-size: 11.5px;
    gap: 4px;
  }
  .input-xs {
    width: 200px;
    padding: 3px 7px;
    font-size: 11.5px;
  }
  .no-match {
    padding: 24px 12px;
    text-align: center;
  }
  @media (max-width: 1100px) {
    .stats {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .sources {
      grid-template-columns: 1fr;
    }
  }
</style>
