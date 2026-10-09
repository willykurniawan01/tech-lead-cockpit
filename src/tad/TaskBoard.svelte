<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { gitlab, OPEN_MR_KEY } from '../lib/gitlab/client';
  import type { MrSummary } from '../lib/gitlab/types';
  import { jira } from '../lib/jira/client';
  import type { JiraIssue } from '../lib/jira/types';
  import { coder } from '../lib/coder/client';
  import type { CoderRun, CoderState } from '../lib/coder/types';
  import { parseScopeTasks, type ScopeTask } from '../lib/tad/task-links';
  import { tasksWithoutTicket } from '../lib/tad/tad-tickets';
  import {
    applyTaskPeaks,
    calculateTadDevProgress,
    getPeakDevPercent,
    savePeakDevPercent,
    type DevStage,
  } from '../lib/tad/progress-report';
  import { loadTaskPeaks, recordTaskPeaks } from '../lib/tad/task-peaks';
  import { boardFilter, matchesJiraStatus, statusOptions } from '../lib/projects/board-filter.svelte';
  import { drafts, type Draft } from './drafts.svelte';
  import { toasts } from '../components/toast.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import {
    TAD_DOCUMENT_STATES,
    extractDocumentState,
    updateDocumentState,
    getNextDocumentState,
    type DocumentStateDef,
  } from '../lib/tad/document-state';
  import { syncTadToConfluence } from '../lib/confluence/sync';
  import { validateTad } from '../lib/tad/validator';
  import PublishDialog from './PublishDialog.svelte';
  import JiraTicketsDialog from './JiraTicketsDialog.svelte';
  import type { JiraTransition } from '../lib/jira/types';
  import StartAgentsDialog from '../coder/StartAgentsDialog.svelte';
  import AgentRunsPanel from '../coder/AgentRunsPanel.svelte';

  let { draft }: { draft: Draft } = $props();

  // Confluence Document State
  const docState = $derived(extractDocumentState(draft.markdown));
  const currentStatus = $derived(docState.state);
  const currentDef = $derived(docState.def);
  const nextDef = $derived(getNextDocumentState(currentStatus));

  let isShifting = $state(false);
  let isSyncing = $state(false);
  let statusMenuOpen = $state(false);
  let publishOpen = $state(false);
  let ticketsOpen = $state(false);
  const validation = $derived(validateTad(draft.markdown));

  async function shiftConfluenceStatus(targetState: string) {
    if (targetState.trim().toLowerCase() === currentStatus.trim().toLowerCase()) return;
    statusMenuOpen = false;
    const isLinked = Boolean(draft.confluence.pageId);

    if (isLinked) {
      const ok = await confirmDialog({
        title: `Geser Status ke ${targetState}?`,
        message: [
          `Status dokumen TAD akan diubah dari "${currentStatus}" ke "${targetState}".`,
          `Halaman Confluence (v${draft.confluence.version || 1}) akan disinkronkan otomatis.`,
        ].join('\n\n'),
        confirmText: `Ya, Geser ke ${targetState}`,
        cancelText: 'Batal',
      });
      if (!ok) return;
    }

    isShifting = true;
    try {
      const updatedMd = updateDocumentState(draft.markdown, targetState, true);
      drafts.applyRevision(draft.id, updatedMd, `Ubah status Confluence ke ${targetState}`);

      if (isLinked) {
        try {
          isSyncing = true;
          const res = await syncTadToConfluence(draft, `Geser status TAD ke ${targetState}`);
          toasts.show(`Status Confluence diubah ke ${targetState} (v${res.version}).`, 'ok');
        } catch (syncErr) {
          toasts.show(
            `Status lokal diubah ke ${targetState}. Gagal sync ke Confluence: ${(syncErr as Error).message}`,
            'err'
          );
        } finally {
          isSyncing = false;
        }
      } else {
        toasts.show(`Status dokumen TAD lokal diubah ke ${targetState}.`, 'ok');
      }
    } finally {
      isShifting = false;
    }
  }

  async function handleManualSync() {
    if (!draft.confluence.pageId) {
      publishOpen = true;
      return;
    }
    isSyncing = true;
    try {
      const res = await syncTadToConfluence(draft, `Sync status TAD (${currentStatus}) dari Task Board`);
      toasts.show(`Halaman Confluence berhasil disinkronkan ke versi ${res.version}.`, 'ok');
    } catch (err) {
      toasts.show(`Gagal sync Confluence: ${(err as Error).message}`, 'err');
    } finally {
      isSyncing = false;
    }
  }

  // Interactive Jira Transitions in Task Board table
  let jiraTransitions = $state<Record<string, JiraTransition[]>>({});
  let loadingTransitions = $state<Record<string, boolean>>({});
  let movingJira = $state<Record<string, boolean>>({});
  let activeJiraMenu = $state<string | null>(null);

  async function toggleJiraTransitions(key: string, e: MouseEvent) {
    e.stopPropagation();
    if (activeJiraMenu === key) {
      activeJiraMenu = null;
      return;
    }
    activeJiraMenu = key;
    if (!jiraTransitions[key] && !loadingTransitions[key]) {
      loadingTransitions[key] = true;
      try {
        jiraTransitions[key] = await jira.transitions(key);
      } catch {
        jiraTransitions[key] = [];
      } finally {
        loadingTransitions[key] = false;
      }
    }
  }

  async function moveJiraIssue(key: string, t: JiraTransition) {
    activeJiraMenu = null;
    const issue = issues[key];
    const ok = await confirmDialog({
      title: `Pindahkan status tiket ${key}?`,
      message: `Tiket ${key} akan dipindahkan ke "${t.to.name}" (transisi "${t.name}").`,
      confirmText: `Pindahkan ke ${t.to.name}`,
      cancelText: 'Batal',
    });
    if (!ok) return;

    movingJira[key] = true;
    try {
      const res = await jira.transition(key, t.id, {
        mrUrl: draft.source?.mrUrl,
        expectedStatus: issue?.status,
      });
      toasts.show(`${key}: ${res.from ?? issue?.status} → ${res.to ?? t.to.name}`, 'ok');
      // Refresh issue
      const updated = await jira.issue(key);
      issues = { ...issues, [key]: updated };
      // Refresh transitions
      jiraTransitions[key] = await jira.transitions(key);
    } catch (err) {
      toasts.show(`Gagal memindahkan ${key}: ${(err as Error).message}`, 'err');
    } finally {
      movingJira[key] = false;
    }
  }

  // Tasks picked for coding agents.
  let selected = $state<Set<string>>(new Set());
  let agentsOpen = $state(false);
  let agentsRefresh = $state(0);

  let coderState = $state<CoderState | null>(null);
  async function loadCoderState() {
    try {
      coderState = await coder.state();
    } catch {
      /* ignore */
    }
  }

  async function markRunCompleted(run: CoderRun) {
    const ok = await confirmDialog({
      title: 'Tandai Selesai',
      message: `Tandai task "${run.taskTitle}" sebagai selesai (MR sudah merged)?`,
      confirmText: 'Tandai Selesai',
    });
    if (!ok) return;
    try {
      await coder.complete(run.id, 'Ditandai selesai (MR sudah merged).');
      toasts.show('Task ditandai selesai.', 'ok');
      await loadCoderState();
      await refresh();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  type BoardViewMode = 'split' | 'table' | 'agents';
  const BOARD_VIEW_KEY = 'tlc.tad.boardView';
  let boardView = $state<BoardViewMode>(
    (typeof localStorage !== 'undefined' && (localStorage.getItem(BOARD_VIEW_KEY) as BoardViewMode)) || 'split'
  );

  function setBoardView(mode: BoardViewMode) {
    boardView = mode;
    try {
      localStorage.setItem(BOARD_VIEW_KEY, mode);
    } catch {
      /* ignore */
    }
  }

  const draftRuns = $derived((coderState?.runs ?? []).filter((r) => r.draftId === draft.id));
  const activeRuns = $derived(draftRuns.filter((r) => ['preparing', 'running', 'testing'].includes(r.status)));

  $effect(() => {
    void agentsRefresh;
    void loadCoderState();
    const t = setInterval(loadCoderState, 4000);
    return () => clearInterval(t);
  });

  function toggleTask(title: string) {
    const next = new Set(selected);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    selected = next;
  }

  const tasks = $derived(parseScopeTasks(draft.markdown, draft.scopePlan));
  const keys = $derived([...new Set(tasks.flatMap((t) => t.jiraKeys))]);
  // Rencana Scope rows are not in the TAD yet, so only real Development Scope rows count.
  const withoutTicket = $derived(tasksWithoutTicket(draft.markdown).length);
  const selectedTasks = $derived(tasks.filter((t) => selected.has(t.title)));

  let issues = $state<Record<string, JiraIssue>>({});
  let mrs = $state<Record<string, MrSummary[]>>({});
  let jiraError = $state('');
  let gitlabError = $state('');
  /** MR-based warnings only make sense once GitLab actually answered. */
  let mrsLoaded = $state(false);
  let loading = $state(false);
  let loadedFor = '';
  let jiraBase = $state<string | undefined>();

  $effect(() => {
    const sig = `${draft.id}:${keys.join(',')}`;
    if (sig !== loadedFor) {
      loadedFor = sig;
      untrack(() => {
        void refresh(sig);
      });
    }
  });

  async function refresh(sig = `${draft.id}:${keys.join(',')}`) {
    loadedFor = sig;
    if (!keys.length) return;
    loading = true;
    jiraError = '';
    gitlabError = '';
    await Promise.all([
      jira
        .issues(`key in (${keys.join(',')})`, Math.max(keys.length, 25))
        .then((list) => (issues = Object.fromEntries(list.map((i) => [i.key, i]))))
        .catch((e) => (jiraError = (e as Error).message)),
      gitlab
        .mrsForKeys(keys)
        .then((m) => {
          mrs = m;
          mrsLoaded = true;
        })
        .catch((e) => {
          gitlabError = (e as Error).message;
          mrsLoaded = false;
        }),
      jira
        .status()
        .then((s) => (jiraBase = s.configured ? s.baseUrl : undefined))
        .catch(() => {}),
    ]);
    loading = false;
  }

  type Flag = { tone: 'warn' | 'err' | 'info'; text: string };

  /** What needs attention for a task, from its Jira status and MR states. */
  function flagsOf(t: ScopeTask): Flag[] {
    const flags: Flag[] = [];
    if (!t.jiraKeys.length) return [{ tone: 'warn', text: 'Belum ada Jira key di kolom Jira Task' }];
    const taskMrs = t.jiraKeys.flatMap((k) => mrs[k] ?? []);
    const open = taskMrs.filter((m) => m.state === 'opened');
    const merged = taskMrs.filter((m) => m.state === 'merged');
    for (const k of t.jiraKeys) {
      const issue = issues[k];
      if (!issue) continue;
      const done = issue.statusCategory === 'done';
      const reviewish = /review|qa|test|uat/i.test(issue.status);
      if (!mrsLoaded) continue;
      if (done && open.length) flags.push({ tone: 'warn', text: `${k} sudah ${issue.status}, tapi masih ada MR terbuka` });
      if (!done && merged.length && !open.length) flags.push({ tone: 'warn', text: `MR sudah merged, ${k} masih ${issue.status}` });
      if (reviewish && !taskMrs.length) flags.push({ tone: 'err', text: `${k} berstatus ${issue.status}, tapi belum ada MR` });
      if (done && !taskMrs.length) flags.push({ tone: 'warn', text: `${k} sudah ${issue.status} di Jira, tapi MR-nya tidak terdeteksi (tambahkan MR manual)` });
      if (issue.statusCategory === 'indeterminate' && !taskMrs.length && !reviewish) flags.push({ tone: 'info', text: 'Sedang dikerjakan, belum ada MR' });
    }
    if (open.some((m) => m.hasConflicts)) flags.push({ tone: 'err', text: 'MR punya konflik' });
    return flags;
  }

  const rawRows = $derived(
    tasks.map((t) => {
      const run = coderState?.runs.find((x) => x.draftId === draft.id && x.taskTitle === t.title);
      return {
        task: t,
        issues: t.jiraKeys.map((k) => ({ key: k, issue: issues[k] })),
        mrs: t.jiraKeys.flatMap((k) => mrs[k] ?? []).filter((m, i, a) => a.findIndex((x) => x.ref === m.ref) === i),
        flags: flagsOf(t),
        run,
      };
    }),
  );

  // Every task is held at the furthest stage it ever reached (a task QA sends back keeps its progress).
  let taskPeaks = $state<Record<string, DevStage>>({});
  $effect(() => {
    void draft.id;
    loadTaskPeaks().then((p) => (taskPeaks = p));
  });
  const peaked = $derived(applyTaskPeaks(draft.id, rawRows, taskPeaks));
  const rows = $derived(peaked.rows);
  $effect(() => {
    const raised = peaked.raised;
    if (Object.keys(raised).length) untrack(() => void recordTaskPeaks(raised).then(() => (taskPeaks = { ...taskPeaks, ...raised })));
  });

  const liveDevProgress = $derived(calculateTadDevProgress(rows));
  const devProgress = $derived(Math.max(getPeakDevPercent(draft.id), liveDevProgress));

  $effect(() => {
    if (liveDevProgress > 0) {
      untrack(() => {
        savePeakDevPercent(draft.id, liveDevProgress);
      });
    }
  });

  const summary = $derived({
    tasks: rows.length,
    withMr: rows.filter((r) => r.mrs.length).length,
    merged: rows.filter((r) => r.mrs.length && r.mrs.every((m) => m.state === 'merged')).length,
    done: rows.filter((r) => r.issues.length && r.issues.every((i) => i.issue?.statusCategory === 'done')).length,
    attention: rows.filter((r) => r.flags.some((f) => f.tone !== 'info')).length,
  });

  // Search and quick filters over the task table.
  type RowFilter = 'all' | 'attention' | 'no-mr' | 'merged' | 'agent';
  let query = $state('');
  let rowFilter = $state<RowFilter>('all');
  type Row = (typeof rows)[number];
  const AGENT_LIVE = new Set(['queued', 'preparing', 'running', 'testing', 'ready', 'needs-input']);
  const FILTERS: { id: RowFilter; label: string; test: (r: Row) => boolean }[] = [
    { id: 'all', label: 'Semua', test: () => true },
    { id: 'attention', label: 'Perlu perhatian', test: (r) => r.flags.some((f) => f.tone !== 'info') },
    { id: 'no-mr', label: 'Belum ada MR', test: (r) => !r.mrs.length },
    { id: 'merged', label: 'Merged', test: (r) => r.mrs.length > 0 && r.mrs.every((m) => m.state === 'merged') },
    { id: 'agent', label: 'Ada agent', test: (r) => Boolean(r.run && AGENT_LIVE.has(r.run.status)) },
  ];
  const filterCount = $derived(Object.fromEntries(FILTERS.map((f) => [f.id, rows.filter(f.test).length])) as Record<RowFilter, number>);
  /** Everything a row can be found by: title, service, Jira key/status/assignee, MR, agent branch. */
  const haystack = (r: Row) =>
    [
      r.task.title,
      r.task.service,
      ...r.issues.flatMap(({ key, issue }) => [key, issue?.status, issue?.assignee?.displayName]),
      ...r.mrs.flatMap((m) => [m.title, `${m.projectPath.split('/').pop()}!${m.iid}`, m.sourceBranch]),
      r.run?.branch,
    ]
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

  /** Task whose "add MR by hand" form is open, and its input. */
  let manualFor = $state<string | null>(null);
  let manualKey = $state('');
  let manualUrl = $state('');
  let manualBusy = $state(false);
  let manualError = $state('');

  function startManual(t: ScopeTask) {
    manualFor = t.title;
    manualKey = t.jiraKeys[0] ?? '';
    manualUrl = '';
    manualError = '';
  }

  async function saveManual() {
    if (!manualKey || !manualUrl.trim()) return;
    manualBusy = true;
    manualError = '';
    try {
      await gitlab.addManualMr(manualKey, manualUrl.trim());
      manualFor = null;
      toasts.show('MR ditautkan ke task; progres dihitung ulang.', 'ok');
      await refresh();
    } catch (e) {
      manualError = (e as Error).message;
    } finally {
      manualBusy = false;
    }
  }

  async function removeManual(t: ScopeTask, m: MrSummary) {
    const key = t.jiraKeys.find((k) => (mrs[k] ?? []).some((x) => x.ref === m.ref && x.manual));
    if (!key) return;
    const ok = await confirmDialog({ title: 'Lepas MR manual?', message: `Lepas ${m.projectPath.split('/').pop()}!${m.iid} dari ${key}? MR-nya sendiri tidak berubah.`, confirmText: 'Lepas' });
    if (!ok) return;
    try {
      await gitlab.removeManualMr(key, m.ref);
      await refresh();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
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

  const stateLabel: Record<MrSummary['state'], string> = { opened: 'open', merged: 'merged', closed: 'closed', locked: 'locked' };
</script>

<svelte:window onclick={() => { statusMenuOpen = false; activeJiraMenu = null; }} />

<div class="board view-{boardView}">
  <header class="board-head">
    <div>
      <h2>Task Board</h2>
      <p class="muted small">Tiap task di Development Scope, tiket Jira-nya, dan MR yang menyebut key tersebut (branch/judul/deskripsi).</p>
    </div>
    <div class="head-actions">
      <div class="segmented segmented-view" role="group" aria-label="Tampilan Task Board">
        <button
          type="button"
          class:active={boardView === 'split'}
          onclick={() => setBoardView('split')}
          title="Tampilkan Tabel Task dan Agent bersamaan (Split independen)"
        >
          <Icon name="split" size={13} />
          <span>Split</span>
        </button>
        <button
          type="button"
          class:active={boardView === 'table'}
          onclick={() => setBoardView('table')}
          title="Fokus Tabel Task TAD saja (layar penuh)"
        >
          <Icon name="table" size={13} />
          <span>Tabel ({tasks.length})</span>
        </button>
        <button
          type="button"
          class:active={boardView === 'agents'}
          onclick={() => setBoardView('agents')}
          title="Fokus Daftar Agent Runs saja (layar penuh)"
        >
          <Icon name="sparkles" size={13} />
          <span>Agent ({draftRuns.length})</span>
          {#if activeRuns.length}
            <span class="dot-pulse"></span>
          {/if}
        </button>
      </div>
      {#if withoutTicket}
        <button class="btn btn-sm" onclick={() => (ticketsOpen = true)} title="Task di Development Scope yang belum punya tiket Jira">
          <Icon name="jira" size={13} /> Buat tiket Jira ({withoutTicket})
        </button>
      {/if}
      <button class="btn btn-sm" onclick={() => (agentsOpen = true)} disabled={!selectedTasks.length} title="Centang task di tabel dulu">
        <Icon name="sparkles" size={13} /> Kerjakan dengan agent{selectedTasks.length ? ` (${selectedTasks.length})` : ''}
      </button>
      <button class="btn btn-sm" onclick={() => refresh()} disabled={loading || !keys.length}>
        <Icon name="refresh" size={13} /> {loading ? 'Memuat…' : 'Muat ulang'}
      </button>
    </div>
  </header>

  <!-- Confluence Document Status Bar -->
  <div class="confluence-status-bar">
    <div class="cs-main">
      <div class="cs-info">
        <span class="cs-tag">
          <Icon name="confluence" size={14} />
          <strong>Status Confluence:</strong>
        </span>
        <span class="lozenge lozenge-{currentDef ? currentDef.colour.toLowerCase() : 'grey'} cs-status-badge">
          {currentStatus}
        </span>
        {#if draft.confluence.pageId}
          <a
            class="confluence-badge"
            href={draft.confluence.url}
            target="_blank"
            rel="noreferrer"
            title="Buka halaman Confluence (space: {draft.confluence.spaceKey})"
          >
            <span class="mono">v{draft.confluence.version ?? 1}</span>
            <Icon name="external" size={11} />
          </a>
        {:else}
          <span class="cs-unlinked muted small">(Draft lokal)</span>
        {/if}
      </div>

      <!-- Pipeline Stepper -->
      <div class="cs-stepper" role="group" aria-label="Alur Status Confluence">
        {#each TAD_DOCUMENT_STATES as st, i (st.id)}
          {#if i > 0}
            <span class="step-arrow" class:done={currentDef && currentDef.step > st.step}>→</span>
          {/if}
          <button
            type="button"
            class="step-node"
            class:active={currentDef?.id === st.id}
            class:done={currentDef && currentDef.step > st.step}
            onclick={() => shiftConfluenceStatus(st.name)}
            disabled={isShifting || isSyncing}
            title="{st.name}: {st.description}"
          >
            <span class="step-num">{st.step}</span>
            <span class="step-label">{st.name}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Actions -->
    <div class="cs-controls">
      {#if nextDef}
        <button
          type="button"
          class="btn btn-sm btn-primary btn-advance"
          onclick={() => shiftConfluenceStatus(nextDef.name)}
          disabled={isShifting || isSyncing}
          title="Geser status ke tahap berikutnya: {nextDef.name}"
        >
          <span>Geser ke {nextDef.name}</span>
          <Icon name="chevron" size={12} />
        </button>
      {/if}

      <div class="status-dropdown">
        <button
          type="button"
          class="btn btn-sm"
          onclick={(e) => {
            e.stopPropagation();
            statusMenuOpen = !statusMenuOpen;
          }}
          disabled={isShifting || isSyncing}
          title="Pilih status Confluence manual"
        >
          <span>Pilih Status</span>
          <Icon name="chevron" size={11} />
        </button>
        {#if statusMenuOpen}
          <div
            class="status-menu"
            role="menu"
            tabindex="-1"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.stopPropagation()}
          >
            <div class="menu-header">Geser Status Confluence</div>
            {#each TAD_DOCUMENT_STATES as st}
              <button
                type="button"
                class="menu-option"
                class:active={currentDef?.id === st.id}
                onclick={() => shiftConfluenceStatus(st.name)}
              >
                <span class="lozenge lozenge-{st.colour.toLowerCase()}">{st.name}</span>
                <span class="option-desc">{st.label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      {#if draft.confluence.pageId}
        <button
          type="button"
          class="btn btn-sm btn-sync"
          onclick={handleManualSync}
          disabled={isSyncing || isShifting}
          title="Sinkronkan dokumen dan status ini langsung ke halaman Confluence"
        >
          <Icon name={isSyncing ? 'refresh' : 'upload'} size={12} />
          <span>{isSyncing ? 'Syncing…' : 'Sync Confluence'}</span>
        </button>
      {:else}
        <button
          type="button"
          class="btn btn-sm"
          onclick={() => (publishOpen = true)}
          title="Publish dokumen ini ke Confluence"
        >
          <Icon name="upload" size={12} />
          <span>Publish ke Confluence</span>
        </button>
      {/if}
    </div>
  </div>

  <div class="board-body">
    {#if boardView === 'split' || boardView === 'table'}
      <section class="task-pane" class:pane-full={boardView === 'table'}>
        {#if !tasks.length}
          <p class="empty muted">Development Scope di TAD ini belum berisi tabel task.</p>
        {:else}
          <div class="stats">
            <div class="stat stat-progress">
              <span class="stat-label">Dev Progress</span>
              <strong class="stat-value">{devProgress}%</strong>
              <span class="stat-bar"><span style="width: {Math.min(100, devProgress)}%"></span></span>
            </div>
            <div class="stat"><span class="stat-label">Task</span><strong class="stat-value">{summary.tasks}</strong></div>
            <div class="stat stat-ok"><span class="stat-label">MR merged</span><strong class="stat-value">{summary.merged}</strong></div>
            <div class="stat stat-info"><span class="stat-label">Punya MR</span><strong class="stat-value">{summary.withMr}</strong></div>
            <div class="stat stat-ok"><span class="stat-label">Jira selesai</span><strong class="stat-value">{summary.done}</strong></div>
            <div class="stat" class:stat-warn={summary.attention > 0}><span class="stat-label">Perlu perhatian</span><strong class="stat-value">{summary.attention}</strong></div>
          </div>
          {#if jiraError}<p class="note err small"><Icon name="alert" size={13} /> Jira: {jiraError}</p>{/if}
          {#if gitlabError}<p class="note err small"><Icon name="alert" size={13} /> GitLab: {gitlabError}</p>{/if}

          <div class="table-toolbar">
            <label class="search">
              <Icon name="search" size={14} />
              <input type="search" bind:value={query} placeholder="Cari task, service, Jira key, status, assignee, MR…" aria-label="Cari task" />
            </label>
            <div class="filters" role="group" aria-label="Filter task">
              {#each FILTERS as f (f.id)}
                <button type="button" class:active={rowFilter === f.id} aria-pressed={rowFilter === f.id} onclick={() => (rowFilter = f.id)}>
                  {f.label} <span class="count">{filterCount[f.id]}</span>
                </button>
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
              <thead>
                <tr><th class="pick"><span class="sr-only">Pilih</span></th><th>Task</th><th>Jira</th><th>MR</th><th>Perhatian</th></tr>
              </thead>
              <tbody>
                {#each visibleRows as r (r.task.title)}
                  <tr class:picked={selected.has(r.task.title)}>
                    <td class="pick"><input type="checkbox" checked={selected.has(r.task.title)} onchange={() => toggleTask(r.task.title)} aria-label="Pilih {r.task.title}" /></td>
                    <td class="task">
                      <span class="title">{r.task.title}</span>
                      <span class="muted small">{r.task.service || '—'}</span>
                      {#if r.run}
                        <div class="task-agent-badge">
                          {#if r.run.status === 'running'}
                            <span class="agent-chip chip-running"><span class="dot-pulse"></span> Agent bekerja</span>
                          {:else if r.run.status === 'testing'}
                            <span class="agent-chip chip-running">🧪 Menjalankan test</span>
                          {:else if r.run.status === 'ready'}
                            <span class="agent-chip chip-ready">✅ Siap direview</span>
                          {:else if r.run.status === 'pushed'}
                            <span class="agent-chip chip-ready">🚀 MR di-push</span>
                          {:else if r.run.status === 'completed'}
                            <span class="agent-chip chip-completed">✅ Selesai</span>
                          {:else if r.run.status === 'needs-input'}
                            <span class="agent-chip chip-warn">⚠️ Butuh klarifikasi</span>
                          {:else if r.run.status === 'failed'}
                            <span class="agent-chip chip-err">❌ Gagal</span>
                          {:else if r.run.status === 'queued'}
                            <span class="agent-chip chip-queued">Antre agent</span>
                          {/if}
                          <span class="agent-branch mono">{r.run.branch}</span>
                          {#if r.run.aiReview?.verdict === 'APPROVE'}
                            <span class="agent-chip chip-verdict-ok" title="AI Code Review: APPROVE">✅ AI: Approve</span>
                          {:else if r.run.aiReview?.verdict === 'APPROVE_WITH_COMMENTS'}
                            <span class="agent-chip chip-verdict-info" title="AI Code Review: APPROVE WITH COMMENTS">ℹ️ AI: Comments</span>
                          {:else if r.run.aiReview?.verdict === 'REQUEST_CHANGES'}
                            <span class="agent-chip chip-verdict-err" title="AI Code Review: REQUEST CHANGES">⚠️ AI: Revisi</span>
                          {/if}
                          {#if r.run.status === 'ready' || r.run.status === 'pushed'}
                            <button
                              type="button"
                              class="btn-complete-run"
                              onclick={() => markRunCompleted(r.run!)}
                              title="Tandai task ini selesai (MR sudah merged)"
                            >
                              <Icon name="check" size={10} />
                              <span>Tandai selesai</span>
                            </button>
                          {/if}
                        </div>
                      {/if}
                    </td>
                    <td>
                      {#each r.issues as { key, issue } (key)}
                        <div class="issue">
                          {#if jiraBase}
                            <a class="mono key" href="{jiraBase}/browse/{key}" target="_blank" rel="noreferrer">{key}</a>
                          {:else}
                            <span class="mono key">{key}</span>
                          {/if}
                          {#if issue}
                            <div class="jira-status-wrap">
                              <button
                                type="button"
                                class="status-btn cat-{issue.statusCategory ?? 'new'}"
                                onclick={(e) => toggleJiraTransitions(key, e)}
                                disabled={movingJira[key]}
                                title="Klik untuk menggeser status tiket Jira {key}"
                              >
                                <span>{movingJira[key] ? 'Memindahkan…' : issue.status}</span>
                                <Icon name="chevron" size={10} />
                              </button>
                              {#if activeJiraMenu === key}
                                <div
                                  class="jira-trans-menu"
                                  role="menu"
                                  tabindex="-1"
                                  onclick={(e) => e.stopPropagation()}
                                  onkeydown={(e) => e.stopPropagation()}
                                >
                                  <div class="jira-trans-title">Geser Status {key}:</div>
                                  {#if loadingTransitions[key]}
                                    <div class="muted small" style="padding: 4px 6px;">Memuat transisi…</div>
                                  {:else if !jiraTransitions[key]?.length}
                                    <div class="muted small" style="padding: 4px 6px;">Tidak ada transisi tersedia</div>
                                  {:else}
                                    {#each jiraTransitions[key] as t (t.id)}
                                      <button
                                        type="button"
                                        class="jira-trans-item"
                                        onclick={() => moveJiraIssue(key, t)}
                                      >
                                        <span class="trans-to">{t.to.name}</span>
                                        <span class="trans-name muted small">({t.name})</span>
                                      </button>
                                    {/each}
                                  {/if}
                                </div>
                              {/if}
                            </div>
                            {#if issue.assignee}<span class="muted small">{issue.assignee.displayName}</span>{/if}
                          {:else if loading}
                            <span class="muted small">…</span>
                          {/if}
                        </div>
                      {:else}
                        <span class="muted small">—</span>
                      {/each}
                    </td>
                    <td>
                      {#each r.mrs as m (m.ref)}
                        <span class="mr-wrap">
                          <button class="mr" onclick={() => openMr(m)} title="Buka di MR Review: {m.title}">
                            <span class="mono">{m.projectPath.split('/').pop()}!{m.iid}</span>
                            <span class="mr-state st-{m.state}">{m.draft && m.state === 'opened' ? 'draft' : stateLabel[m.state]}</span>
                            {#if m.manual}<span class="mr-manual" title="Ditautkan manual">manual</span>{/if}
                          </button>
                          {#if m.manual}
                            <button class="mr-unlink" onclick={() => removeManual(r.task, m)} title="Lepas MR manual" aria-label="Lepas MR manual {m.iid}"><Icon name="x" size={10} /></button>
                          {/if}
                        </span>
                      {:else}
                        <span class="muted small">{loading ? '…' : '—'}</span>
                      {/each}
                      {#if r.task.jiraKeys.length}
                        {#if manualFor === r.task.title}
                          <form class="manual-form" onsubmit={(e) => { e.preventDefault(); void saveManual(); }}>
                            {#if r.task.jiraKeys.length > 1}
                              <select class="input input-xs" bind:value={manualKey} aria-label="Jira key">
                                {#each r.task.jiraKeys as k (k)}<option value={k}>{k}</option>{/each}
                              </select>
                            {/if}
                            <!-- svelte-ignore a11y_autofocus -->
                            <input class="input input-xs mono" bind:value={manualUrl} placeholder="Link MR GitLab" autofocus aria-label="Link MR" />
                            <button class="btn btn-primary btn-xs" type="submit" disabled={manualBusy || !manualUrl.trim()}>{manualBusy ? '…' : 'Tautkan'}</button>
                            <button class="btn btn-ghost btn-xs" type="button" onclick={() => (manualFor = null)}>Batal</button>
                            {#if manualError}<span class="manual-err">{manualError}</span>{/if}
                          </form>
                        {:else}
                          <button class="link-btn" onclick={() => startManual(r.task)} title="MR tidak terdeteksi otomatis? Tautkan link MR-nya manual">+ MR manual</button>
                        {/if}
                      {/if}
                    </td>
                    <td>
                      {#each r.flags as f, i (i)}
                        <div class="flag tone-{f.tone}"><Icon name={f.tone === 'info' ? 'clock' : 'alert'} size={12} /> {f.text}</div>
                      {:else}
                        {#if !mrsLoaded}
                          <span class="muted small">{gitlabError ? 'MR belum dicek (GitLab tidak terjangkau)' : loading ? '…' : 'MR belum dicek'}</span>
                        {:else if r.mrs.length || r.issues.some((i) => i.issue)}
                          <span class="ok small"><Icon name="check" size={12} /> OK</span>
                        {/if}
                      {/each}
                    </td>
                  </tr>
                {/each}
                {#if !visibleRows.length}
                  <tr><td colspan="5" class="no-match muted">{#if loading}Memuat status Jira dan MR…{:else}Tidak ada task yang cocok{query ? ` dengan "${query}"` : ''}.{/if} <button class="link-btn" onclick={() => { query = ''; rowFilter = 'all'; boardFilter.jiraStatus = ''; }}>Reset pencarian</button></td></tr>
                {/if}
              </tbody>
            </table>
          </div>
          <p class="muted small hint-text">Geser status Confluence di toolbar atas, atau klik status tiket Jira untuk memindahkan status tiket. Klik MR untuk membukanya di MR Review. Progres dihitung dari MR (merged = selesai); MR yang tidak terdeteksi bisa ditautkan lewat <strong>+ MR manual</strong>.</p>
        {/if}
      </section>
    {/if}

    {#if boardView === 'split'}
      <div class="board-divider">
        <span class="divider-line"></span>
        <span class="divider-badge">
          <Icon name="sparkles" size={12} />
          <span>Agent Runs ({draftRuns.length})</span>
          {#if activeRuns.length}
            <span class="chip-active-dot"><span class="dot-pulse"></span> {activeRuns.length} aktif</span>
          {/if}
        </span>
        <span class="divider-line"></span>
      </div>
    {/if}

    {#if boardView === 'split' || boardView === 'agents'}
      <section class="agents-pane" class:pane-full={boardView === 'agents'}>
        <AgentRunsPanel {draft} refreshKey={agentsRefresh} />
      </section>
    {/if}
  </div>
</div>

<StartAgentsDialog
  bind:open={agentsOpen}
  {draft}
  tasks={selectedTasks}
  {issues}
  onstarted={() => {
    selected = new Set();
    agentsRefresh++;
  }}
/>


<PublishDialog
  bind:open={publishOpen}
  {draft}
  {validation}
/>

<JiraTicketsDialog bind:open={ticketsOpen} {draft} />

<style>
  .board {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    overflow-y: auto;
    padding: 16px 22px 24px;
    box-sizing: border-box;
  }
  .board-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .segmented-view button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    padding: 4px 10px;
  }
  .board-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .task-pane {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .board-divider {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    padding: 2px 0;
    user-select: none;
  }
  .divider-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .divider-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .chip-active-dot {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 10.5px;
    font-weight: 600;
  }
  .agents-pane {
    padding: 14px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
  }
  .hint-text {
    flex-shrink: 0;
  }
  h2 {
    margin: 0;
    font-size: 19px;
    font-weight: 500;
  }
  .small {
    font-size: 12.5px;
  }
  p {
    margin: 0;
  }
  .empty {
    padding: 24px 0;
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
  .stat-progress .stat-value {
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
  .stat-info .stat-value {
    color: var(--accent);
  }
  .stat-warn {
    background: var(--warn-soft);
    border-color: color-mix(in srgb, var(--warn) 30%, transparent);
  }
  .stat-warn .stat-value {
    color: var(--warn);
  }
  @media (max-width: 1100px) {
    .stats {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
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
  .filters button:hover {
    border-color: var(--border-strong);
    color: var(--text);
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
    font-variant-numeric: tabular-nums;
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
  .no-match {
    padding: 24px 12px;
    text-align: center;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .err {
    color: var(--err);
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
    padding: 10px 12px;
    background: var(--surface-2);
    color: var(--text-2);
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
    position: sticky;
    top: 0;
    z-index: 2;
  }
  td {
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    vertical-align: top;
  }
  tbody tr {
    transition: background 0.12s ease;
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
  .task-agent-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 5px;
    flex-wrap: wrap;
  }
  .agent-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1.5px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
  }
  .chip-running {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .chip-ready {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .chip-completed {
    background: var(--ok-soft);
    color: var(--ok);
    font-weight: 600;
  }
  .chip-verdict-ok {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
    font-weight: 600;
  }
  .chip-verdict-info {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    font-weight: 600;
  }
  .chip-verdict-err {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
    font-weight: 600;
  }
  .btn-complete-run {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-2);
    font-size: 10.5px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-complete-run:hover {
    background: var(--ok-soft);
    color: var(--ok);
    border-color: rgba(46, 160, 67, 0.4);
  }
  .chip-warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .chip-err {
    background: var(--err-soft);
    color: var(--err);
  }
  .chip-queued {
    background: var(--surface-2);
    color: var(--text-3);
  }
  .agent-branch {
    font-size: 11px;
    color: var(--text-3);
  }
  .dot-pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    display: inline-block;
    animation: pulse 1.5s infinite ease-in-out;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(1.3); }
  }
  .issue {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 4px;
  }
  .key {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--accent);
    text-decoration: none;
  }
  .status {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 12px;
    white-space: nowrap;
  }
  .cat-indeterminate {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .cat-done {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .mr-wrap {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .mr-manual {
    font-size: 10px;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .mr-unlink {
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--muted, var(--text-2));
    cursor: pointer;
  }
  .mr-unlink:hover {
    background: var(--err-soft);
    color: var(--err);
  }
  .link-btn {
    display: block;
    margin-top: 2px;
    padding: 0;
    border: none;
    background: none;
    font: inherit;
    font-size: 11.5px;
    color: var(--accent);
    cursor: pointer;
    white-space: nowrap;
  }
  .manual-form {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
    max-width: 320px;
  }
  .manual-form .input-xs {
    flex: 1;
    min-width: 140px;
    padding: 3px 6px;
    font-size: 11.5px;
  }
  .btn-xs {
    padding: 2px 8px;
    font-size: 11.5px;
  }
  .manual-err {
    flex-basis: 100%;
    font-size: 11px;
    color: var(--err);
  }
  .mr {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    padding: 2px 8px 2px 0;
    border: 0;
    background: none;
    cursor: pointer;
    font-size: 12.5px;
    color: var(--text);
  }
  .mr:hover .mono {
    color: var(--accent);
    text-decoration: underline;
  }
  .mr-state {
    padding: 0 7px;
    border-radius: 999px;
    font-size: 11px;
    background: var(--surface-2);
  }
  .st-opened {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .st-merged {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .flag {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    margin-bottom: 4px;
    font-size: 12.5px;
  }
  .flag :global(svg) {
    margin-top: 3px;
  }
  .tone-warn {
    color: var(--warn);
  }
  .tone-err {
    color: var(--err);
  }
  .tone-info {
    color: var(--text-3);
  }
  .ok {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--ok);
  }
  .pick {
    width: 1%;
    padding-right: 0;
  }
  tr.picked td {
    background: var(--accent-soft);
  }

  /* Confluence Status Bar */
  .confluence-status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
    flex-wrap: wrap;
    flex-shrink: 0;
  }
  .cs-main {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .cs-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .cs-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--text-2);
  }
  .cs-status-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .confluence-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1.5px 7px;
    border-radius: 4px;
    background: var(--surface-2);
    color: var(--accent);
    font-size: 11px;
    text-decoration: none;
    border: 1px solid var(--border);
    transition: background 0.15s;
  }
  .confluence-badge:hover {
    background: var(--accent-soft);
  }
  .cs-stepper {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    background: var(--surface-2);
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  .step-node {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2.5px 8px;
    border-radius: 5px;
    border: 1px solid transparent;
    background: transparent;
    font-size: 11px;
    color: var(--text-3);
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }
  .step-node:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-1);
  }
  .step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    font-size: 9.5px;
    font-weight: 700;
    background: rgba(255, 255, 255, 0.08);
  }
  .step-node.active {
    background: var(--accent-soft);
    border-color: rgba(56, 139, 253, 0.4);
    color: var(--accent);
    font-weight: 600;
  }
  .step-node.active .step-num {
    background: var(--accent);
    color: #fff;
  }
  .step-node.done {
    color: var(--text-1);
  }
  .step-node.done .step-num {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .step-arrow {
    font-size: 10px;
    color: var(--text-3);
    opacity: 0.5;
    user-select: none;
  }
  .step-arrow.done {
    color: var(--ok);
    opacity: 0.8;
  }
  .cs-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .status-dropdown {
    position: relative;
  }
  .status-menu {
    position: absolute;
    top: calc(100% + 5px);
    right: 0;
    z-index: 60;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    min-width: 250px;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .menu-header {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-3);
    padding: 4px 8px 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .menu-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 10px;
    border-radius: 6px;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background 0.12s;
  }
  .menu-option:hover {
    background: var(--surface-2);
  }
  .menu-option.active {
    background: var(--accent-soft);
  }
  .option-desc {
    font-size: 11.5px;
    color: var(--text-2);
  }
  .btn-advance {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .btn-sync {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  /* Lozenge badges */
  .lozenge {
    display: inline-flex;
    align-items: center;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .lozenge-grey { background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border); }
  .lozenge-blue { background: rgba(56, 139, 253, 0.2); color: #58a6ff; border: 1px solid rgba(56, 139, 253, 0.3); }
  .lozenge-green { background: rgba(46, 160, 67, 0.2); color: #3fb950; border: 1px solid rgba(46, 160, 67, 0.3); }
  .lozenge-yellow { background: rgba(210, 153, 34, 0.2); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.3); }
  .lozenge-red { background: rgba(248, 81, 73, 0.2); color: #f85149; border: 1px solid rgba(248, 81, 73, 0.3); }

  /* Jira Status Popover in Table */
  .jira-status-wrap {
    position: relative;
    display: inline-block;
  }
  .status-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1.5px 7px;
    border-radius: 999px;
    font-size: 11.5px;
    border: 1px solid transparent;
    cursor: pointer;
    background: var(--surface-2);
    color: var(--text-1);
    transition: filter 0.15s;
  }
  .status-btn:hover:not(:disabled) {
    filter: brightness(1.15);
    border-color: rgba(255, 255, 255, 0.15);
  }
  .jira-trans-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 50;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 7px;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
    min-width: 180px;
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .jira-trans-title {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--text-3);
    padding: 3px 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 3px;
  }
  .jira-trans-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 5px;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-1);
    transition: background 0.12s;
  }
  .jira-trans-item:hover {
    background: var(--surface-2);
    color: var(--accent);
  }
</style>
