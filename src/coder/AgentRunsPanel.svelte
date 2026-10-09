<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import { toasts } from '../components/toast.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { coder } from '../lib/coder/client';
  import type { CoderProfileId, CoderRun, CoderRunStatus, CoderState } from '../lib/coder/types';
  import type { MrFileChange } from '../lib/gitlab/types';
  import { checkConformance, detailTaskSpec, parseScopeTasks, type ConformanceCheck } from '../lib/tad/task-links';
  import DiffFile from '../mr/DiffFile.svelte';
  import type { Draft } from '../tad/drafts.svelte';
  import { openExternal } from '../lib/open-external';
  import TadFlowUnitTestModal from './TadFlowUnitTestModal.svelte';
  import AgentDiffReviewModal from './AgentDiffReviewModal.svelte';

  let {
    draft,
    refreshKey = 0,
    collapsible = true,
  }: {
    draft: Draft;
    refreshKey?: number;
    collapsible?: boolean;
  } = $props();

  let coderState = $state<CoderState | null>(null);
  let error = $state('');
  let expanded = $state<string | null>(null);
  let isCollapsed = $state(false);

  const runs = $derived((coderState?.runs ?? []).filter((r) => r.draftId === draft.id));
  const ACTIVE: CoderRunStatus[] = ['queued', 'preparing', 'running', 'testing'];
  const anyActive = $derived(runs.some((r) => ACTIVE.includes(r.status)));
  const activeRuns = $derived(runs.filter((r) => ACTIVE.includes(r.status)));
  const readyRuns = $derived(runs.filter((r) => r.status === 'ready'));
  const pushedRuns = $derived(runs.filter((r) => r.status === 'pushed'));
  const needsInputRuns = $derived(runs.filter((r) => r.status === 'needs-input'));
  const failedRuns = $derived(runs.filter((r) => r.status === 'failed'));
  const queuedRuns = $derived(runs.filter((r) => r.status === 'queued'));

  async function load() {
    try {
      coderState = await coder.state();
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    void refreshKey;
    void load();
  });

  // Poll while agents are working.
  $effect(() => {
    if (!anyActive) return;
    const t = setInterval(load, 3_000);
    return () => clearInterval(t);
  });

  const STATUS: Record<CoderRunStatus, { label: string; tone: string }> = {
    queued: { label: 'Antre', tone: 'muted' },
    preparing: { label: 'Menyiapkan repo', tone: 'accent' },
    running: { label: 'Agent bekerja', tone: 'accent' },
    testing: { label: 'Menjalankan test', tone: 'accent' },
    'needs-input': { label: 'Butuh klarifikasi', tone: 'warn' },
    ready: { label: 'Siap direview', tone: 'ok' },
    pushed: { label: 'Di-push · tunggu review', tone: 'ok' },
    completed: { label: 'Selesai (MR merged)', tone: 'ok' },
    failed: { label: 'Gagal', tone: 'err' },
    cancelled: { label: 'Dibatalkan', tone: 'muted' },
  };

  // ── Diff + conformance ──
  let diffRun = $state<CoderRun | null>(null);
  let diffFiles = $state<MrFileChange[]>([]);
  let diffChecks = $state<ConformanceCheck[]>([]);
  let diffOpen = $state(false);
  let diffFilter = $state('');
  let diffWrapAll = $state(false);
  let fileOpenMap = $state<Record<string, boolean>>({});

  // ── TAD Flow Unit Test ──
  let unitTestRun = $state<CoderRun | null>(null);
  let unitTestOpen = $state(false);

  function showUnitTest(run: CoderRun) {
    unitTestRun = run;
    unitTestOpen = true;
  }

  // ── AI Code Review ──
  let aiReviewRun = $state<CoderRun | null>(null);
  let aiReviewOpen = $state(false);

  function showAiReview(run: CoderRun) {
    aiReviewRun = run;
    aiReviewOpen = true;
  }

  const filteredDiffFiles = $derived(
    diffFilter.trim()
      ? diffFiles.filter(
          (f) =>
            f.newPath.toLowerCase().includes(diffFilter.toLowerCase().trim()) ||
            (f.oldPath && f.oldPath.toLowerCase().includes(diffFilter.toLowerCase().trim())),
        )
      : diffFiles,
  );

  const allFilesOpen = $derived(
    filteredDiffFiles.length > 0 && filteredDiffFiles.every((f) => fileOpenMap[f.newPath] !== false),
  );

  function toggleAllFiles() {
    const next = !allFilesOpen;
    const nextMap = { ...fileOpenMap };
    for (const f of filteredDiffFiles) {
      nextMap[f.newPath] = next;
    }
    fileOpenMap = nextMap;
  }

  const totalDiffAdditions = $derived(diffFiles.reduce((s, f) => s + (f.additions || 0), 0));
  const totalDiffDeletions = $derived(diffFiles.reduce((s, f) => s + (f.deletions || 0), 0));

  async function showDiff(run: CoderRun) {
    try {
      diffFiles = await coder.diff(run.id);
      const task = parseScopeTasks(draft.markdown).find((t) => t.title === run.taskTitle);
      const spec = detailTaskSpec(draft.markdown, run.taskTitle);
      diffChecks = task && spec ? checkConformance(spec, task, { projectPath: run.repo, changes: diffFiles }) : [];
      diffRun = run;
      diffFilter = '';
      diffWrapAll = false;
      fileOpenMap = Object.fromEntries(diffFiles.map((f) => [f.newPath, diffFiles.length <= 12]));
      diffOpen = true;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function push(run: CoderRun) {
    const ok = await confirmDialog({
      title: `Push ${run.branch}?`,
      message: [
        `Repo: ${run.repo} (${run.origin ?? 'origin'})`,
        `Branch: ${run.branch} (dari ${run.baseBranch} ➔ MR ke ${run.targetBranch})`,
        `${run.changedFiles?.length ?? 0} file berubah${run.test ? `, test ${run.test.exitCode === 0 ? 'lulus' : 'GAGAL'}` : ''}.`,
        '',
        'Branch di-push dengan akses git kamu, lalu halaman "New merge request" GitLab dibuka (judul Draft).',
        run.jiraKey ? `${run.jiraKey} digeser otomatis ke status review (IN REVIEW TL).` : '',
      ]
        .filter((l, i, a) => l || a[i - 1])
        .join('\n'),
      confirmText: 'Push & buat MR Draft',
    });
    if (!ok) return;
    try {
      const res = await coder.push(run.id);
      toasts.show(`Branch ${res.branch} di-push.`, 'ok');
      if (res.mrCreateUrl) openExternal(res.mrCreateUrl);
      await load();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function markCompleted(run: CoderRun) {
    const ok = await confirmDialog({
      title: 'Tandai Selesai',
      message: `Tandai task "${run.taskTitle}" sebagai selesai (MR sudah merged)?`,
      confirmText: 'Tandai Selesai',
    });
    if (!ok) return;
    try {
      await coder.complete(run.id, 'Ditandai selesai (MR sudah merged).');
      toasts.show('Run ditandai selesai.', 'ok');
      await load();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  let reviseFor = $state<string | null>(null);
  let feedback = $state('');
  let syncConflict = $state(false);

  async function revise(run: CoderRun) {
    try {
      await coder.revise(run.id, feedback, { syncTarget: syncConflict });
      feedback = '';
      syncConflict = false;
      reviseFor = null;
      await load();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function resume(run: CoderRun) {
    try {
      await coder.resume(run.id);
      toasts.show(`Melanjutkan pengerjaan task ${run.taskTitle}…`, 'ok');
      await load();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function syncLocal(run: CoderRun) {
    try {
      const res = await coder.syncLocal(run.id);
      if (res.synced) {
        toasts.show(res.message, 'ok');
      } else {
        toasts.show(res.message, 'err');
      }
      await load();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function cancel(run: CoderRun) {
    await coder.cancel(run.id).catch((e) => toasts.show((e as Error).message, 'err'));
    await load();
  }

  async function remove(run: CoderRun) {
    const unpushed = run.status === 'ready' || run.status === 'needs-input';
    if (unpushed && !(await confirmDialog({ title: 'Hapus run?', message: 'Clone dan hasil kerja agent yang belum di-push akan dihapus dari laptop.', confirmText: 'Hapus', danger: true }))) return;
    await coder.remove(run.id).catch((e) => toasts.show((e as Error).message, 'err'));
    await load();
  }

  // ── Profiles ──
  let profilesOpen = $state(false);
  async function saveProfile(id: CoderProfileId, patch: { ai?: CoderState['profiles'][CoderProfileId]['ai']; instructions?: string }) {
    try {
      coderState = await coder.settings({ profiles: { [id]: patch } });
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '');
</script>

<section class="agents">
  <header>
    <h3><Icon name="sparkles" size={15} /> Agent ({runs.length})</h3>
    {#if anyActive}<span class="live">bekerja…</span>{/if}
    <span class="spacer"></span>
    {#if collapsible && runs.length > 0}
      <button
        type="button"
        class="btn btn-sm btn-ghost collapse-toggle-btn"
        onclick={() => (isCollapsed = !isCollapsed)}
        title={isCollapsed ? 'Buka detail agent' : 'Ciutkan daftar agent'}
      >
        <Icon name={isCollapsed ? 'maximize' : 'minimize'} size={12} />
        <span>{isCollapsed ? 'Buka detail' : 'Ciutkan'}</span>
      </button>
    {/if}
    <a class="btn btn-sm btn-ghost" href="#/agents" title="Semua run agent coding di satu daftar">Lihat di Agent Tasks</a>
    <button class="btn btn-sm btn-ghost" onclick={() => (profilesOpen = true)} disabled={!coderState}><Icon name="edit" size={12} /> Profil agent</button>
    <button class="btn btn-sm btn-ghost" onclick={load} title="Muat ulang"><Icon name="refresh" size={12} /></button>
  </header>
  {#if error}<p class="err small">{error}</p>{/if}
  {#if !runs.length}
    <p class="muted small">Belum ada agent untuk TAD ini. Centang task di tabel lalu klik <strong>Kerjakan dengan agent</strong>.</p>
  {:else if isCollapsed}
    <div class="collapsed-strip">
      <div class="summary-chips">
        {#if activeRuns.length}
          <span class="chip-status chip-running"><span class="dot-pulse"></span> {activeRuns.length} bekerja</span>
        {/if}
        {#if readyRuns.length}
          <span class="chip-status chip-ready">✅ {readyRuns.length} siap review</span>
        {/if}
        {#if pushedRuns.length}
          <span class="chip-status chip-ready">🚀 {pushedRuns.length} di-push</span>
        {/if}
        {#if needsInputRuns.length}
          <span class="chip-status chip-warn">⚠️ {needsInputRuns.length} butuh input</span>
        {/if}
        {#if failedRuns.length}
          <span class="chip-status chip-err">❌ {failedRuns.length} gagal</span>
        {/if}
        {#if queuedRuns.length}
          <span class="chip-status chip-queued">⏳ {queuedRuns.length} antre</span>
        {/if}
      </div>
      <button type="button" class="btn btn-xs btn-ghost" onclick={() => (isCollapsed = false)}>
        Tampilkan semua ({runs.length}) ▾
      </button>
    </div>
  {:else}

  {#each runs as run (run.id)}
    {@const st = STATUS[run.status]}
    <article class="run">
      <div class="run-head">
        <span class="badge tone-{st.tone}">{st.label}</span>
        {#if run.aiReview?.verdict}
          <span class="badge-verdict verdict-{run.aiReview.verdict.toLowerCase()}" title="Hasil AI Code Review untuk perubahan kode ini">
            {#if run.aiReview.verdict === 'APPROVE'}
              ✅ AI: Approve
            {:else if run.aiReview.verdict === 'APPROVE_WITH_COMMENTS'}
              ℹ️ AI: Comments
            {:else}
              ⚠️ AI: Request Changes
            {/if}
          </span>
        {/if}
        <span class="run-title" title={run.taskTitle}>{run.taskTitle}</span>
        <span class="muted small mono">{run.repo} · {run.branch}</span>
      </div>
      <div class="run-meta muted small">
        {run.profile === 'backend' ? 'Backend' : 'Frontend'} · {run.ai.provider}{run.ai.model ? ` ${run.ai.model}` : ''}
        · base: <span class="mono">{run.baseBranch}</span> ➔ MR ke: <span class="mono">{run.targetBranch}</span>
        {#if run.startedAt} · mulai {time(run.startedAt)}{/if}
        {#if run.changedFiles} · {run.changedFiles.length} file{/if}
        {#if run.test} · test <span class:fail={run.test.exitCode !== 0}>{run.test.exitCode === 0 ? 'lulus' : 'gagal'}</span>{/if}
        {#if run.jira?.started} · Jira {run.jira.started}{/if}
        {#if run.jira?.review} · {run.jira.review}{/if}
        {#if run.revisions} · revisi {run.revisions}×{/if}
      </div>

      <div class="branch-sync-bar">
        <span class="branch-label muted small">Branch lokal:</span>
        <code class="branch-code">{run.branch}</code>
        <button
          type="button"
          class="btn btn-xs btn-ghost copy-branch-btn"
          onclick={() => {
            navigator.clipboard.writeText(`git checkout ${run.branch}`);
            toasts.show(`Perintah disalin: git checkout ${run.branch}`, 'ok');
          }}
          title="Salin perintah checkout branch"
        >
          <Icon name="copy" size={11} /> Salin checkout
        </button>
        <button
          type="button"
          class="btn btn-xs btn-ghost"
          onclick={() => syncLocal(run)}
          title="Sinkronkan branch dari agent ke folder Services/{run.repo}"
        >
          <Icon name="refresh" size={11} /> Sync ke Services
        </button>
      </div>

      {#if run.status === 'failed' && (run.changedFiles?.length || run.headSha)}
        <div class="rescue-notice small">
          <Icon name="shield" size={13} />
          <span><strong>Perubahan Terselamatkan (Auto-Rescued):</strong> {run.changedFiles?.length ?? 0} file diamankan ke branch <code>{run.branch}</code> di <code>Services/{run.repo}</code>. Klik <strong>Lanjutkan Task</strong> untuk meneruskan pengerjaan.</span>
        </div>
      {/if}

      {#if run.error}<p class="err small">{run.error}</p>{/if}
      {#if run.status === 'needs-input' && run.reply}
        <p class="question small">{run.reply.slice(run.reply.search(/BUTUH KLARIFIKASI/i)).slice(0, 600)}</p>
      {/if}

      <div class="actions">
        {#if run.status === 'failed' && run.baseSha}
          <button
            type="button"
            class="btn btn-sm btn-primary"
            onclick={() => resume(run)}
            title="Lanjutkan pengerjaan task ini dari kondisi terakhir"
          >
            <Icon name="play" size={12} />
            <span>Lanjutkan Task</span>
          </button>
        {/if}
        {#if ['ready', 'pushed', 'failed', 'testing'].includes(run.status)}
          <button
            type="button"
            class="btn btn-sm btn-outline-unit"
            onclick={() => showUnitTest(run)}
            title="Lihat alur flow TAD dan generate / uji unit test"
          >
            <Icon name="code" size={12} />
            <span>Unit Test Flow TAD</span>
          </button>
        {/if}
        {#if ['ready', 'pushed', 'completed', 'failed'].includes(run.status) && (run.changedFiles?.length || run.headSha)}
          <button class="btn btn-sm" onclick={() => showDiff(run)}><Icon name="eye" size={12} /> Diff & kesesuaian TAD</button>
          <button
            type="button"
            class="btn btn-sm btn-outline-ai"
            onclick={() => showAiReview(run)}
            title="Review perubahan kode yang dibuat agent menggunakan AI"
          >
            <Icon name="sparkles" size={12} />
            <span>Review Changes AI</span>
            {#if run.aiReview?.verdict}
              <span class="ai-verdict-pill verdict-{run.aiReview.verdict.toLowerCase()}">
                {run.aiReview.verdict === 'APPROVE' ? '✓' : run.aiReview.verdict === 'REQUEST_CHANGES' ? '!' : 'ℹ'}
              </span>
            {/if}
          </button>
        {/if}
        {#if run.status === 'ready'}
          <button class="btn btn-sm btn-primary" onclick={() => push(run)}><Icon name="upload" size={12} /> Push & buat MR Draft</button>
        {/if}
        {#if run.status === 'ready' || run.status === 'pushed'}
          <button class="btn btn-sm btn-ghost" onclick={() => markCompleted(run)} title="Tandai run ini selesai (MR sudah merged)"><Icon name="check" size={12} /> Tandai selesai</button>
        {/if}
        {#if run.status === 'pushed' && run.mrCreateUrl}
          <a class="btn btn-sm" href={run.mrCreateUrl} target="_blank" rel="noreferrer"><Icon name="external" size={12} /> Halaman MR baru</a>
        {/if}
        {#if ['ready', 'pushed', 'needs-input', 'failed'].includes(run.status) && run.baseSha}
          <button class="btn btn-sm" onclick={() => (reviseFor = reviseFor === run.id ? null : run.id)}><Icon name="edit" size={12} /> {run.status === 'needs-input' ? 'Jawab & lanjutkan' : 'Revisi'}</button>
        {/if}
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          onclick={() => syncLocal(run)}
          title="Sinkronkan branch ke repo lokal di folder Services/{run.repo}"
        >
          <Icon name="download" size={12} /> Sync ke Local
        </button>
        {#if ACTIVE.includes(run.status)}
          <button class="btn btn-sm btn-danger" onclick={() => cancel(run)}><Icon name="x" size={12} /> Batalkan</button>
        {:else}
          <button class="btn btn-sm btn-ghost" onclick={() => remove(run)} title="Hapus run dan clone-nya"><Icon name="trash" size={12} /></button>
        {/if}
        <button class="btn btn-sm btn-ghost" onclick={() => (expanded = expanded === run.id ? null : run.id)}>{expanded === run.id ? 'Tutup log' : 'Log'}</button>
      </div>

      {#if reviseFor === run.id}
        <div class="revise">
          <div class="revise-bar">
            <label class="sync-check">
              <input type="checkbox" bind:checked={syncConflict} />
              <span>Tarik branch target <code>{run.targetBranch}</code> & selesaikan conflict jika ada</span>
            </label>
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              onclick={() => {
                syncConflict = true;
                feedback = `Terjadi merge conflict saat merge ke ${run.targetBranch}. Tolong selesaikan semua conflict di file yang berkonflik, hapus conflict markers (<<<<<<<, =======, >>>>>>>), gabungkan logika kode dengan benar, dan pastikan test lulus.`;
              }}
            >
              <Icon name="refresh" size={11} /> Template Selesaikan Conflict
            </button>
          </div>
          <textarea
            class="input"
            rows="4"
            bind:value={feedback}
            placeholder={`Catatan review / jawaban untuk agent, atau instruksi conflict dengan branch ${run.targetBranch}…`}
          ></textarea>
          <div class="revise-footer">
            <button class="btn btn-primary btn-sm" onclick={() => revise(run)} disabled={!feedback.trim()}>
              <Icon name="sparkles" size={12} /> Kirim ke agent
            </button>
          </div>
        </div>
      {/if}

      {#if expanded === run.id}
        <ol class="log mono">
          {#each run.events as e, i (i)}
            <li class="ev-{e.kind}"><span class="t">{time(e.at)}</span> {e.text}</li>
          {/each}
        </ol>
        {#if run.test}
          <details><summary class="small">Output test ({run.test.command}, exit {run.test.exitCode})</summary><pre class="out">{run.test.output}</pre></details>
        {/if}
        {#if run.reply}
          <details><summary class="small">Ringkasan dari agent</summary><pre class="out">{run.reply}</pre></details>
        {/if}
      {/if}
    </article>
  {/each}
  {/if}
</section>

<Modal
  bind:open={diffOpen}
  title={diffRun ? `Hasil agent: ${diffRun.branch}` : 'Hasil agent'}
  subtitle={diffRun?.taskTitle}
  width={1240}
  height="90vh"
>
  <div class="diff-container">
    {#if diffChecks.length}
      <section class="checks-box">
        <div class="checks-header">
          <span class="checks-title"><Icon name="shield" size={14} /> Kesesuaian dengan Spesifikasi TAD</span>
          <span class="checks-count">{diffChecks.filter((c) => c.status === 'ok').length}/{diffChecks.length} terpenuhi</span>
        </div>
        <ul class="checks">
          {#each diffChecks as c, i (i)}
            <li class="ck-{c.status}"><strong>{c.label}</strong> <span>{c.detail}</span></li>
          {/each}
        </ul>
      </section>
    {/if}

    <div class="diff-toolbar">
      <label class="diff-search">
        <Icon name="search" size={14} />
        <input
          type="search"
          placeholder="Filter nama atau path file…"
          bind:value={diffFilter}
        />
      </label>

      <div class="diff-toolbar-meta">
        <span class="diff-count-badge">
          <strong>{filteredDiffFiles.length}</strong> file berubah
          {#if filteredDiffFiles.length !== diffFiles.length}
            <span class="muted">(dari {diffFiles.length})</span>
          {/if}
        </span>
        <span class="stat-add">+{totalDiffAdditions}</span>
        <span class="stat-del">−{totalDiffDeletions}</span>
      </div>

      <div class="diff-toolbar-actions">
        <button
          type="button"
          class="btn btn-sm btn-primary-ai"
          onclick={() => {
            const r = diffRun;
            diffOpen = false;
            if (r) showAiReview(r);
          }}
          title="Review seluruh perubahan kode ini dengan AI"
        >
          <Icon name="sparkles" size={13} />
          <span>Review dengan AI</span>
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          class:btn-active={diffWrapAll}
          onclick={() => (diffWrapAll = !diffWrapAll)}
          title="Bungkus teks baris kode panjang agar tidak terpotong"
        >
          <Icon name="split" size={13} />
          <span>{diffWrapAll ? 'Scroll Mode' : 'Wrap Baris'}</span>
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onclick={toggleAllFiles}
          title={allFilesOpen ? 'Tutup semua file' : 'Buka semua file'}
        >
          <span>{allFilesOpen ? 'Tutup Semua' : 'Buka Semua'}</span>
        </button>
      </div>
    </div>

    <div class="files">
      {#each filteredDiffFiles as f (f.newPath)}
        <DiffFile
          file={f}
          bind:open={fileOpenMap[f.newPath]}
          wrap={diffWrapAll}
        />
      {:else}
        <div class="diff-empty">
          <p class="muted">
            {diffFilter ? 'Tidak ada file yang cocok dengan filter.' : 'Tidak ada perubahan file pada run ini.'}
          </p>
        </div>
      {/each}
    </div>
  </div>

  {#snippet footer()}
    {#if diffRun}
      <div class="diff-modal-footer">
        <div class="footer-left">
          {#if diffRun.repo}
            <span class="footer-repo mono">{diffRun.repo} · {diffRun.branch}</span>
          {/if}
        </div>
        <div class="footer-right">
          <button
            type="button"
            class="btn btn-sm btn-outline-ai"
            onclick={() => {
              const r = diffRun;
              diffOpen = false;
              if (r) showAiReview(r);
            }}
            title="Review perubahan kode dengan AI"
          >
            <Icon name="sparkles" size={13} />
            <span>Review Changes AI</span>
          </button>
          {#if ['ready', 'pushed', 'needs-input', 'failed'].includes(diffRun.status)}
            <button
              type="button"
              class="btn btn-sm"
              onclick={() => {
                const id = diffRun?.id;
                diffOpen = false;
                if (id) reviseFor = id;
              }}
            >
              <Icon name="edit" size={13} /> Beri Catatan Revisi
            </button>
          {/if}
          {#if diffRun.status === 'ready'}
            <button
              type="button"
              class="btn btn-sm btn-primary"
              onclick={() => {
                const run = diffRun;
                diffOpen = false;
                if (run) push(run);
              }}
            >
              <Icon name="upload" size={13} /> Push & Buat MR Draft
            </button>
          {/if}
          <button type="button" class="btn btn-sm btn-ghost" onclick={() => (diffOpen = false)}>
            Tutup
          </button>
        </div>
      </div>
    {/if}
  {/snippet}
</Modal>

<Modal bind:open={profilesOpen} title="Profil agent" subtitle="Model dan aturan kerja yang dipakai saat agent mengerjakan task." width={820}>
  {#if coderState}
    {#each ['backend', 'frontend'] as const as id (id)}
      {@const p = coderState.profiles[id]}
      <section class="profile">
        <h4>{p.label}</h4>
        <AiPicker value={p.ai} onchange={(ai) => saveProfile(id, { ai })} />
        <textarea class="input" rows="7" value={p.instructions} onchange={(e) => saveProfile(id, { instructions: e.currentTarget.value })}></textarea>
      </section>
    {/each}
    <p class="muted small">Agent hanya boleh menjalankan perintah test/lint yang terdeteksi di repo (go test, npm run test/lint, php artisan test, pytest).</p>
  {/if}
</Modal>

<TadFlowUnitTestModal
  bind:open={unitTestOpen}
  run={unitTestRun}
  {draft}
  onupdate={load}
  onshowdiff={showDiff}
/>

<AgentDiffReviewModal
  bind:open={aiReviewOpen}
  run={aiReviewRun}
  {draft}
  onupdate={load}
  onshowdiff={showDiff}
  onpush={push}
  onapplyrevisions={(run, feedbackText) => {
    reviseFor = run.id;
    feedback = feedbackText;
  }}
/>

<style>
  .agents {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 16px;
    font-weight: 500;
  }
  .live {
    font-size: 12px;
    color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .collapse-toggle-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
  }
  .collapsed-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 14px;
    border: 1px dashed var(--border);
    border-radius: 12px;
    background: var(--surface-2);
  }
  .summary-chips {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .chip-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 11.5px;
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
    border: 1px solid var(--border);
  }
  .dot-pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    display: inline-block;
    animation: dotPulse 1.5s infinite ease-in-out;
  }
  @keyframes dotPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(1.3); }
  }
  .small {
    font-size: 12.5px;
  }
  .err {
    margin: 0;
    color: var(--err);
  }
  .run {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .run-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .run-title {
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 520px;
  }
  .badge {
    padding: 1px 9px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
    background: var(--surface-2);
    white-space: nowrap;
  }
  .tone-accent {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .tone-ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .tone-warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .tone-err {
    background: var(--err-soft);
    color: var(--err);
  }
  .fail {
    color: var(--err);
  }
  .question {
    margin: 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--warn-soft);
    white-space: pre-wrap;
  }
  .branch-sync-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--surface-2);
    border-radius: 8px;
    font-size: 12px;
    flex-wrap: wrap;
  }
  .branch-code {
    font-family: var(--font-mono, monospace);
    font-size: 11.5px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-1);
  }
  .rescue-notice {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    color: var(--text-1);
    font-size: 12px;
  }
  .rescue-notice code {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--surface-2);
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .btn-outline-unit {
    border-color: var(--brand, #3b82f6);
    color: var(--brand, #3b82f6);
    background: transparent;
  }
  .btn-outline-unit:hover {
    background: var(--brand-subtle, rgba(59, 130, 246, 0.1));
  }
  .btn-outline-ai {
    border-color: #8b5cf6;
    color: #a78bfa;
    background: rgba(139, 92, 246, 0.08);
  }
  .btn-outline-ai:hover {
    background: rgba(139, 92, 246, 0.2);
    color: #c4b5fd;
  }
  .btn-primary-ai {
    background: linear-gradient(135deg, #7c3aed, #3b82f6);
    color: #ffffff;
    border: none;
    font-weight: 500;
  }
  .btn-primary-ai:hover {
    opacity: 0.92;
  }
  .badge-verdict {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
    margin-right: 6px;
  }
  .badge-verdict.verdict-approve {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }
  .badge-verdict.verdict-approve_with_comments {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }
  .badge-verdict.verdict-request_changes {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }
  .ai-verdict-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    font-size: 9px;
    font-weight: 700;
    margin-left: 3px;
  }
  .ai-verdict-pill.verdict-approve {
    background: #22c55e;
    color: #ffffff;
  }
  .ai-verdict-pill.verdict-approve_with_comments {
    background: #3b82f6;
    color: #ffffff;
  }
  .ai-verdict-pill.verdict-request_changes {
    background: #ef4444;
    color: #ffffff;
  }
  .revise {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-radius: 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .revise-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    font-size: 12px;
  }
  .sync-check {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .sync-check code {
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--surface-3, var(--border));
  }
  .revise-footer {
    display: flex;
    justify-content: flex-end;
    width: 100%;
  }
  .log {
    margin: 0;
    padding: 8px 10px;
    max-height: 240px;
    overflow: auto;
    list-style: none;
    border-radius: 8px;
    background: var(--surface-2);
    font-size: 11.5px;
  }
  .log .t {
    color: var(--text-3);
  }
  .ev-error {
    color: var(--err);
  }
  .ev-jira {
    color: var(--accent);
  }
  .out {
    max-height: 260px;
    overflow: auto;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--surface-2);
    font-size: 11.5px;
    white-space: pre-wrap;
  }
  .diff-container {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    min-width: 0;
  }
  .checks-box {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-2);
    padding: 10px 14px;
  }
  .checks-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 8px;
  }
  .checks-title {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
  }
  .checks-count {
    font-size: 12px;
    color: var(--text-3);
  }
  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .checks li {
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .ck-ok strong {
    color: var(--ok);
  }
  .ck-warn strong {
    color: var(--warn);
  }
  .ck-missing strong {
    color: var(--err);
  }
  .diff-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    position: sticky;
    top: -18px;
    z-index: 5;
    flex-wrap: wrap;
  }
  .diff-search {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 200px;
    max-width: 380px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 10px;
    color: var(--text-3);
  }
  .diff-search input {
    background: transparent;
    border: 0;
    color: var(--text);
    font-size: 12px;
    width: 100%;
    outline: none;
  }
  .diff-toolbar-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .diff-count-badge {
    color: var(--text-2);
  }
  .stat-add {
    color: var(--ok);
    font-weight: 600;
  }
  .stat-del {
    color: var(--err);
    font-weight: 600;
  }
  .diff-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .btn-active {
    background: var(--accent-soft) !important;
    color: var(--accent) !important;
  }
  .files {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    min-width: 0;
  }
  .diff-empty {
    padding: 28px;
    text-align: center;
    border: 1px dashed var(--border);
    border-radius: 10px;
    background: var(--surface-2);
  }
  .diff-empty p {
    margin: 0;
  }
  .diff-modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    gap: 12px;
  }
  .footer-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .footer-repo {
    font-size: 12px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .profile {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }
  .profile h4 {
    margin: 0;
    font-weight: 500;
  }
</style>
