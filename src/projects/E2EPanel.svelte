<script lang="ts">
  import { untrack } from 'svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { loadAiSelection } from '../lib/ai/providers.svelte';
  import type { AiSelection } from '../lib/ai/types';
  import { qa, runReport } from '../lib/qa/client';
  import { handleConflict } from '../lib/qa/conflict';
  import Modal from '../components/Modal.svelte';
  import AgentRunsPanel from '../coder/AgentRunsPanel.svelte';
  import { coder, suggestRepo } from '../lib/coder/client';
  import { branchName, branchNameError, pickBaseBranch } from '../lib/coder/branches';
  import { appSettings } from '../lib/settings/store.svelte';
  import type { CoderProfileId, CoderRun, CoderRunStatus } from '../lib/coder/types';
  import { buildCodeFixSpec, buildMultiCodeFixSpec, chunkFixes, codeFixTitle, e2eDraftId, failedStep, failingService, multiCodeFixTitle } from '../lib/qa/code-fix';
  import { drafts as draftStore, draftTitle } from '../tad/drafts.svelte';
  import { startGeneratorJob } from '../tad/generator-client';
  import { finishGeneratorJob } from '../tad/job-delivery';
  import { api } from '../lib/api-base';
  import type { GeneratorJob } from '../lib/generator/types';
  import { buildTadUpdatePrompt, collectFindings, FINDING_LABELS, likelyTad, type FindingKind } from '../lib/qa/tad-findings';
  import { dbFillPlan, notReady } from '../lib/qa/db-fill';
  import { latestResults, resultBucket, resultCounts, type LatestResult, type ResultBucket } from '../lib/qa/latest';
  import { addGroup, cleanGroupName, edgeOfGroup, groupCheck, groupFlows, groupOrder, moveFlowInGroup, moveFlowToGroup, moveGroup, removeGroup, renameGroup, setGroupEnabled, UNGROUPED_LABEL, withGroups } from '../lib/qa/groups';
  import { QA_CATEGORIES, QA_CATEGORY_LABELS, type QACategory, type QAEnvironment, type QAFlow, type QAFlowResult, type QAGenerateJob, type QAGenerateRequest, type QAPipeline, type QAPlan, type QARun, type QASuspect, type QAStepResult, type QAStepStatus, type QAStoreStatus, type QASuite, type QATadRef } from '../lib/qa/types';
  import type { EstimateProject } from '../lib/estimate/types';
  import type { Draft } from '../tad/drafts.svelte';
  import E2EEnvironmentModal from './E2EEnvironmentModal.svelte';
  import E2ELogViewer from './E2ELogViewer.svelte';
  import FlowEditor from './FlowEditor.svelte';
  import SuiteReview from './SuiteReview.svelte';
  import E2EPipeline from './E2EPipeline.svelte';
  import E2ERequirements from './E2ERequirements.svelte';
  import { bugs } from '../lib/bugs/client';
  import { projectDrafts, projectTasks, prdContext } from './project-tasks';
  import { loadServicesRoot } from '../tad/generator-client';

  /** E2E flows and runs belong to the project, so a flow can span the project's TADs. */
  let { project, drafts }: { project: Pick<EstimateProject, 'id' | 'name' | 'draftIds'>; drafts: Draft[] } = $props();

  const ENV_KEY = 'tlc.qa.environment';
  const POLL_MS = 1500;

  // Tasks of all the project's TADs; only those with a Detail Task can be tested (the AI needs the spec).
  const tasks = $derived(projectTasks(project, drafts));
  const multiTad = $derived(project.draftIds.length > 1);

  let suite = $state<QASuite | null>(null);
  /** Where the test cases are kept (files on this laptop, or the shared database with QA). */
  let storeStatus = $state<QAStoreStatus | null>(null);
  let environments = $state<QAEnvironment[]>([]);
  let envId = $state(savedEnvId());
  let envModalOpen = $state(false);
  let tab = $state<'flows' | 'results'>('flows');

  // Generation
  let showGenerate = $state(false);
  let selectedTasks = $state(new Set<string>());
  let categories = $state(new Set<QACategory>(['happy-path', 'validation', 'auth', 'business-edge-case', 'integration-chain']));
  let instructions = $state('');
  let ai = $state<AiSelection>(loadAiSelection('generator'));
  let append = $state(false);
  /** Check routes, payloads and responses against the Services code (read-only). */
  let useCodebase = $state(true);
  // Derived: settings load after the panel mounts, and the folder in Settings wins over the old default.
  const servicesRoot = $derived(loadServicesRoot());
  const canReadCode = $derived(ai.provider === 'claude' || ai.provider === 'antigravity');
  let job = $state<QAGenerateJob | null>(null);
  // Multi-agent pipeline: journey plan, writer agents per stage, repair agents after a run.
  let plan = $state<QAPlan | null>(null);
  let pipeline = $state<QAPipeline | null>(null);
  const pipelineBusy = $derived((pipeline?.agents ?? []).some((a) => a.status === 'running' || a.status === 'queued'));

  // Editing
  let openFlows = $state(new Set<string>());
  let editingId = $state<string | null>(null);

  // Runs
  let runs = $state<QARun[]>([]);
  // Full-screen request log of a run.
  let logOpen = $state(false);
  let logRunId = $state<string | undefined>();
  function openLog(runId?: string) {
    logRunId = runId ?? activeRun?.id ?? runs[0]?.id;
    logOpen = true;
  }

  // Search over the test cases (flows): name, description, category, tasks, steps (name, method, path, service).
  let flowQuery = $state('');
  let flowCategory = $state<QACategory | ''>('');
  /** Filter by the latest outcome (Lulus / Gagal / Belum dijalankan). */
  let flowResult = $state<ResultBucket | ''>('');
  const visibleFlows = $derived.by(() => {
    const flows = suite?.flows ?? [];
    const terms = flowQuery.toLowerCase().split(/\s+/).filter(Boolean);
    return flows.filter((f) => {
      if (flowCategory && f.category !== flowCategory) return false;
      if (flowResult && resultBucket(latest.get(f.id)) !== flowResult) return false;
      if (!terms.length) return true;
      const hay = [f.name, f.description, QA_CATEGORY_LABELS[f.category], ...f.taskTitles, ...f.steps.flatMap((st) => [st.name, st.request.method, st.request.path, st.service ?? ''])].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  });
  let activeRun = $state<QARun | null>(null);
  let openSteps = $state(new Set<string>());
  let starting = $state(false);

  function savedEnvId(): string {
    try {
      return localStorage.getItem(ENV_KEY) ?? '';
    } catch {
      return '';
    }
  }

  $effect(() => {
    try {
      if (envId) localStorage.setItem(ENV_KEY, envId);
    } catch {
      /* ignore */
    }
  });

  const services = $derived([...new Set([...tasks.map((t) => t.service), ...(suite?.flows ?? []).flatMap((f) => f.steps.map((s) => s.service ?? ''))].filter(Boolean))]);
  const env = $derived(environments.find((e) => e.id === envId));
  const enabledFlows = $derived(suite?.flows.filter((f) => f.enabled) ?? []);
  const generating = $derived(job?.status === 'running');
  const running = $derived(activeRun?.status === 'running');
  /** Last result of each flow in the shown run, for the badges in the flow list. */
  const lastStatus = $derived(Object.fromEntries((activeRun?.flows ?? []).map((f) => [f.flowId, f.status])) as Record<string, QAStepStatus>);
  /** Each flow's latest real outcome on the selected environment, across all runs (also one-flow runs). */
  const latest = $derived(latestResults(runs, env?.id));
  const totals = $derived(resultCounts(suite?.flows ?? [], latest));
  const RESULT_FILTERS: { value: ResultBucket | ''; label: string }[] = [
    { value: '', label: 'Semua' },
    { value: 'passed', label: 'Lulus' },
    { value: 'failed', label: 'Gagal' },
    { value: 'none', label: 'Belum dijalankan' },
  ];
  const shortTime = (iso: string) => new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const resultTitle = (r: LatestResult) => `Hasil run terakhir: ${STATUS[r.status].label} · ${new Date(r.at).toLocaleString('id-ID')} · ${r.envName}. Klik untuk membuka run ini.`;
  // "Perbaiki kode": a bug-fix coder run from a failed test, in the background (Agent Tasks), no ticket.
  const fixDraft = $derived({ id: e2eDraftId(project.id), markdown: '' } as unknown as Draft);
  let coderRuns = $state<CoderRun[]>([]);
  let coderKey = $state(0);
  const CODER_ACTIVE: CoderRunStatus[] = ['queued', 'preparing', 'running', 'testing'];
  const CODER_LABEL: Partial<Record<CoderRunStatus, string>> = { queued: 'antre', preparing: 'menyiapkan', running: 'agent bekerja', testing: 'menjalankan test', 'needs-input': 'butuh jawaban', ready: 'siap direview', pushed: 'di-push', completed: 'selesai', failed: 'gagal', cancelled: 'dibatalkan' };
  /** Newest fix run per flow of this project. */
  const fixByFlow = $derived.by(() => {
    const m = new Map<string, CoderRun>();
    for (const r of [...coderRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (r.source?.kind !== 'e2e' || r.source.projectId !== project.id) continue;
      for (const id of r.source.flowIds ?? [r.source.flowId]) if (!m.has(id)) m.set(id, r);
    }
    return m;
  });
  const anyFixActive = $derived([...fixByFlow.values()].some((r) => CODER_ACTIVE.includes(r.status)));
  async function loadCoderRuns() {
    coderRuns = (await coder.state().catch(() => null))?.runs.filter((r) => r.draftId === e2eDraftId(project.id)) ?? coderRuns;
  }
  $effect(() => {
    void project.id;
    untrack(() => void loadCoderRuns());
  });
  // While a fix is running in the background, keep its status on the cards current.
  $effect(() => {
    if (!anyFixActive) return;
    const t = setInterval(() => void loadCoderRuns(), 5_000);
    return () => clearInterval(t);
  });

  let fixTarget = $state<{ flow: QAFlow; result: QAFlowResult; run: QARun } | null>(null);
  let fixOpenModal = $state(false);
  let fixRepos = $state<string[]>([]);
  let fixRepo = $state('');
  let fixProfile = $state<CoderProfileId>('backend');
  let fixBase = $state('');
  /** The chosen repo's branches; the base is picked from them (a repo may only have main). */
  let fixBranches = $state<string[]>([]);
  let fixBranchesFrom = $state<'remote' | 'local' | 'loading' | 'error'>('loading');
  /** Branch for the fix, editable; suggested from the test case name (same rule as the connector). */
  let fixBranch = $state('');
  const fixBranchError = $derived(branchNameError(fixBranch));
  const fixBranchExists = $derived(Boolean(fixBranch.trim()) && fixBranches.includes(fixBranch.trim()));
  $effect(() => {
    const repo = fixRepo;
    if (!fixOpenModal || !repo) return;
    untrack(() => void loadFixBranches(repo));
  });
  async function loadFixBranches(repo: string) {
    fixBranchesFrom = 'loading';
    fixBranches = [];
    try {
      const r = await coder.branches(repo);
      if (repo !== fixRepo) return;
      fixBranches = r.branches;
      fixBranchesFrom = r.fromRemote ? 'remote' : 'local';
      fixBase = pickBaseBranch(r.branches, [appSettings.value.workspace.defaultBaseBranch], r.head) ?? '';
    } catch (e) {
      if (repo !== fixRepo) return;
      fixBranchesFrom = 'error';
      toasts.show(`Branch ${repo} tidak terbaca: ${(e as Error).message}`, 'err');
    }
  }
  let fixNote = $state('');
  let fixStarting = $state(false);
  const fixSpec = $derived(
    fixTarget && fixRepo
      ? buildCodeFixSpec({
          flow: fixTarget.flow,
          result: fixTarget.result,
          projectName: project.name,
          envName: fixTarget.run.environment.name,
          runAt: new Date(fixTarget.run.startedAt).toLocaleString('id-ID'),
          repo: fixRepo,
          taskSpecs: tasks.filter((t) => fixTarget!.flow.taskTitles.includes(t.title)).map((t) => ({ title: t.title, spec: t.spec })),
          note: fixNote,
        })
      : '',
  );

  /** Opens the "Perbaiki kode" dialog for a flow's failure in a run (default: its latest failure). */
  async function openCodeFix(flowId: string, runId?: string) {
    const flow = suite?.flows.find((f) => f.id === flowId);
    const run = runs.find((r) => r.id === (runId ?? latest.get(flowId)?.runId));
    const result = run?.flows.find((f) => f.flowId === flowId);
    if (!flow || !run || !result) return toasts.show('Hasil run yang gagal untuk test case ini tidak ditemukan.', 'err');
    fixTarget = { flow, result, run };
    fixNote = '';
    fixBranch = branchName(undefined, codeFixTitle(flow, ''), 'fix', '');
    fixOpenModal = true;
    fixRepos = await coder.repos().catch(() => []);
    fixRepo = suggestRepo(fixRepos, failingService(flow, result)) || fixRepo;
    fixProfile = 'backend';
  }

  async function startCodeFix() {
    if (!fixTarget || !fixRepo || !fixSpec) return;
    fixStarting = true;
    try {
      const { flow, run } = fixTarget;
      await coder.start([
        {
          draftId: e2eDraftId(project.id),
          tadTitle: `E2E: ${project.name}`,
          taskTitle: codeFixTitle(flow, fixRepo),
          profile: fixProfile,
          repo: fixRepo,
          ...(fixBase.trim() ? { baseBranch: fixBase.trim(), targetBranch: fixBase.trim() } : {}),
          branch: fixBranch.trim(),
          spec: fixSpec,
          kind: 'bugfix',
          source: { kind: 'e2e', projectId: project.id, flowId: flow.id, flowName: flow.name, qaRunId: run.id },
        },
      ]);
      fixOpenModal = false;
      toasts.show(`Coder agent memperbaiki ${fixRepo} di background. Pantau di panel Perbaikan kode atau Agent Tasks.`, 'ok', 6000);
      await loadCoderRuns();
      coderKey++;
    } catch (e) {
      toasts.show((e as Error).message, 'err', 8000);
    } finally {
      fixStarting = false;
    }
  }

  // "Update TAD dari temuan": findings from testing that the TAD misses, sent to the TAD's AI
  // revision as a background job. The edit always comes back as a proposal to review in the TAD.
  const projectTads = $derived(projectDrafts(project, drafts));
  const findings = $derived(suite ? collectFindings({ suite, runs, latest, coderRuns }) : []);
  let tadOpen = $state(false);
  let tadDraftId = $state('');
  let tadPicked = $state(new Set<string>());
  let tadNote = $state('');
  let tadAi = $state<AiSelection>(loadAiSelection('generator'));
  let tadStarting = $state(false);
  const FINDING_ORDER: FindingKind[] = ['repair', 'clarify', 'note', 'warning', 'edited', 'suspect', 'failed'];
  const tadTasks = (draftId: string) => tasks.filter((t) => t.draftId === draftId).map((t) => t.title);
  /** Findings about another TAD of the project than the chosen one. */
  const otherTad = (taskTitles: string[]) => taskTitles.length > 0 && !taskTitles.some((t) => tadTasks(tadDraftId).includes(t));

  function openTadUpdate() {
    if (!projectTads.length) return toasts.show('Proyek ini belum punya TAD.', 'err');
    const suggested = findings.filter((f) => f.suggested);
    tadDraftId = likelyTad(suggested.length ? suggested : findings, projectTads.map((d) => ({ draftId: d.id, taskTitles: tadTasks(d.id) }))) ?? projectTads[0].id;
    tadPicked = new Set(suggested.filter((f) => !otherTad(f.taskTitles)).map((f) => f.id));
    tadNote = '';
    tadOpen = true;
  }

  async function startTadUpdate() {
    const draft = draftStore.drafts.find((d) => d.id === tadDraftId);
    const chosen = findings.filter((f) => tadPicked.has(f.id));
    if (!draft || (!chosen.length && !tadNote.trim())) return;
    if (draft.pendingJobId) return toasts.show('AI masih mengerjakan TAD ini. Tunggu selesai atau lihat di halaman TAD.', 'err');
    tadStarting = true;
    try {
      const prompt = buildTadUpdatePrompt(chosen, tadNote);
      draftStore.addChatMessage(draft.id, { sender: 'user', text: `Update TAD dari ${chosen.length} temuan E2E (proyek ${project.name}).${tadNote.trim() ? `\n\nCatatan: ${tadNote.trim()}` : ''}` });
      const { job, alreadyRunning } = await startGeneratorJob(draft, prompt, tadAi, 'edit');
      if (alreadyRunning) return toasts.show('AI masih mengerjakan instruksi lain untuk TAD ini.', 'err');
      draftStore.update(draft.id, { pendingJobId: job.id, pendingReview: true });
      draftStore.saveNow();
      tadOpen = false;
      toasts.show(`AI memperbarui TAD di background. Hasilnya jadi usulan yang direview di TAD.`, 'ok', 6000);
    } catch (e) {
      toasts.show(`Gagal memulai update TAD: ${(e as Error).message}`, 'err');
    } finally {
      tadStarting = false;
    }
  }

  /** TAD updates started from here that are still running, and finished ones waiting for review. */
  const tadRunning = $derived(projectTads.filter((d) => d.pendingJobId && d.pendingReview));
  const tadProposals = $derived(projectTads.filter((d) => d.proposal));
  // Deliver a finished update even when the TAD page is closed (job-delivery hands each job over once).
  $effect(() => {
    const pending = tadRunning.map((d) => [d.id, d.pendingJobId!] as const);
    if (!pending.length) return;
    let stop = false;
    const tick = async () => {
      for (const [draftId, jobId] of pending) {
        if (stop) return;
        const res = await fetch(api(`/api/connector/chat/jobs?id=${encodeURIComponent(jobId)}`), { headers: { 'X-TLC-Client': '1' } }).catch(() => null);
        if (!res) continue;
        if (res.status === 404) {
          draftStore.update(draftId, { pendingJobId: undefined, pendingReview: undefined });
          draftStore.addChatMessage(draftId, { sender: 'assistant', text: 'Job AI tidak ditemukan lagi (connector di-restart penuh). Silakan jalankan ulang Update TAD dari temuan.', isError: true });
          continue;
        }
        const job = (await res.json().catch(() => null)) as GeneratorJob | null;
        if (job && job.status !== 'running') finishGeneratorJob(draftId, job, { reviewMode: true });
      }
    };
    const t = setInterval(() => void tick(), 2_000);
    void tick();
    return () => {
      stop = true;
      clearInterval(t);
    };
  });
  function openTadReview(draftId: string) {
    try {
      sessionStorage.setItem('tlc.tad.openReview', draftId);
    } catch {
      /* the chip on the TAD page still opens it */
    }
    draftStore.select(draftId);
    location.hash = '#/tad';
  }

  // "Perbaiki kode" for several failed test cases at once: one run per repo (a repo never has two
  // runs at the same time), at most MAX_FLOWS_PER_FIX per run; different repos run in parallel.
  interface RepoCfg {
    base: string;
    branches: string[];
    from: 'loading' | 'remote' | 'local' | 'error';
    branch: string;
  }
  let bulkOpen = $state(false);
  let bulkPicked = $state(new Set<string>());
  let bulkRepoOf = $state<Record<string, string>>({});
  let bulkRepos = $state<string[]>([]);
  let bulkCfg = $state<Record<string, RepoCfg>>({});
  let bulkProfile = $state<CoderProfileId>('backend');
  let bulkNote = $state('');
  let bulkStarting = $state(false);
  const failureOf = (flowId: string) => {
    const res = latest.get(flowId);
    const run = res ? runs.find((r) => r.id === res.runId) : undefined;
    const result = run?.flows.find((f) => f.flowId === flowId);
    return run && result ? { run, result } : undefined;
  };
  /** Failed test cases that have no fix running yet. */
  const fixable = $derived((suite?.flows ?? []).filter((f) => resultBucket(latest.get(f.id)) === 'failed' && !CODER_ACTIVE.includes(fixByFlow.get(f.id)?.status ?? 'cancelled') && failureOf(f.id)));
  /** Picked test cases by repo, in run-sized chunks. */
  const bulkGroups = $derived.by(() => {
    const byRepo = new Map<string, QAFlow[]>();
    for (const f of fixable) {
      if (!bulkPicked.has(f.id)) continue;
      const repo = bulkRepoOf[f.id] ?? '';
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), f]);
    }
    return [...byRepo].map(([repo, flows]) => ({ repo, flows, chunks: chunkFixes(flows) }));
  });
  /** The branch for a repo's runs: what the user typed, else one named after all its test cases. */
  const repoBranch = (g: { repo: string; flows: QAFlow[] }) => (bulkCfg[g.repo]?.branch ?? '').trim() || branchName(undefined, multiCodeFixTitle(g.flows, ''), 'fix', '');
  const chunkBranch = (g: { repo: string; flows: QAFlow[] }, i: number) => (i === 0 ? repoBranch(g) : `${repoBranch(g)}-${i + 1}`);
  let coderConcurrency = $state(2);
  const bulkErrors = $derived(
    bulkGroups.flatMap((g) => {
      if (!g.repo) return [`${g.flows.length} test case belum punya repo.`];
      const cfg = bulkCfg[g.repo];
      if (!cfg || cfg.from === 'loading') return [`Branch ${g.repo} masih dimuat.`];
      const errs: string[] = [];
      if (cfg.branches.length && !cfg.branches.includes(cfg.base)) errs.push(`${g.repo}: pilih base branch.`);
      const e = branchNameError(repoBranch(g));
      if (e) errs.push(`${g.repo}: ${e}`);
      return errs;
    }),
  );

  async function openBulkFix() {
    bulkPicked = new Set((searching ? fixable.filter((f) => visibleFlows.some((v) => v.id === f.id)) : fixable).map((f) => f.id));
    bulkNote = '';
    bulkOpen = true;
    bulkRepos = await coder.repos().catch(() => []);
    coderConcurrency = (await coder.state().catch(() => null))?.settings.concurrency ?? coderConcurrency;
    bulkRepoOf = Object.fromEntries(fixable.map((f) => [f.id, suggestRepo(bulkRepos, failingService(f, failureOf(f.id)!.result)) || '']));
  }
  // Each repo in the selection gets its branches loaded once, and a default base and branch name.
  $effect(() => {
    if (!bulkOpen) return;
    for (const g of bulkGroups) {
      if (!g.repo || untrack(() => bulkCfg[g.repo])) continue;
      untrack(() => {
        bulkCfg[g.repo] = { base: '', branches: [], from: 'loading', branch: '' };
      });
      void coder
        .branches(g.repo)
        .then((r) => {
          bulkCfg[g.repo] = { ...bulkCfg[g.repo], branches: r.branches, from: r.fromRemote ? 'remote' : 'local', base: pickBaseBranch(r.branches, [appSettings.value.workspace.defaultBaseBranch], r.head) ?? '' };
        })
        .catch(() => {
          bulkCfg[g.repo] = { ...bulkCfg[g.repo], from: 'error' };
        });
    }
  });

  async function startBulkFix() {
    if (bulkErrors.length || !bulkGroups.length) return;
    bulkStarting = true;
    try {
      const requests = bulkGroups.flatMap((g) =>
        g.chunks.map((flows, i) => {
          const first = failureOf(flows[0].id)!;
          const cfg = bulkCfg[g.repo];
          return {
            draftId: e2eDraftId(project.id),
            tadTitle: `E2E: ${project.name}`,
            taskTitle: multiCodeFixTitle(flows, g.repo),
            profile: bulkProfile,
            repo: g.repo,
            ...(cfg.base ? { baseBranch: cfg.base, targetBranch: cfg.base } : {}),
            branch: chunkBranch(g, i),
            spec: buildMultiCodeFixSpec({
              items: flows.map((f) => ({ flow: f, result: failureOf(f.id)!.result, runAt: new Date(failureOf(f.id)!.run.startedAt).toLocaleString('id-ID') })),
              projectName: project.name,
              envName: first.run.environment.name,
              repo: g.repo,
              taskSpecs: tasks.filter((t) => flows.some((f) => f.taskTitles.includes(t.title))).map((t) => ({ title: t.title, spec: t.spec })),
              note: bulkNote,
            }),
            kind: 'bugfix' as const,
            source: { kind: 'e2e' as const, projectId: project.id, flowId: flows[0].id, flowName: flows.length === 1 ? flows[0].name : `${flows.length} test case`, qaRunId: first.run.id, flowIds: flows.map((f) => f.id) },
          };
        }),
      );
      await coder.start(requests);
      bulkOpen = false;
      const repos = bulkGroups.length;
      toasts.show(`${requests.length} perbaikan dimulai di background untuk ${repos} repo${repos > 1 ? ' (berjalan paralel sesuai batas konkurensi)' : ''}. Pantau di panel Perbaikan kode atau Agent Tasks.`, 'ok', 7000);
      await loadCoderRuns();
      coderKey++;
    } catch (e) {
      toasts.show((e as Error).message, 'err', 8000);
    } finally {
      bulkStarting = false;
    }
  }

  function openResult(r: LatestResult) {
    tab = 'results';
    void showRun(r.runId);
  }

  // Load everything for the project; also resumes a generation or run still going in the connector.
  $effect(() => {
    const id = project.id;
    untrack(() => void load(id));
  });

  async function load(id: string) {
    suite = null;
    activeRun = null;
    runs = [];
    job = null;
    plan = null;
    pipeline = null;
    editingId = null;
    selectedTasks = new Set(tasks.filter((t) => t.spec && /\[BACKEND\]/i.test(t.title)).map((t) => t.id));
    try {
      const [s, envs, rs, j, pl, st] = await Promise.all([qa.suite(id, { projectName: project.name, draftIds: [...project.draftIds] }), qa.environments(), qa.runs(id), qa.latestJob(id), qa.pipeline(id).catch(() => null), qa.store().catch(() => null)]);
      if (project.id !== id) return;
      storeStatus = st;
      // QA Cockpit lists projects and reads their TADs from the store (best effort, unchanged = no write).
      void qa.upsertProject({ id, name: project.name, tads: tadRefs() }).catch(() => {});
      plan = pl?.plan ?? null;
      pipeline = pl?.pipeline ?? null;
      suite = s;
      environments = envs;
      if (!envs.some((e) => e.id === envId)) envId = envs[0]?.id ?? '';
      runs = rs;
      activeRun = rs[0] ?? null;
      if (j?.status === 'running') {
        job = j;
        void pollJob(j.id);
      }
      if (activeRun?.status === 'running') void pollRun(activeRun.id);
      showGenerate = !s?.flows.length && !plan;
    } catch (e) {
      toasts.show(`E2E: ${(e as Error).message}`, 'err');
    }
  }

  /** The project's TADs as QA sees them: title, Confluence page and Jira tickets (no draft content). */
  function tadRefs(): QATadRef[] {
    return projectDrafts(project, drafts).map((d) => ({
      draftId: d.id,
      title: draftTitle(d),
      ...(d.confluence?.pageId ? { confluencePageId: d.confluence.pageId } : {}),
      ...(d.confluence?.url ? { confluenceUrl: d.confluence.url } : {}),
      ...(d.source?.jiraKeys?.length ? { jiraKeys: [...d.source.jiraKeys] } : {}),
    }));
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function pollJob(id: string) {
    const projectId = project.id;
    while (project.id === projectId) {
      await sleep(POLL_MS);
      const j = await qa.job(id).catch(() => null);
      if (!j || project.id !== projectId) return;
      job = j;
      if (j.status === 'running') continue;
      if (j.status === 'done' && j.suite) {
        suite = j.suite;
        showGenerate = false;
        openFlows = new Set();
        toasts.show(`${j.suite.flows.length} flow E2E siap direview.`, 'ok');
      } else if (j.status === 'error') {
        toasts.show(`Gagal membuat skenario: ${j.error}`, 'err', 8000);
      }
      return;
    }
  }

  async function pollRun(id: string) {
    const projectId = project.id;
    while (project.id === projectId) {
      await sleep(POLL_MS);
      const r = await qa.run(projectId, id).catch(() => null);
      if (!r || project.id !== projectId) return;
      if (activeRun?.id === id) activeRun = r;
      runs = runs.map((x) => (x.id === id ? r : x));
      if (r.status !== 'running') {
        const s = r.summary;
        toasts.show(`E2E selesai: ${s.passedFlows}/${s.flows} flow lulus.`, s.passedFlows === s.flows ? 'ok' : 'err', 5000);
        return;
      }
    }
  }

  function request(): QAGenerateRequest | null {
    const picked = tasks.filter((t) => selectedTasks.has(t.id) && t.spec);
    if (!picked.length) {
      toasts.show('Pilih minimal satu task yang punya Detail Task.', 'err');
      return null;
    }
    return {
      projectId: project.id,
      projectName: project.name,
      ai,
      tasks: picked.map((t) => ({ title: t.title, tadTitle: t.tadTitle, service: t.service, jiraKey: t.jiraKeys[0], spec: t.spec })),
      prdMarkdown: prdContext(projectDrafts(project, drafts)),
      categories: [...categories],
      instructions,
      // Its databases (if any) let the AI use real data and data checks.
      environmentId: envId || undefined,
      useCodebase: useCodebase && canReadCode,
      servicesRoot,
    };
  }

  /** Step 1 of the pipeline: the planner agent maps the journey; writers run after the review. */
  async function startPlan() {
    const req = request();
    if (!req) return;
    if (plan) {
      const ok = await confirmDialog({ title: 'Buat ulang rencana?', message: 'Rencana journey yang ada (termasuk editanmu) diganti hasil agent perencana baru. Test case tidak berubah sampai agent penulis dijalankan.', confirmText: 'Buat ulang' });
      if (!ok) return;
    }
    try {
      pipeline = await qa.startPlan(req);
      showGenerate = false;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function reloadSuite() {
    const id = project.id;
    const s = await qa.suite(id).catch(() => null);
    if (s && project.id === id) suite = s;
  }

  /** After a run: one repair agent per failed flow (fix the test, or flag a service bug). */
  async function repair(r: QARun) {
    const failed = r.flows.filter((f) => f.status === 'failed' || f.status === 'error').length;
    const ok = await confirmDialog({
      title: 'Perbaiki otomatis?',
      message: `${failed} test case gagal dianalisa agent perbaikan (membaca kode service, hanya baca). Test yang keliru diganti versi perbaikan; dugaan bug service masuk daftar "Dugaan bug". Jalankan ulang setelahnya untuk memastikan.`,
      confirmText: 'Mulai',
    });
    if (!ok) return;
    try {
      pipeline = await qa.repairRun(project.id, r.id);
      toasts.show('Agent perbaikan berjalan di background (juga di Agent Tasks).', 'ok');
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  // Fix by instruction: an agent reads the code and the latest run, and changes only what the instruction asks.
  let fixOpen = $state(false);
  let fixInstruction = $state('');
  /** 'checked' = flows ticked to run, 'visible' = the search result, else one flow id. */
  let fixScope = $state<'checked' | 'visible' | string>('checked');
  const FIX_PRESETS = [
    'Sesuaikan tipe data setiap field request dengan struct request di kode (string vs number vs boolean); nomor HP, nomor rekening, kode, dan id bertipe string wajib string.',
    'Perbaiki test yang gagal di run terakhir: cocokkan path, method, header, field, dan ekspektasi dengan router/handler dan response service.',
    'Samakan nama field request dan path dengan kode (tag json di struct dan router), termasuk prefix group.',
  ];
  const fixFlowIds = $derived.by(() => {
    if (fixScope === 'checked') return enabledFlows.map((f) => f.id);
    if (fixScope === 'visible') return visibleFlows.map((f) => f.id);
    return (suite?.flows ?? []).some((f) => f.id === fixScope) ? [fixScope] : [];
  });
  const fixSingle = $derived(fixScope !== 'checked' && fixScope !== 'visible' ? suite?.flows.find((f) => f.id === fixScope) : undefined);

  function openFix(flowId?: string) {
    fixScope = flowId ?? 'checked';
    fixOpen = true;
    showGenerate = false;
  }

  async function startFix() {
    if (!fixInstruction.trim() || !fixFlowIds.length) return;
    try {
      pipeline = await qa.fixFlows(project.id, fixFlowIds, fixInstruction, ai, env?.id);
      fixOpen = false;
      toasts.show(`Agent perbaikan memeriksa ${fixFlowIds.length} test case di background (juga di Agent Tasks).`, 'ok');
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  // Every test case ready to execute: variables without a real value are filled from the services'
  // databases by the fix agent (background, undoable), no manual values.
  const MAX_FILL_FLOWS = 80;
  const readiness = $derived(suite ? notReady(suite.flows, env) : new Map<string, string[]>());
  const fillPlan = $derived(suite ? dbFillPlan(suite.flows, env) : null);
  const envHasDb = $derived(Boolean(env?.databases?.length));
  async function fillFromDb() {
    if (!fillPlan || !env) return;
    if (!fillPlan.flowIds.length) return toasts.show(fillPlan.manual.length ? 'Yang tersisa hanya kredensial; isi sekali di Variabel rahasia environment.' : 'Semua variabel sudah punya nilai.', 'info');
    const ids = fillPlan.flowIds.slice(0, MAX_FILL_FLOWS);
    try {
      pipeline = await qa.fixFlows(project.id, ids, fillPlan.instruction, ai, env.id);
      const rest = fillPlan.flowIds.length - ids.length;
      toasts.show(`Agent mengisi ${fillPlan.vars.length} variabel dari database untuk ${ids.length} test case di background.${rest ? ` ${rest} test case lagi menyusul: klik lagi setelah selesai.` : ''}`, 'ok', 7000);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function undoFix() {
    if (!suite?.undo) return;
    const ok = await confirmDialog({ title: 'Batalkan perbaikan AI?', message: `${suite.undo.flows.length} test case dikembalikan ke versi sebelum perbaikan "${suite.undo.label}".`, confirmText: 'Kembalikan' });
    if (!ok) return;
    try {
      suite = await qa.undoFix(project.id);
      toasts.show('Test case dikembalikan.', 'ok', 2000);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  /** A suspect from a repair agent becomes a Bug Tracing case (with the failing request). */
  async function suspectToBug(sp: QASuspect) {
    if (!suite) return;
    const r = runs.find((x) => x.id === sp.runId);
    const flow = r?.flows.find((f) => f.flowId === sp.flowId);
    const bad = flow?.steps.find((st) => st.status === 'failed' || st.status === 'error');
    const evidence = bad
      ? `\n\nStep gagal: ${bad.name}${bad.request ? `\n${bad.request.method} ${bad.request.url}` : ''}${bad.response ? `\nHTTP ${bad.response.status}\n${(bad.response.body ?? '').slice(0, 2000)}` : ''}${bad.assertions.filter((a) => !a.passed).map((a) => `\n✗ ${a.message}`).join('')}${bad.curl ? `\n\n${bad.curl}` : ''}`
      : '';
    try {
      const c = await bugs.create({ title: sp.title.slice(0, 200), description: `Dari E2E "${sp.flowName}"${sp.service ? ` (${sp.service})` : ''}:\n${sp.detail}${evidence}` });
      await persist({ ...suite, suspects: (suite.suspects ?? []).map((x) => (x.flowId === sp.flowId && x.runId === sp.runId ? { ...x, bugCaseId: c.id } : x)) });
      location.hash = `#/bugs/${c.id}`;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function dismissSuspect(sp: QASuspect) {
    if (suite) await persist({ ...suite, suspects: (suite.suspects ?? []).filter((x) => x !== sp) });
  }

  async function generate() {
    const req = request();
    if (!req) return;
    if (!append && suite?.flows.length) {
      const ok = await confirmDialog({ title: 'Ganti skenario?', message: `${suite.flows.length} flow yang ada akan diganti hasil generate baru. Pilih "Tambahkan ke flow yang ada" untuk menyimpannya.`, confirmText: 'Ganti' });
      if (!ok) return;
    }
    try {
      job = await qa.generate({ ...req, existing: append ? $state.snapshot(suite?.flows ?? []) : undefined });
      void pollJob(job.id);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function cancelGenerate() {
    if (job) job = await qa.cancelJob(job.id).catch(() => job);
  }

  async function persist(next: QASuite) {
    try {
      suite = await qa.saveSuite($state.snapshot(next) as QASuite);
    } catch (e) {
      if (await handleConflict(e, () => load(project.id))) return;
      toasts.show(`Gagal menyimpan: ${(e as Error).message}`, 'err');
    }
  }

  /** Moves a flow one place within its group (the order flows run and pass data in). */
  async function moveFlow(flow: QAFlow, d: -1 | 1) {
    if (suite) await persist(moveFlowInGroup($state.snapshot(suite) as QASuite, flow.id, d));
  }

  // Groups: a flow's group is its `stage`; the suite keeps their order and the empty ones.
  const NEW_GROUP = '\u0000new';
  const searching = $derived(Boolean(flowQuery.trim() || flowCategory || flowResult));
  const groupNames = $derived(suite ? groupOrder(suite) : []);
  const shownGroups = $derived(suite ? groupFlows(suite, searching ? new Set(visibleFlows.map((f) => f.id)) : undefined) : []);
  /** Group names the journey plan uses: a writer agent replaces those groups' flows by name. */
  /** All flows of a group (not only a search's matches), for its counts. */
  const groupMembers = (name: string) => (suite?.flows ?? []).filter((f) => cleanGroupName(f.stage) === name);
  const planStage = (name: string) => Boolean(name && plan?.stages.some((st) => st.title === name));
  let newGroupOpen = $state(false);
  let newGroupName = $state('');
  /** Group being renamed, and the flow whose "move to a new group" box is open. */
  let renaming = $state<string | null>(null);
  let renameText = $state('');
  let newGroupFor = $state<string | null>(null);
  let newGroupForName = $state('');
  /** Name boxes open with the cursor in them and the current name selected. */
  const focusNow = (el: HTMLInputElement) => {
    el.focus();
    el.select();
  };

  /** Applies a group change; a bad name (empty, taken) is shown instead of saved. */
  async function changeGroups(fn: (s: QASuite) => QASuite): Promise<boolean> {
    // A project without test cases yet can still get its groups first.
    const base = suite ? ($state.snapshot(suite) as QASuite) : { projectId: project.id, projectName: project.name, flows: [], updatedAt: new Date().toISOString() };
    let next: QASuite;
    try {
      next = fn(base);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
      return false;
    }
    await persist(next);
    return true;
  }

  async function createGroup() {
    if (await changeGroups((s) => addGroup(s, newGroupName))) {
      newGroupName = '';
      newGroupOpen = false;
    }
  }

  function startRename(name: string) {
    renaming = name;
    renameText = name;
  }

  async function saveRename(from: string) {
    if (renameText.trim() === from) return void (renaming = null);
    if (
      planStage(from) &&
      !(await confirmDialog({
        title: 'Ganti nama tahap rencana?',
        message: `"${from}" adalah tahap di rencana journey. Bila tahap ini nanti ditulis ulang oleh agent, test case-nya masuk lagi ke grup "${from}", dan flow di grup yang sudah diganti namanya tidak ikut diganti.`,
        confirmText: 'Ganti nama',
      }))
    )
      return;
    if (await changeGroups((s) => renameGroup(s, from, renameText))) renaming = null;
  }

  async function deleteGroup(name: string) {
    const count = suite?.flows.filter((f) => f.stage === name).length ?? 0;
    const ok = await confirmDialog({
      title: 'Hapus grup?',
      message: `Hapus grup "${name}"?${count ? ` ${count} flow di dalamnya pindah ke "${UNGROUPED_LABEL}", tidak ikut terhapus.` : ''}${planStage(name) ? ' Grup ini tahap di rencana journey: bila tahapnya ditulis ulang, grupnya dibuat lagi.' : ''}`,
      confirmText: 'Hapus grup',
      danger: true,
    });
    if (ok) await changeGroups((s) => removeGroup(s, name));
  }

  function toggleGroup(name: string, enabled: boolean) {
    if (suite) void persist({ ...($state.snapshot(suite) as QASuite), flows: setGroupEnabled(suite.flows, name, enabled) });
  }

  function pickGroup(flow: QAFlow, select: HTMLSelectElement) {
    if (select.value === NEW_GROUP) {
      select.value = flow.stage ?? '';
      newGroupFor = flow.id;
      newGroupForName = '';
      return;
    }
    void changeGroups((s) => moveFlowToGroup(s, flow.id, select.value));
  }

  async function moveToNewGroup(flow: QAFlow) {
    const name = newGroupForName;
    if (await changeGroups((s) => moveFlowToGroup(addGroup(s, name), flow.id, name))) newGroupFor = null;
  }

  function toggleFlow(flow: QAFlow) {
    if (!suite) return;
    void persist({ ...suite, flows: suite.flows.map((f) => (f.id === flow.id ? { ...f, enabled: !f.enabled } : f)) });
  }

  /** All flows, or only the ones a search or filter shows (e.g. check just the failed ones to run again). */
  function setAll(enabled: boolean) {
    if (!suite) return;
    const shown = new Set(visibleFlows.map((f) => f.id));
    void persist({ ...suite, flows: suite.flows.map((f) => (!searching || shown.has(f.id) ? { ...f, enabled } : f)) });
  }

  async function removeFlow(flow: QAFlow) {
    if (!suite) return;
    const ok = await confirmDialog({ title: 'Hapus flow?', message: `Hapus flow "${flow.name}"?`, confirmText: 'Hapus', danger: true });
    if (ok) void persist({ ...suite, flows: suite.flows.filter((f) => f.id !== flow.id) });
  }

  function startEdit(flow: QAFlow) {
    editingId = flow.id;
    openFlows = new Set([...openFlows, flow.id]);
  }

  function addFlow(group = '') {
    const flow: QAFlow = {
      id: crypto.randomUUID(),
      name: 'Flow baru',
      ...(group ? { stage: group } : {}),
      description: '',
      category: 'happy-path',
      taskTitles: [],
      variables: {},
      enabled: true,
      steps: [{ id: crypto.randomUUID(), name: 'Step 1', service: services[0], request: { method: 'GET', path: '/health' }, assertions: [{ type: 'status', op: 'equals', expected: 200 }] }],
    };
    suite = suite ?? { projectId: project.id, projectName: project.name, flows: [], updatedAt: new Date().toISOString() };
    suite = withGroups({ ...suite, flows: [...suite.flows, flow] });
    startEdit(flow);
  }

  /** Saves a flow from the form editor; returns an error message to show in the editor. */
  async function saveFlow(flow: QAFlow): Promise<string | void> {
    if (!suite) return;
    const flows = suite.flows.map((f) => (f.id === flow.id ? flow : f));
    try {
      suite = await qa.saveSuite({ ...($state.snapshot(suite) as QASuite), flows });
      editingId = null;
      toasts.show('Test case tersimpan.', 'ok', 1500);
    } catch (e) {
      if (await handleConflict(e, () => load(project.id))) return 'Test case ini sudah diubah orang lain; muat ulang lalu ulangi perubahan Anda.';
      return (e as Error).message;
    }
  }
  const selectedEnv = $derived(environments.find((e) => e.id === envId));

  async function cancelEdit() {
    editingId = null;
    // A new, never-saved flow disappears again.
    suite = (await qa.suite(project.id).catch(() => suite)) ?? suite;
  }

  async function run(flowIds?: string[]) {
    if (!env) {
      envModalOpen = true;
      return toasts.show('Pilih atau buat environment dulu.', 'err');
    }
    const count = flowIds?.length ?? enabledFlows.length;
    if (!count) return toasts.show('Centang minimal satu flow.', 'err');
    const picked = (suite?.flows ?? []).filter((f) => (flowIds ? flowIds.includes(f.id) : f.enabled));
    const writes = picked.some((f) => f.steps.some((s) => s.request.method !== 'GET'));
    // Steps that change data straight in a database (setup) are named before anything runs.
    const setups = picked.flatMap((f) => f.steps.flatMap((s) => s.setup ?? []));
    if ((writes || setups.length) && !env.readOnly) {
      const dbs = [...new Set(setups.map((s) => s.db))].join(', ');
      const ok = await confirmDialog({
        title: 'Jalankan E2E?',
        message: `${count} flow akan mengirim request (termasuk POST/PUT/PATCH/DELETE) ke "${env.name}". Data di server tersebut bisa berubah.${setups.length ? env.dbWrites ? ` ${setups.length} step juga mengubah data langsung di database (${dbs}) sebelum request-nya.` : ` ${setups.length} step punya ubah data DB, tapi environment ini tidak mengizinkannya: step itu akan gagal.` : ''}`,
        confirmText: 'Ya, jalankan',
      });
      if (!ok) return;
    }
    starting = true;
    try {
      const r = await qa.startRun({ projectId: project.id, environmentId: env.id, flowIds });
      runs = [r, ...runs];
      activeRun = r;
      tab = 'results';
      openSteps = new Set();
      void pollRun(r.id);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      starting = false;
    }
  }

  async function showRun(id: string) {
    activeRun = runs.find((r) => r.id === id) ?? null;
    openSteps = new Set();
    if (activeRun && !activeRun.flows.length) activeRun = await qa.run(project.id, id).catch(() => activeRun);
  }

  function copy(text: string, what: string) {
    void navigator.clipboard.writeText(text);
    toasts.show(`${what} disalin.`, 'ok', 1500);
  }

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  const STATUS: Record<QAStepStatus, { label: string; cls: string; icon: 'check' | 'x' | 'alert' | 'clock' | 'lock' }> = {
    pending: { label: 'Menunggu', cls: '', icon: 'clock' },
    running: { label: 'Berjalan', cls: 'st-run', icon: 'clock' },
    passed: { label: 'Lulus', cls: 'st-ok', icon: 'check' },
    failed: { label: 'Gagal', cls: 'st-err', icon: 'x' },
    error: { label: 'Error', cls: 'st-err', icon: 'alert' },
    skipped: { label: 'Dilewati', cls: '', icon: 'clock' },
    blocked: { label: 'Diblokir', cls: 'st-warn', icon: 'lock' },
  };

  const pretty = (body?: string) => {
    if (!body) return '(kosong)';
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  };
  // By position: a run's steps never reorder, and older runs can repeat a step id.
  const stepKey = (flowId: string, i: number) => `${flowId}:${i}`;
</script>

<div class="e2e">
  <header class="head">
    <div>
      <h2>E2E Test Flow</h2>
      <p class="muted small">Skenario API end-to-end dari Detail Task semua TAD di proyek ini, dijalankan langsung dari laptop ke server pilihanmu.</p>
    </div>
    <div class="head-actions">
      <select class="input env-select" bind:value={envId} aria-label="Environment">
        {#if !environments.length}<option value="">Belum ada environment</option>{/if}
        {#each environments as e (e.id)}
          <option value={e.id}>{e.name}{e.readOnly ? ' (read-only)' : ''}</option>
        {/each}
      </select>
      <button class="btn btn-sm" onclick={() => (envModalOpen = true)}><Icon name="plug" size={13} /> Environment</button>
      <button class="btn btn-sm" class:btn-primary={showGenerate} onclick={() => (showGenerate = !showGenerate)} disabled={generating || pipelineBusy}><Icon name="sparkles" size={13} /> Generate</button>
      <button class="btn btn-primary btn-sm" onclick={() => run()} disabled={running || starting || !enabledFlows.length}>
        <Icon name="play" size={13} /> {running ? 'Berjalan…' : `Jalankan ${enabledFlows.length} flow`}
      </button>
    </div>
  </header>

  <SuiteReview projectId={project.id} projectName={project.name} bind:suite onreload={() => load(project.id)} />

  {#if generating}
    <div class="banner">
      <span class="spinner" aria-hidden="true"></span>
      <span>AI menyusun skenario E2E… <span class="muted">{job?.progress ?? ''}</span></span>
      <button class="btn btn-sm" onclick={cancelGenerate}>Batalkan</button>
    </div>
  {:else if showGenerate}
    <section class="card gen">
      <div class="gen-grid">
        <div>
          <h3>Task yang dites</h3>
          {#if !tasks.length}
            <p class="muted small">TAD di proyek ini belum berisi task di Development Scope.</p>
          {/if}
          <div class="task-list">
            {#each tasks as t (t.id)}
              <label class="check" class:disabled={!t.spec} title={t.spec ? '' : 'Detail Task untuk task ini belum ada'}>
                <input type="checkbox" checked={selectedTasks.has(t.id)} disabled={!t.spec} onchange={() => (selectedTasks = toggle(selectedTasks, t.id))} />
                <span class="mono task-title">{t.title}</span>
                {#if multiTad}<span class="chip">{t.tadTitle}</span>{/if}
                {#if !t.spec}<span class="chip chip-warn">tanpa Detail Task</span>{/if}
              </label>
            {/each}
          </div>
        </div>
        <div class="gen-side">
          <h3>Jenis skenario</h3>
          <div class="cats">
            {#each QA_CATEGORIES as c (c)}
              <label class="check"><input type="checkbox" checked={categories.has(c)} onchange={() => (categories = toggle(categories as Set<string>, c) as Set<QACategory>)} /> {QA_CATEGORY_LABELS[c]}</label>
            {/each}
          </div>
          <label class="field">
            <span>Instruksi tambahan (opsional)</span>
            <textarea class="input" rows="3" bind:value={instructions} placeholder="mis. fokus ke refund parsial, gunakan merchant {'{{merchantId}}'}"></textarea>
          </label>
          <AiPicker value={ai} onchange={(s) => (ai = s)} />
          {#if suite?.flows.length}
            <label class="check small"><input type="checkbox" bind:checked={append} /> Tambahkan ke {suite.flows.length} flow yang ada</label>
          {/if}
          <button class="btn btn-primary" onclick={startPlan} disabled={!selectedTasks.size || pipelineBusy} title="Agent perencana memetakan journey (tahap, endpoint dengan bukti file:line, variabel). Kamu review, lalu agent penulis menulis test case per tahap secara paralel.">
            <Icon name="sparkles" size={14} /> {plan ? 'Buat ulang rencana journey' : 'Buat rencana journey'} (multi-agent)
          </button>
          <button class="btn btn-sm" onclick={generate} disabled={!selectedTasks.size || pipelineBusy} title="Satu agent menulis semua test case sekaligus (lebih cepat, kurang teliti untuk TAD besar)">Generate sekaligus (1 agent)</button>
          <label class="check small codebase-opt" class:off={!canReadCode}>
            <input type="checkbox" bind:checked={useCodebase} disabled={!canReadCode} />
            <span>
              <strong>Cek ke codebase</strong> (hanya baca): AI mencocokkan path, method, field request, response, dan health check dengan router/handler di <code>{servicesRoot}</code>.
              {#if !canReadCode}<em>Butuh Claude CLI atau Antigravity; provider API tidak bisa membaca file.</em>{/if}
            </span>
          </label>
          {#if environments.find((e) => e.id === envId)?.databases?.length}
            {@const dbs = environments.find((e) => e.id === envId)?.databases ?? []}
            <p class="db-note small"><Icon name="check" size={12} /> Database environment ini ({dbs.map((d) => d.name).join(', ')}) ikut dipakai: AI membaca skema tabelnya untuk mengambil data nyata sebagai variabel dan memeriksa data setelah request. Hanya SELECT, read-only.</p>
          {:else}
            <p class="muted small">Tambahkan database di environment (tombol pengaturan environment) agar test memakai data nyata dari DB.</p>
          {/if}
          <p class="muted small">AI menerima Detail Task, PRD, skema tabel (tanpa isi data), dan bila dicentang membaca kode service tanpa mengubahnya. Token dan password tidak pernah dikirim ke AI.</p>
        </div>
      </div>
    </section>
  {/if}

  <E2EPipeline projectId={project.id} bind:plan bind:pipeline existingFlows={suite?.flows.length ?? 0} onsuite={reloadSuite} />

  {#each tadRunning as d (d.id)}
    <div class="banner"><span class="spinner" aria-hidden="true"></span><span>AI memperbarui TAD <strong>{draftTitle(d)}</strong> dari temuan E2E…</span></div>
  {/each}
  {#each tadProposals.filter((d) => !tadRunning.includes(d)) as d (d.id)}
    <div class="banner tad-ready">
      <Icon name="sparkles" size={14} />
      <span>Usulan perubahan TAD <strong>{draftTitle(d)}</strong> menunggu review.</span>
      <button class="btn btn-sm btn-primary" onclick={() => openTadReview(d.id)}><Icon name="eye" size={13} /> Review di TAD</button>
    </div>
  {/each}

  {#if coderRuns.length}
    <section class="code-fixes" id="e2e-code-fixes">
      <h3 class="small"><Icon name="code" size={13} /> Perbaikan kode dari test yang gagal</h3>
      <AgentRunsPanel draft={fixDraft} refreshKey={coderKey} />
    </section>
  {/if}

  <div class="tabs">
    <button class:active={tab === 'flows'} onclick={() => (tab = 'flows')}>Skenario ({suite?.flows.length ?? 0})</button>
    <button class:active={tab === 'results'} onclick={() => (tab = 'results')}>Hasil Run {#if runs.length}({runs.length}){/if}</button>
    {#if storeStatus}
      <span class="store-chip muted small" title={storeStatus.mode === 'postgres' ? `Dipakai bersama QA: ${storeStatus.target ?? ''}` : 'Hanya di laptop ini. Atur DB pusat di Koneksi → Penyimpanan E2E.'}>
        <Icon name={storeStatus.mode === 'postgres' ? 'database' : 'save'} size={12} />
        {storeStatus.mode === 'postgres' ? 'DB pusat' : 'Lokal'}
      </span>
    {/if}
  </div>

  <div class="body">
    {#if tab === 'flows'}
      <!-- The keys the selected environment still needs for the flows that will run (inside the scroll area: it can be long). -->
      {#if suite?.flows.length}
        {#if !readiness.size}
          <div class="banner ready-ok small"><Icon name="check" size={14} /> Semua {suite.flows.length} test case siap dijalankan: setiap variabel punya nilai{env ? ` di ${env.name}` : ''}.</div>
        {:else}
          <div class="banner ready-todo small">
            <Icon name="alert" size={14} />
            <span>
              <strong>{readiness.size} dari {suite.flows.length} test case belum siap dijalankan</strong>: {fillPlan?.vars.length ?? 0} variabel belum punya nilai asli{fillPlan?.manual.length ? `, ${fillPlan.manual.length} kredensial (${fillPlan.manual.map((v) => v.name).join(', ')}) diisi sekali di Variabel rahasia environment` : ''}.
              {#if !envHasDb}<span class="muted"> Tambahkan database di environment agar bisa diisi otomatis.</span>{/if}
            </span>
            {#if envHasDb && fillPlan?.flowIds.length}
              <button class="btn btn-sm btn-primary" onclick={fillFromDb} disabled={pipelineBusy} title="Agent membaca skema database service terkait dan menambahkan query data (SELECT, read-only) ke test case yang memakai variabel itu. Bisa dibatalkan."><Icon name="sparkles" size={13} /> Isi otomatis dari database</button>
            {:else if !envHasDb}
              <button class="btn btn-sm" onclick={() => (envModalOpen = true)}>Atur database</button>
            {/if}
          </div>
        {/if}
      {/if}
      <E2ERequirements flows={enabledFlows} {env} bind:environments onopenenv={() => (envModalOpen = true)} />
      {#if suite?.notes}
        <details class="notes card">
          <summary><Icon name="alert" size={13} /> Asumsi & pertanyaan dari AI</summary>
          <p>{suite.notes}</p>
        </details>
      {/if}
      {#if !suite?.flows.length && !suite?.groups?.length}
        <div class="empty muted">
          <Icon name="list" size={24} />
          <p>Belum ada skenario. Klik <strong>Generate</strong> untuk membuat dari Detail Task, atau tambah manual.</p>
          <div class="empty-actions">
            <button class="btn btn-sm" onclick={() => addFlow()}><Icon name="plus" size={13} /> Tambah flow manual</button>
            <button class="btn btn-sm" class:btn-primary={newGroupOpen} onclick={() => (newGroupOpen = !newGroupOpen)}><Icon name="plus" size={13} /> Grup baru</button>
          </div>
        </div>
        {#if newGroupOpen}{@render groupForm()}{/if}
      {:else if suite}
        <div class="list-tools">
          <label class="flow-search">
            <Icon name="search" size={13} />
            <input type="search" bind:value={flowQuery} placeholder="Cari test case: nama, task, step, endpoint…" aria-label="Cari test case" />
          </label>
          <select class="input cat-select" bind:value={flowCategory} aria-label="Filter kategori">
            <option value="">Semua kategori</option>
            {#each QA_CATEGORIES as c (c)}<option value={c}>{QA_CATEGORY_LABELS[c]}</option>{/each}
          </select>
          {#if searching}<span class="muted small">{visibleFlows.length} dari {suite.flows.length}</span>{/if}
          <button class="btn btn-ghost btn-sm" onclick={() => setAll(true)}>{searching ? 'Centang yang tampil' : 'Centang semua'}</button>
          <button class="btn btn-ghost btn-sm" onclick={() => setAll(false)}>{searching ? 'Kosongkan yang tampil' : 'Kosongkan'}</button>
          <span class="grow"></span>
          <button class="btn btn-sm" class:btn-primary={fixOpen} onclick={() => (fixOpen ? (fixOpen = false) : openFix())} disabled={pipelineBusy} title="AI memperbaiki test case sesuai instruksimu (membaca kode, hanya baca)"><Icon name="sparkles" size={13} /> Perbaiki dengan AI</button>
          <button class="btn btn-sm" onclick={openTadUpdate} disabled={!projectTads.length} title="Kirim temuan E2E yang kelewat atau ambigu di TAD ke AI untuk memperbarui TAD (diusulkan dulu, direview di TAD)"><Icon name="doc" size={13} /> Update TAD dari temuan{findings.filter((f) => f.suggested).length ? ` (${findings.filter((f) => f.suggested).length})` : ''}</button>
          <button class="btn btn-sm" class:btn-primary={newGroupOpen} onclick={() => (newGroupOpen = !newGroupOpen)} title="Grup untuk mengelompokkan test case (urutan grup = urutan run)"><Icon name="plus" size={13} /> Grup baru</button>
          <button class="btn btn-sm" onclick={() => addFlow()}><Icon name="plus" size={13} /> Flow manual</button>
        </div>
        <div class="result-filter" role="group" aria-label="Filter hasil run terakhir">
          {#if fixable.length}
            <button class="btn btn-sm fix-all-btn" onclick={openBulkFix} title="Coder agent memperbaiki kode untuk beberapa test yang gagal sekaligus: satu run per repo, repo berbeda berjalan paralel"><Icon name="code" size={13} /> Perbaiki kode ({fixable.length} gagal)</button>
          {/if}
          <span class="muted small">Hasil terakhir{env ? ` di ${env.name}` : ''}:</span>
          {#each RESULT_FILTERS as rf (rf.value)}
            <button class="chip filter-chip rf-{rf.value || 'all'}" class:active={flowResult === rf.value} onclick={() => (flowResult = rf.value)} aria-pressed={flowResult === rf.value}>
              {rf.label} <strong>{rf.value ? totals[rf.value] : suite.flows.length}</strong>
            </button>
          {/each}
        </div>
        {#if newGroupOpen}{@render groupForm()}{/if}
        {#if suite.undo?.flows.length}
          <div class="undo-bar small">
            <Icon name="history" size={13} />
            <span>Perbaikan AI "<em>{suite.undo.label.length > 90 ? `${suite.undo.label.slice(0, 90)}…` : suite.undo.label}</em>" mengubah {suite.undo.flows.length} test case.</span>
            <button class="btn btn-ghost btn-sm" onclick={undoFix} disabled={pipelineBusy}>Batalkan perbaikan</button>
          </div>
        {/if}
        {#if fixOpen}
          <section class="card fix">
            <h3><Icon name="sparkles" size={14} /> Perbaiki test case dengan AI</h3>
            <label class="field">
              <span>Instruksi</span>
              <textarea class="input" rows="3" bind:value={fixInstruction} placeholder="mis. field msisdn dan account_no harus string, bukan integer; cek struct request di core-promo-ultimate"></textarea>
            </label>
            <div class="presets">
              {#each FIX_PRESETS as p (p)}
                <button class="chip preset" onclick={() => (fixInstruction = p)} title={p}>{p.split(':')[0].split(';')[0].slice(0, 70)}</button>
              {/each}
            </div>
            <div class="fix-row">
              <label class="field">
                <span>Test case</span>
                <select class="input" bind:value={fixScope}>
                  <option value="checked">Yang dicentang ({enabledFlows.length})</option>
                  {#if flowQuery || flowCategory}<option value="visible">Hasil pencarian ({visibleFlows.length})</option>{/if}
                  {#if fixSingle}<option value={fixSingle.id}>Hanya: {fixSingle.name}</option>{/if}
                </select>
              </label>
              <AiPicker value={ai} onchange={(s) => (ai = s)} />
            </div>
            <p class="muted small">Agent membaca kode service (struct request, router, handler; hanya baca) dan hasil run terakhir, lalu hanya mengubah yang diminta. Tiap test case yang berubah diberi catatan, dan versi sebelumnya bisa dikembalikan.{#if !canReadCode} <em>Provider ini tidak bisa membaca kode; pakai Claude CLI atau Antigravity untuk cek tipe ke struct.</em>{/if}</p>
            <div class="fix-actions">
              <button class="btn btn-primary btn-sm" onclick={startFix} disabled={!fixInstruction.trim() || !fixFlowIds.length || pipelineBusy}><Icon name="sparkles" size={13} /> Perbaiki {fixFlowIds.length} test case</button>
              <button class="btn btn-ghost btn-sm" onclick={() => (fixOpen = false)}>Tutup</button>
            </div>
          </section>
        {/if}
        {#if searching && !visibleFlows.length}
          <p class="muted small">Tidak ada test case yang cocok. <button class="link-btn" onclick={() => { flowQuery = ''; flowCategory = ''; }}>Reset pencarian</button></p>
        {/if}
        {#each shownGroups as group, gi (group.name)}
          {@const check = groupCheck(suite.flows, group.name)}
          <div class="group-head">
            <input
              type="checkbox"
              checked={check.state === 'all'}
              indeterminate={check.state === 'some'}
              disabled={!check.total}
              onchange={() => toggleGroup(group.name, check.state !== 'all')}
              aria-label="Centang semua flow di grup {group.name || UNGROUPED_LABEL}"
            />
            {#if group.name && renaming === group.name}
              <form class="rename" onsubmit={(e) => { e.preventDefault(); void saveRename(group.name); }}>
                <input class="input" bind:value={renameText} maxlength="120" aria-label="Nama grup" {@attach focusNow} onkeydown={(e) => e.key === 'Escape' && (renaming = null)} />
                <button class="btn btn-primary btn-sm" type="submit" disabled={!renameText.trim()}>Simpan</button>
                <button class="btn btn-ghost btn-sm" type="button" onclick={() => (renaming = null)}>Batal</button>
              </form>
            {:else}
              <h4 class="stage-head" class:loose={!group.name}>{group.name || UNGROUPED_LABEL}</h4>
            {/if}
            <span class="muted small count" title="Flow yang dicentang untuk dijalankan">{check.checked}/{check.total}</span>
            {#if check.total}
              {@const rc = resultCounts(groupMembers(group.name), latest)}
              <span class="small group-results" title="Hasil run terakhir flow di grup ini">
                {#if rc.passed}<span class="res-ok">✓ {rc.passed} lulus</span>{/if}
                {#if rc.failed}<span class="res-err">✗ {rc.failed} gagal</span>{/if}
                {#if rc.none}<span class="muted">{rc.none} belum</span>{/if}
              </span>
            {/if}
            <span class="grow"></span>
            <span class="flow-actions">
              <button class="btn btn-ghost btn-sm" onclick={() => addFlow(group.name)} title="Tambah flow manual di grup ini" aria-label="Tambah flow di grup {group.name || UNGROUPED_LABEL}"><Icon name="plus" size={13} /></button>
              {#if group.name}
                <button class="btn btn-ghost btn-sm order-btn" onclick={() => changeGroups((s) => moveGroup(s, group.name, -1))} disabled={groupNames[0] === group.name || searching} title="Naikkan grup (urutan run)" aria-label="Naikkan grup">↑</button>
                <button class="btn btn-ghost btn-sm order-btn" onclick={() => changeGroups((s) => moveGroup(s, group.name, 1))} disabled={groupNames.at(-1) === group.name || searching} title="Turunkan grup (urutan run)" aria-label="Turunkan grup">↓</button>
                <button class="btn btn-ghost btn-sm" onclick={() => startRename(group.name)} title="Ganti nama grup" aria-label="Ganti nama grup"><Icon name="edit" size={13} /></button>
                <button class="btn btn-ghost btn-sm" onclick={() => deleteGroup(group.name)} title="Hapus grup (flow-nya pindah ke {UNGROUPED_LABEL})" aria-label="Hapus grup"><Icon name="trash" size={13} /></button>
              {/if}
            </span>
          </div>
          {#if !group.flows.length}
            <p class="muted small group-empty">Grup ini masih kosong. Pindahkan flow ke sini lewat pilihan grup di kartu flow, atau tambah flow dengan tombol +.</p>
          {/if}
          {#each group.flows as flow (flow.id)}
          {@const edge = edgeOfGroup(suite, flow.id)}
          {@const res = latest.get(flow.id)}
          <article class="card flow" class:disabled={!flow.enabled}>
            <div class="flow-head">
              <input type="checkbox" checked={flow.enabled} onchange={() => toggleFlow(flow)} aria-label="Ikut dijalankan" />
              <span class="flow-meta">
              <button class="flow-title" onclick={() => (openFlows = toggle(openFlows, flow.id))} aria-expanded={openFlows.has(flow.id)} aria-label="Detail flow {flow.name}">
                <Icon name="chevron" size={13} />
                <strong>{flow.name}</strong>
              </button>
              <span class="chip">{QA_CATEGORY_LABELS[flow.category]}</span>
              <span class="muted small">{flow.steps.length} step</span>
              {#if running && (lastStatus[flow.id] === 'running' || lastStatus[flow.id] === 'pending')}
                <span class="badge {STATUS[lastStatus[flow.id]].cls}">{STATUS[lastStatus[flow.id]].label}</span>
              {/if}
              {#if fixByFlow.get(flow.id)}
                {@const fx = fixByFlow.get(flow.id)!}
                <button class="badge fix-badge" class:st-run={CODER_ACTIVE.includes(fx.status)} class:st-ok={fx.status === 'ready' || fx.status === 'pushed' || fx.status === 'completed'} class:st-warn={fx.status === 'needs-input'} class:st-err={fx.status === 'failed'} onclick={() => document.getElementById('e2e-code-fixes')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} title="Perbaikan kode oleh coder agent ({fx.repo} · {fx.branch}). Klik untuk ke panel Perbaikan kode."><Icon name="code" size={11} /> Perbaikan kode: {CODER_LABEL[fx.status] ?? fx.status}</button>
              {/if}
              {#if readiness.get(flow.id)}
                <span class="badge st-warn" title="Belum punya nilai: {readiness.get(flow.id)!.join(', ')}"><Icon name="alert" size={11} /> Belum siap · {readiness.get(flow.id)!.length} variabel</span>
              {/if}
              {#if res}
                <button class="badge result-badge {STATUS[res.status].cls}" onclick={() => openResult(res)} title={resultTitle(res)}>
                  <Icon name={STATUS[res.status].icon} size={11} /> {STATUS[res.status].label} · {shortTime(res.at)}
                </button>
              {:else}
                <span class="badge" title="Belum pernah dijalankan{env ? ` di ${env.name}` : ''}">Belum dijalankan</span>
              {/if}
              {#if flow.warnings?.length}
                <span class="badge st-warn" title={flow.warnings.join('\n')}><Icon name="alert" size={11} /> {flow.warnings.length} endpoint di luar rencana</span>
              {/if}
              {#if flow.repairNote}
                <span class="badge st-run" title={flow.repairNote}><Icon name="edit" size={11} /> diperbaiki agent</span>
              {/if}
              </span>
              <span class="flow-actions">
              <select class="input group-pick" value={flow.stage ?? ''} onchange={(e) => pickGroup(flow, e.currentTarget)} title="Pindah ke grup" aria-label="Grup flow {flow.name}">
                {#each groupNames as g (g)}<option value={g}>{g}</option>{/each}
                <option value="">{UNGROUPED_LABEL}</option>
                <option value={NEW_GROUP}>+ Grup baru…</option>
              </select>
              <button class="btn btn-ghost btn-sm order-btn" onclick={() => moveFlow(flow, -1)} disabled={edge.first} title="Naikkan di dalam grup (urutan journey)" aria-label="Naikkan">↑</button>
              <button class="btn btn-ghost btn-sm order-btn" onclick={() => moveFlow(flow, 1)} disabled={edge.last} title="Turunkan di dalam grup (urutan journey)" aria-label="Turunkan">↓</button>
              <button class="btn btn-ghost btn-sm" onclick={() => run([flow.id])} disabled={running || starting} title="Jalankan flow ini saja"><Icon name="play" size={13} /></button>
              <button class="btn btn-ghost btn-sm" onclick={() => openFix(flow.id)} disabled={pipelineBusy} title="Perbaiki test case ini dengan AI"><Icon name="sparkles" size={13} /></button>
              {#if resultBucket(res) === 'failed'}
                <button class="btn btn-ghost btn-sm fix-code-btn" onclick={() => openCodeFix(flow.id)} disabled={CODER_ACTIVE.includes(fixByFlow.get(flow.id)?.status ?? 'cancelled')} title="Perbaiki kode service dari kegagalan ini (coder agent di background, tanpa tiket)" aria-label="Perbaiki kode"><Icon name="code" size={13} /></button>
              {/if}
              <button class="btn btn-ghost btn-sm" onclick={() => startEdit(flow)} title="Edit test case"><Icon name="edit" size={13} /></button>
              <button class="btn btn-ghost btn-sm" onclick={() => removeFlow(flow)} title="Hapus flow"><Icon name="trash" size={13} /></button>
              </span>
            </div>
            {#if newGroupFor === flow.id}
              <form class="group-form" onsubmit={(e) => { e.preventDefault(); void moveToNewGroup(flow); }}>
                <label class="field grow">
                  <span>Pindahkan ke grup baru</span>
                  <input class="input" bind:value={newGroupForName} maxlength="120" placeholder="Nama grup" {@attach focusNow} />
                </label>
                <button class="btn btn-primary btn-sm" type="submit" disabled={!newGroupForName.trim()}>Pindahkan</button>
                <button class="btn btn-ghost btn-sm" type="button" onclick={() => (newGroupFor = null)}>Batal</button>
              </form>
            {/if}
            {#if openFlows.has(flow.id)}
              {#if flow.description}<p class="desc">{flow.description}</p>{/if}
              {#if flow.warnings?.length}
                <ul class="flow-warn small">{#each flow.warnings as w (w)}<li>⚠ {w}</li>{/each}</ul>
              {/if}
              {#if flow.repairNote}<p class="repair-note small"><Icon name="edit" size={11} /> {flow.repairNote}</p>{/if}
              {#if flow.taskTitles.length}<p class="muted small mono">Task: {flow.taskTitles.join(' · ')}</p>{/if}
              {#if editingId === flow.id}
                <FlowEditor
                  {flow}
                  {services}
                  serviceUrls={selectedEnv?.services ?? {}}
                  taskTitles={tasks.map((t) => t.title)}
                  databases={(selectedEnv?.databases ?? []).map((d) => d.name)}
                  groups={groupNames}
                  onsave={saveFlow}
                  oncancel={cancelEdit}
                />
              {:else}
                {#if flow.variables && Object.keys(flow.variables).length}
                  <p class="vars small" title="Nilai contoh dari AI; variabel environment dengan nama yang sama menimpanya">Variabel contoh: {#each Object.entries(flow.variables) as [k, v] (k)}<code>{k}={v}</code> {/each}</p>
                {/if}
                {#if flow.dataQueries?.length}
                  <div class="data-queries small">
                    <span class="muted">Data nyata dari database (diambil sebelum request pertama):</span>
                    {#each flow.dataQueries as q (q.name)}
                      <div class="dq"><code>{`{{${q.name}}}`}</code> ← <span class="muted">{q.db}{q.column ? `.${q.column}` : ''}</span> <code class="sql">{q.sql}</code></div>
                    {/each}
                  </div>
                {/if}
                <ol class="steps">
                  {#each flow.steps as step (step.id)}
                    <li>
                      {#each step.setup ?? [] as st, si (si)}
                        <div class="setup-line small" title="Dijalankan langsung di database sebelum request step ini{env?.dbWrites ? '' : ' (environment ini belum mengizinkan)'}"><Icon name="alert" size={11} /> Ubah data DB <strong>{st.db}</strong>: <code class="sql">{st.sql}</code></div>
                      {/each}
                      <div class="step-line">
                        <span class="method m-{step.request.method.toLowerCase()}">{step.request.method}</span>
                        <span class="mono path">{step.request.path}</span>
                        {#if step.service}<span class="chip">{step.service}</span>{/if}
                        {#if step.useEnvAuth === false}<span class="chip" title="Tidak memakai auth environment">tanpa auth env</span>{/if}
                      </div>
                      <div class="muted small">{step.name}</div>
                      <div class="asserts small">
                        {#each step.assertions as a, i (i)}
                          {#if a.type === 'db'}
                            <code class="dbq" title={a.sql}>DB {a.db}{a.column ? `.${a.column}` : ''} {a.op}{a.expected !== undefined ? ` ${JSON.stringify(a.expected)}` : ''}</code>
                          {:else}
                            <code>{a.type === 'status' ? `status ${Array.isArray(a.expected) ? a.expected.join('/') : a.expected}` : a.type === 'latency' ? `< ${a.expected}ms` : `${a.type === 'header' ? a.name : a.path} ${a.op}${a.expected !== undefined ? ` ${JSON.stringify(a.expected)}` : ''}`}</code>
                          {/if}
                        {/each}
                        {#each Object.entries(step.extract ?? {}) as [k, v] (k)}
                          <code class="extract">{`{{${k}}}`} ← {v}</code>
                        {/each}
                      </div>
                    </li>
                  {/each}
                </ol>
              {/if}
            {/if}
          </article>
          {/each}
        {/each}
      {/if}
    {:else}
      {#if !activeRun}
        <div class="empty muted"><Icon name="play" size={24} /><p>Belum ada run. Pilih environment lalu klik <strong>Jalankan</strong>.</p></div>
      {:else}
        <div class="run-head">
          <select class="input" value={activeRun.id} onchange={(e) => showRun(e.currentTarget.value)} aria-label="Riwayat run">
            {#each runs as r (r.id)}
              <option value={r.id}>{new Date(r.startedAt).toLocaleString('id-ID')} · {r.environment.name} · {r.summary.passedFlows}/{r.summary.flows || r.flows.length} lulus{r.status === 'running' ? ' (berjalan)' : ''}</option>
            {/each}
          </select>
          <span class="badge {activeRun.status === 'running' ? 'st-run' : activeRun.summary.passedFlows === activeRun.summary.flows ? 'st-ok' : 'st-err'}">
            {activeRun.status === 'running' ? 'Berjalan' : activeRun.status === 'cancelled' ? 'Dibatalkan' : `${activeRun.summary.passedFlows}/${activeRun.summary.flows} flow lulus`}
          </span>
          <span class="muted small">{activeRun.summary.passedSteps}/{activeRun.summary.steps} step lulus</span>
          <span class="grow"></span>
          {#if activeRun.status === 'running'}
            <button class="btn btn-sm" onclick={() => activeRun && qa.cancelRun(activeRun.id)}>Batalkan</button>
          {:else}
            <button class="btn btn-sm" onclick={() => activeRun && copy(runReport(activeRun), 'Laporan')}><Icon name="copy" size={13} /> Salin laporan</button>
            {#if activeRun.flows.some((f) => f.status === 'failed' || f.status === 'error')}
              <button class="btn btn-sm" onclick={() => activeRun && repair(activeRun)} disabled={pipelineBusy || !canReadCode} title={canReadCode ? 'Agent perbaikan menganalisa tiap test yang gagal: test keliru diperbaiki, bug service ditandai' : 'Butuh Claude CLI atau Antigravity (membaca kode)'}>
                <Icon name="sparkles" size={13} /> Perbaiki otomatis
              </button>
            {/if}
          {/if}
          <button class="btn btn-sm btn-primary" onclick={() => openLog()} title="Riwayat semua request dan response run ini, layar penuh"><Icon name="list" size={13} /> Log request</button>
        </div>
        {#if suite?.suspects?.length}
          <section class="card suspects">
            <h3><Icon name="bug" size={14} /> Dugaan bug service · {suite.suspects.length}</h3>
            <p class="muted small">Dari agent perbaikan: test-nya sudah sesuai kode/TAD, tapi service merespon salah.</p>
            {#each suite.suspects as sp (sp.flowId + sp.runId)}
              <div class="suspect">
                <div class="grow">
                  <strong>{sp.title}</strong>{#if sp.service}<span class="chip">{sp.service}</span>{/if}
                  <p class="small">{sp.detail}</p>
                  <span class="muted small">Test case: {sp.flowName}</span>
                </div>
                {#if sp.bugCaseId}
                  <a class="btn btn-sm" href="#/bugs/{sp.bugCaseId}"><Icon name="eye" size={13} /> Buka bug</a>
                {:else}
                  <button class="btn btn-sm btn-primary" onclick={() => suspectToBug(sp)}><Icon name="bug" size={13} /> Jadikan bug</button>
                {/if}
                <button class="btn btn-ghost btn-sm" onclick={() => dismissSuspect(sp)} title="Abaikan"><Icon name="x" size={13} /></button>
              </div>
            {/each}
          </section>
        {/if}
        {#each activeRun.flows as flow (flow.flowId)}
          <article class="card flow">
            <div class="flow-head">
              <span class="badge {STATUS[flow.status].cls}"><Icon name={STATUS[flow.status].icon} size={11} /> {STATUS[flow.status].label}</span>
              <strong>{flow.name}</strong>
              <span class="chip">{QA_CATEGORY_LABELS[flow.category]}</span>
              {#if ['failed', 'error', 'blocked'].includes(flow.status) && activeRun.status !== 'running' && suite?.flows.some((f) => f.id === flow.flowId)}
                <span class="grow"></span>
                <button class="btn btn-sm" onclick={() => activeRun && openCodeFix(flow.flowId, activeRun.id)} disabled={CODER_ACTIVE.includes(fixByFlow.get(flow.flowId)?.status ?? 'cancelled')} title="Coder agent memperbaiki kode service dari kegagalan ini, di background, tanpa tiket"><Icon name="code" size={13} /> Perbaiki kode</button>
              {/if}
            </div>
            <ol class="steps">
              {#each flow.steps as s, si (si)}
                <li class="result">
                  <button class="step-line clickable" onclick={() => (openSteps = toggle(openSteps, stepKey(flow.flowId, si)))} aria-expanded={openSteps.has(stepKey(flow.flowId, si))}>
                    <span class="badge {STATUS[s.status].cls}"><Icon name={STATUS[s.status].icon} size={11} /></span>
                    {#if s.request}<span class="method m-{s.request.method.toLowerCase()}">{s.request.method}</span>{/if}
                    <span class="step-name">{s.name}</span>
                    {#if s.response}<span class="mono small">HTTP {s.response.status}</span>{/if}
                    {#if s.durationMs !== undefined}<span class="muted small">{s.durationMs} ms</span>{/if}
                  </button>
                  {#each s.dbSetup ?? [] as d, di (di)}
                    <p class="setup-line small" class:err={!d.ok}><Icon name={d.ok ? 'check' : 'x'} size={11} /> Ubah data DB <strong>{d.db}</strong>: {d.ok ? d.value : d.error} · <code class="sql">{d.sql}</code></p>
                  {/each}
                  {#if s.error}<p class="err small">{s.error}</p>{/if}
                  {#each s.assertions.filter((a) => !a.passed) as a, i (i)}
                    <p class="err small">✗ {a.message}</p>
                  {/each}
                  {#if openSteps.has(stepKey(flow.flowId, si))}
                    <div class="detail">
                      {#if s.assertions.length}
                        <ul class="assert-results small">
                          {#each s.assertions as a, i (i)}<li class:ok={a.passed} class:bad={!a.passed}>{a.passed ? '✓' : '✗'} {a.message}</li>{/each}
                        </ul>
                      {/if}
                      {#if s.extracted && Object.keys(s.extracted).length}
                        <p class="small">Diambil: {#each Object.entries(s.extracted) as [k, v] (k)}<code>{k}={v}</code> {/each}</p>
                      {/if}
                      {#if s.request}
                        <h4>Request</h4>
                        <pre class="mono">{s.request.method} {s.request.url}{'\n'}{Object.entries(s.request.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}{s.request.body ? `\n\n${pretty(s.request.body)}` : ''}</pre>
                      {/if}
                      {#if s.response}
                        <h4>Response {s.response.status}{s.response.truncated ? ' (dipotong)' : ''}</h4>
                        <pre class="mono">{pretty(s.response.body)}</pre>
                      {/if}
                      {#if s.curl}
                        <button class="btn btn-sm" onclick={() => copy(s.curl ?? '', 'Perintah curl')}><Icon name="copy" size={13} /> Salin curl</button>
                      {/if}
                    </div>
                  {/if}
                </li>
              {/each}
              {#if flow.status === 'pending' || flow.status === 'running'}
                <li class="muted small">{flow.status === 'running' ? 'Menjalankan…' : 'Menunggu giliran…'}</li>
              {/if}
            </ol>
          </article>
        {/each}
      {/if}
    {/if}
  </div>
</div>

{#snippet groupForm()}
  <form class="group-form card" onsubmit={(e) => { e.preventDefault(); void createGroup(); }}>
    <label class="field grow">
      <span>Nama grup baru</span>
      <input class="input" bind:value={newGroupName} maxlength="120" placeholder="mis. 5. Refund & pembatalan" {@attach focusNow} />
    </label>
    <button class="btn btn-primary btn-sm" type="submit" disabled={!newGroupName.trim()}>Buat grup</button>
    <button class="btn btn-ghost btn-sm" type="button" onclick={() => (newGroupOpen = false)}>Batal</button>
  </form>
{/snippet}

<Modal bind:open={tadOpen} title="Update TAD dari temuan E2E" subtitle="Temuan pengujian yang kelewat atau ambigu di TAD; AI mengusulkan perubahan, kamu review di TAD." width={860}>
  <div class="fix-form">
    <label class="field">
      <span>TAD yang diperbarui</span>
      <select class="input" bind:value={tadDraftId}>
        {#each projectTads as d (d.id)}<option value={d.id}>{draftTitle(d)}{d.pendingJobId ? ' (AI sedang bekerja)' : ''}</option>{/each}
      </select>
    </label>
    {#if !findings.length}
      <p class="muted small">Belum ada temuan otomatis (catatan AI, test yang diperbaiki, endpoint di luar rencana, atau test gagal). Kamu tetap bisa menulis temuanmu sendiri di catatan.</p>
    {:else}
      <div class="findings">
        {#each FINDING_ORDER as kind (kind)}
          {@const items = findings.filter((f) => f.kind === kind)}
          {#if items.length}
            <div class="finding-group">
              <div class="finding-head small">
                <strong>{FINDING_LABELS[kind]}</strong> <span class="muted">({items.length})</span>
                <span class="grow"></span>
                <button class="link-btn small" onclick={() => (tadPicked = new Set([...tadPicked, ...items.map((f) => f.id)]))}>pilih semua</button>
                <button class="link-btn small" onclick={() => (tadPicked = new Set([...tadPicked].filter((id) => !items.some((f) => f.id === id))))}>kosongkan</button>
              </div>
              {#each items as f (f.id)}
                <label class="finding" class:other={otherTad(f.taskTitles)}>
                  <input type="checkbox" checked={tadPicked.has(f.id)} onchange={() => (tadPicked = toggle(tadPicked, f.id))} />
                  <span class="grow">
                    <span class="small"><strong>{f.title}</strong>{#if otherTad(f.taskTitles)} <span class="chip">TAD lain</span>{/if}</span>
                    <span class="muted small finding-detail">{f.detail}</span>
                  </span>
                </label>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
    <label class="field">
      <span>Catatan / temuan tambahan <em class="muted">(opsional)</em></span>
      <textarea class="input" rows="3" bind:value={tadNote} placeholder="mis. TAD belum menyebut batas maksimal 5 dokumen pendukung per promo"></textarea>
    </label>
    <AiPicker value={tadAi} onchange={(s) => (tadAi = s)} />
    <p class="muted small">AI membaca TAD dan memperbarui hanya bagian yang kelewat atau ambigu menurut temuan. Bila temuan menunjukkan kode yang salah (TAD sudah jelas), TAD tidak diubah. Hasilnya selalu jadi <strong>usulan</strong> yang kamu review (diff) di halaman TAD sebelum masuk; tidak ada yang dipublish ke Confluence.</p>
  </div>
  {#snippet footer()}
    <button class="btn btn-ghost" onclick={() => (tadOpen = false)}>Batal</button>
    <button class="btn btn-primary" onclick={startTadUpdate} disabled={tadStarting || !tadDraftId || (!tadPicked.size && !tadNote.trim())}><Icon name="play" size={13} /> {tadStarting ? 'Memulai…' : `Jalankan di background (${tadPicked.size} temuan)`}</button>
  {/snippet}
</Modal>

<Modal bind:open={bulkOpen} title="Perbaiki kode beberapa test yang gagal" subtitle="Satu run per repo (maks. 6 test case per run). Repo berbeda berjalan paralel di background, tanpa tiket." width={920}>
  <div class="fix-form">
    <div class="finding-head small">
      <strong>{bulkPicked.size} dari {fixable.length} test gagal dipilih</strong>
      <span class="grow"></span>
      <button class="link-btn small" onclick={() => (bulkPicked = new Set(fixable.map((f) => f.id)))}>pilih semua</button>
      <button class="link-btn small" onclick={() => (bulkPicked = new Set())}>kosongkan</button>
    </div>
    <div class="findings">
      {#each fixable as f (f.id)}
        {@const fr = failureOf(f.id)}
        {@const st = fr ? failedStep(fr.result) : undefined}
        <div class="finding">
          <input type="checkbox" checked={bulkPicked.has(f.id)} onchange={() => (bulkPicked = toggle(bulkPicked, f.id))} aria-label="Perbaiki {f.name}" />
          <span class="grow">
            <span class="small"><strong>{f.name}</strong>{#if f.stage} <span class="muted">· {f.stage}</span>{/if}</span>
            {#if st}<span class="muted small finding-detail">{st.name}{st.response ? ` · HTTP ${st.response.status}` : ''}{fr && fr.result.steps.filter((x) => x.status === 'skipped').length ? ` · ${fr.result.steps.filter((x) => x.status === 'skipped').length} step belum diuji ikut diperiksa` : ''}</span>{/if}
          </span>
          <select class="input bulk-repo" value={bulkRepoOf[f.id] ?? ''} onchange={(e) => (bulkRepoOf = { ...bulkRepoOf, [f.id]: e.currentTarget.value })} aria-label="Repo untuk {f.name}">
            <option value="">Pilih repo…</option>
            {#each bulkRepos as r (r)}<option value={r}>{r}</option>{/each}
          </select>
        </div>
      {/each}
    </div>
    {#if bulkGroups.length}
      <div class="bulk-groups">
        {#each bulkGroups as g (g.repo)}
          <div class="bulk-group">
            <div class="small"><strong>{g.repo || 'Belum ada repo'}</strong> <span class="muted">· {g.flows.length} test case → {g.chunks.length} run</span></div>
            {#if g.repo && bulkCfg[g.repo]}
              <div class="fix-grid two">
                <label class="field">
                  <span>Base branch <em class="muted">{bulkCfg[g.repo].from === 'remote' ? '(dari GitLab)' : bulkCfg[g.repo].from === 'local' ? '(salinan lokal)' : bulkCfg[g.repo].from === 'loading' ? '(memuat…)' : ''}</em></span>
                  {#if bulkCfg[g.repo].branches.length}
                    <select class="input mono" bind:value={bulkCfg[g.repo].base}>
                      {#each bulkCfg[g.repo].branches as b (b)}<option value={b}>{b}</option>{/each}
                    </select>
                  {:else}
                    <input class="input mono" bind:value={bulkCfg[g.repo].base} placeholder="staging" />
                  {/if}
                </label>
                <label class="field">
                  <span>Nama branch{g.chunks.length > 1 ? ` (run berikutnya: -2, -3, …)` : ''}</span>
                  <input class="input mono" value={repoBranch(g)} oninput={(e) => (bulkCfg[g.repo].branch = e.currentTarget.value)} maxlength="115" spellcheck="false" />
                </label>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    <div class="fix-grid two">
      <label class="field">
        <span>Profil</span>
        <select class="input" bind:value={bulkProfile}>
          <option value="backend">Backend</option>
          <option value="frontend">Frontend</option>
        </select>
      </label>
      <label class="field">
        <span>Catatan untuk agent <em class="muted">(opsional, untuk semua run)</em></span>
        <input class="input" bind:value={bulkNote} placeholder="mis. ikuti format error response standar" />
      </label>
    </div>
    {#if bulkErrors.length}<p class="err small">{bulkErrors.join(' ')}</p>{/if}
    <p class="muted small">Tiap run memeriksa step yang gagal dan step sesudahnya yang belum diuji, lalu memperbaiki semuanya sekaligus (dengan test reproduksi). Test yang ternyata keliru tidak diubah kodenya; agent bertanya. {bulkGroups.reduce((n, g) => n + g.chunks.length, 0)} run masuk antrean; {coderConcurrency} berjalan bersamaan (repo berbeda; satu repo satu run sekaligus), sisanya menyusul otomatis. Batas ini diatur di pengaturan coder agent.</p>
  </div>
  {#snippet footer()}
    <button class="btn btn-ghost" onclick={() => (bulkOpen = false)}>Batal</button>
    <button class="btn btn-primary" onclick={startBulkFix} disabled={bulkStarting || !bulkGroups.length || bulkErrors.length > 0}><Icon name="play" size={13} /> {bulkStarting ? 'Memulai…' : `Jalankan ${bulkGroups.reduce((n, g) => n + g.chunks.length, 0)} run di background`}</button>
  {/snippet}
</Modal>

<Modal bind:open={fixOpenModal} title="Perbaiki kode dari test yang gagal" subtitle={fixTarget?.flow.name} width={760}>
  {#if fixTarget}
    {@const st = failedStep(fixTarget.result)}
    <div class="fix-form">
      <p class="small fix-summary">
        <span class="badge st-err">{STATUS[fixTarget.result.status].label}</span>
        {#if st}Step <strong>{st.name}</strong>{st.response ? ` · HTTP ${st.response.status}` : ''}{st.assertions.find((a) => !a.passed) ? ` · ${st.assertions.find((a) => !a.passed)!.message}` : st.error ? ` · ${st.error}` : ''}{/if}
        <span class="muted"> · run {new Date(fixTarget.run.startedAt).toLocaleString('id-ID')} · {fixTarget.run.environment.name}</span>
      </p>
      <div class="fix-grid">
        <label class="field">
          <span>Repo yang diperbaiki</span>
          <select class="input" bind:value={fixRepo}>
            {#if !fixRepos.length}<option value="">Memuat repo…</option>{/if}
            {#each fixRepos as r (r)}<option value={r}>{r}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>Profil</span>
          <select class="input" bind:value={fixProfile}>
            <option value="backend">Backend</option>
            <option value="frontend">Frontend</option>
          </select>
        </label>
        <label class="field">
          <span>Base branch <em class="muted">{fixBranchesFrom === 'remote' ? '(dari GitLab)' : fixBranchesFrom === 'local' ? '(salinan lokal; GitLab tidak terjangkau)' : ''}</em></span>
          {#if fixBranches.length}
            <select class="input mono" bind:value={fixBase}>
              {#each fixBranches as b (b)}<option value={b}>{b}</option>{/each}
            </select>
          {:else}
            <input class="input mono" bind:value={fixBase} placeholder={fixBranchesFrom === 'loading' ? 'Memuat branch…' : 'staging'} />
          {/if}
        </label>
      </div>
      <label class="field">
        <span>Nama branch <em class="muted">(bisa diubah; dibuat dari base branch di atas)</em></span>
        <input class="input mono" bind:value={fixBranch} maxlength="120" spellcheck="false" placeholder="fix/nama-perbaikan" />
        {#if fixBranchError}
          <span class="err small">{fixBranchError}</span>
        {:else if fixBranchExists}
          <span class="warn-text small">Branch ini sudah ada di repo. Pakai nama lain, atau pastikan memang ingin melanjutkan branch itu (push bisa ditolak bila riwayatnya berbeda).</span>
        {/if}
      </label>
      <label class="field">
        <span>Catatan untuk agent <em class="muted">(opsional)</em></span>
        <textarea class="input" rows="3" bind:value={fixNote} placeholder="mis. validasi tanggal seharusnya pakai zona Asia/Jakarta"></textarea>
      </label>
      <details class="small">
        <summary>Spesifikasi yang dikirim ke agent</summary>
        <pre class="mono spec-preview">{fixSpec}</pre>
      </details>
      <p class="muted small">
        Coder agent bekerja di background di clone terisolasi repo ini (branch <code>fix/…</code>): memastikan dulu kegagalannya di kode, menulis test reproduksi, lalu memperbaiki. Tidak ada tiket Jira atau kasus bug yang dibuat. Bila ternyata test-nya yang keliru, agent berhenti dengan pertanyaan. Pakai <strong>Perbaiki dengan AI</strong> untuk memperbaiki test case. Hasilnya direview di panel Perbaikan kode (diff, lalu Push & MR Draft), juga terlihat di Agent Tasks.
      </p>
    </div>
  {/if}
  {#snippet footer()}
    <button class="btn btn-ghost" onclick={() => (fixOpenModal = false)}>Batal</button>
    <button class="btn btn-primary" onclick={startCodeFix} disabled={!fixRepo || !fixSpec || fixStarting || Boolean(fixBranchError) || fixBranchesFrom === 'loading' || (fixBranches.length > 0 && !fixBranches.includes(fixBase))}><Icon name="play" size={13} /> {fixStarting ? 'Memulai…' : 'Jalankan di background'}</button>
  {/snippet}
</Modal>

<E2ELogViewer bind:open={logOpen} bind:runId={logRunId} {runs} />
<E2EEnvironmentModal bind:open={envModalOpen} bind:environments bind:selectedId={envId} {services} />

<style>
  .codebase-opt {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--accent-soft);
  }
  .codebase-opt.off {
    opacity: 0.7;
  }
  .codebase-opt em {
    display: block;
    color: var(--warn);
    font-style: normal;
  }
  .db-note {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--ok-soft);
    color: var(--ok);
  }
  .flow-warn {
    margin: 0 0 6px;
    padding: 6px 10px 6px 24px;
    border-radius: 8px;
    background: var(--warn-soft);
    color: var(--warn);
  }
  .undo-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 6px 10px;
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .fix {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .fix h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 14px;
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .preset {
    cursor: pointer;
    border: 1px solid var(--border);
    font: inherit;
    font-size: 12px;
  }
  .fix-row {
    display: flex;
    gap: 12px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .fix-row .field {
    min-width: 220px;
  }
  .fix-actions {
    display: flex;
    gap: 8px;
  }
  .repair-note {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0 0 6px;
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--accent-soft);
  }
  .suspects {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border-left: 3px solid var(--err);
  }
  .suspects h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 13.5px;
  }
  .suspects > p {
    margin: 0;
  }
  .suspect {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--surface-2);
  }
  .suspect p {
    margin: 4px 0;
  }
  /* A group: checkbox for all its flows, name, checked count, and its own buttons. */
  .group-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 14px 0 2px;
    padding: 0 0 4px 15px;
    border-bottom: 1px solid var(--border);
  }
  .stage-head {
    margin: 0;
    flex: 0 1 auto;
    min-width: 0;
    font-size: 12.5px;
    color: var(--accent);
    letter-spacing: 0.02em;
  }
  .stage-head.loose {
    color: var(--text-2, var(--text));
  }
  .group-head .count {
    white-space: nowrap;
  }
  .group-empty {
    margin: 2px 0 4px 15px;
  }
  .rename {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 260px;
    min-width: 0;
  }
  .rename .input {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
    font-size: 12.5px;
  }
  .empty-actions {
    display: flex;
    gap: 8px;
  }
  .ready-ok {
    background: var(--ok-soft);
  }
  .ready-todo {
    background: var(--warn-soft, var(--accent-soft));
  }
  /* "Update TAD dari temuan": the findings checklist and the banners. */
  .findings {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 46vh;
    overflow-y: auto;
    padding-right: 4px;
  }
  .finding-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .finding-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .finding {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .finding.other {
    opacity: 0.7;
  }
  .finding .grow {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .finding-detail {
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 4.5em;
    overflow: hidden;
  }
  .tad-ready {
    background: var(--ok-soft);
  }
  /* "Perbaiki kode": the runs panel, the badge on a card, and the dialog. */
  .code-fixes {
    display: flex;
    flex-direction: column;
    gap: 6px;
    scroll-margin-top: 80px;
  }
  .code-fixes h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
  .fix-badge {
    cursor: pointer;
    border: none;
    font: inherit;
    font-size: 11px;
  }
  .fix-code-btn {
    color: var(--err);
  }
  .fix-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .fix-summary {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .fix-grid {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 10px;
  }
  .fix-all-btn {
    color: var(--err);
  }
  .bulk-repo {
    width: 190px;
    padding: 3px 6px;
    font-size: 11.5px;
  }
  .bulk-groups {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bulk-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .fix-grid.two {
    grid-template-columns: 1fr 1fr;
  }
  .warn-text {
    color: var(--warn, #b45309);
  }
  .spec-preview {
    max-height: 320px;
    overflow: auto;
    white-space: pre-wrap;
    font-size: 11.5px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
  }
  /* Latest outcome: filter chips, per-group counts, and the badge on each card (opens that run). */
  .result-filter {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .filter-chip {
    cursor: pointer;
    border: 1px solid var(--border);
    font: inherit;
    font-size: 12px;
  }
  .filter-chip.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
  }
  .filter-chip.rf-passed strong {
    color: var(--ok);
  }
  .filter-chip.rf-failed strong {
    color: var(--err);
  }
  .group-results {
    display: inline-flex;
    gap: 8px;
    white-space: nowrap;
  }
  .res-ok {
    color: var(--ok);
  }
  .res-err {
    color: var(--err);
  }
  .result-badge {
    cursor: pointer;
    border: none;
    font: inherit;
    font-size: 11px;
  }
  .result-badge:hover {
    text-decoration: underline;
  }
  .group-form {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  .group-pick {
    width: 150px;
    padding: 3px 6px;
    font-size: 11.5px;
    margin-right: 4px;
  }
  .order-btn {
    padding-left: 6px;
    padding-right: 6px;
  }
  /* A step's data change in the database (setup), before its request. */
  .setup-line {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    margin: 2px 0;
    color: var(--warn, #b45309);
  }
  .setup-line .sql {
    color: var(--text);
    word-break: break-all;
  }
  .data-queries {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 4px 0 8px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--accent-soft);
  }
  .dq {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
  }
  .dq .sql {
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .dbq {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .flow-search {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 220px;
    max-width: 380px;
    height: 30px;
    padding: 0 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-3);
  }
  .flow-search:focus-within {
    border-color: var(--accent);
  }
  .flow-search input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
  }
  .cat-select {
    width: auto;
    font-size: 12.5px;
  }
  .link-btn {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  /* The page around it scrolls (ProjectsView .page-scroll); nothing in here is a small scroll box. */
  .e2e {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 22px 24px;
    box-sizing: border-box;
  }
  /* Environment, Generate and Run stay in reach while scrolling through long lists. */
  .head {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 12px 0 10px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .head h2 {
    margin: 0 0 2px;
    font-size: 17px;
  }
  .head p {
    margin: 0;
  }
  .head-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .env-select {
    width: auto;
    min-width: 180px;
    max-width: 260px;
  }
  .small {
    font-size: 12px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 12px 14px;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: var(--radius);
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
  .gen {
    flex-shrink: 0;
  }
  .gen h3 {
    margin: 0 0 8px;
    font-size: 13px;
  }
  .gen-grid {
    display: grid;
    /* Side by side when there is room; stacked in a narrow window instead of a one-word-wide task list. */
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 18px;
  }
  .gen-side {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .task-list,
  .cats {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .check.disabled {
    opacity: 0.55;
  }
  .task-title {
    font-size: 11.5px;
    word-break: break-word;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .store-chip {
    margin-left: auto;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 6px 12px;
    font: inherit;
    font-size: 13px;
    color: var(--text-2, var(--text));
    cursor: pointer;
  }
  .tabs button.active {
    border-bottom-color: var(--accent);
    color: var(--text);
    font-weight: 600;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 40px 0;
    text-align: center;
  }
  .list-tools,
  .run-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .run-head select {
    max-width: 420px;
  }
  .grow {
    flex: 1;
  }
  .flow.disabled {
    opacity: 0.6;
  }
  .flow-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* Title and badges wrap among themselves; the row's buttons stay on the right in one group. */
  .flow-meta {
    /* The title keeps at least ~260px; only on a narrow screen do the buttons move below it, together. */
    flex: 1 1 260px;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .flow-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    margin-left: auto;
  }
  .flow-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }
  .desc {
    margin: 8px 0 4px;
    font-size: 12.5px;
  }
  .vars code,
  .asserts code {
    margin-right: 4px;
  }
  .steps {
    margin: 8px 0 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .step-line {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .step-line.clickable {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }
  .step-name {
    font-size: 13px;
  }
  .path {
    font-size: 12px;
    word-break: break-all;
  }
  .method {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .m-get {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .m-delete {
    background: var(--err-soft);
    color: var(--err);
  }
  .m-put,
  .m-patch {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .asserts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 3px;
  }
  .asserts code,
  .vars code {
    font-size: 11px;
  }
  .extract {
    color: var(--accent);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text);
  }
  .st-ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .st-err {
    background: var(--err-soft);
    color: var(--err);
  }
  .st-warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .st-run {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .err {
    color: var(--err);
    margin: 3px 0 0;
  }



  .detail {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .detail h4 {
    margin: 4px 0 0;
    font-size: 12px;
  }
  .detail pre {
    margin: 0;
    padding: 8px 10px;
    max-height: 280px;
    overflow: auto;
    font-size: 11.5px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .assert-results {
    margin: 0;
    padding-left: 4px;
    list-style: none;
  }
  .assert-results .ok {
    color: var(--ok);
  }
  .assert-results .bad {
    color: var(--err);
  }
  .notes summary {
    cursor: pointer;
    font-size: 12.5px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .notes p {
    white-space: pre-wrap;
    font-size: 12.5px;
    margin: 8px 0 0;
  }
  @media (max-width: 900px) {
    .gen-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
