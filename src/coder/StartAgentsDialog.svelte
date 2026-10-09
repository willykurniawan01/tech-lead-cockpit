<script lang="ts">
  import { appSettings } from '../lib/settings/store.svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { toasts } from '../components/toast.svelte';
  import { coder, profileForTask, suggestRepo } from '../lib/coder/client';
  import type { CoderProfileId, StartCoderRunRequest } from '../lib/coder/types';
  import type { JiraIssue } from '../lib/jira/types';
  import { detailTaskSpec, type ScopeTask } from '../lib/tad/task-links';
  import { draftTitle, type Draft } from '../tad/drafts.svelte';

  let {
    open = $bindable(false),
    draft,
    tasks,
    issues,
    onstarted,
  }: {
    open: boolean;
    draft: Draft;
    tasks: ScopeTask[];
    issues: Record<string, JiraIssue>;
    onstarted?: () => void;
  } = $props();

  type Row = { task: ScopeTask; profile: CoderProfileId; repo: string; base: string; target: string; spec: string; ack: boolean };
  let rows = $state<Row[]>([]);
  let repos = $state<string[]>([]);
  let concurrency = $state(2);
  let starting = $state(false);
  let defaultBase = $state(appSettings.value.workspace.defaultBaseBranch);
  let defaultTarget = $state(appSettings.value.workspace.defaultBaseBranch);

  $effect(() => {
    if (!open) return;
    void prepare();
  });

  async function prepare() {
    const [list, state] = await Promise.all([coder.repos().catch(() => [] as string[]), coder.state().catch(() => undefined)]);
    repos = list;
    if (state) concurrency = state.settings.concurrency;
    rows = tasks.map((task) => {
      const spec = detailTaskSpec(draft.markdown, task.title);
      return {
        task,
        profile: profileForTask(task.title),
        repo: suggestRepo(list, spec?.fields.Service, task.service),
        base: defaultBase,
        target: defaultTarget,
        spec: spec?.text ?? '',
        ack: false,
      };
    });
  }

  function applyBaseToAll(val: string) {
    defaultBase = val;
    for (const r of rows) r.base = val;
  }

  function applyTargetToAll(val: string) {
    defaultTarget = val;
    for (const r of rows) r.target = val;
  }

  /** Why a task might not be the agent's to take; the user must acknowledge it explicitly. */
  function warning(r: Row): string | undefined {
    if (!r.spec.trim()) return 'Detail Task tidak ditemukan; agent tidak punya spesifikasi.';
    const key = r.task.jiraKeys[0];
    const issue = key ? issues[key] : undefined;
    if (!key) return 'Task belum punya Jira key; status Jira tidak akan digeser.';
    if (issue && issue.statusCategory !== 'new') return `${key} berstatus ${issue.status}${issue.assignee ? ` (${issue.assignee.displayName})` : ''}; mungkin sedang dikerjakan orang.`;
    if (issue?.assignee) return `${key} sudah di-assign ke ${issue.assignee.displayName}.`;
    return undefined;
  }

  const blocked = $derived(rows.some((r) => !r.repo || !r.spec.trim() || !r.base.trim() || !r.target.trim() || (warning(r) && !r.ack)));

  async function start() {
    starting = true;
    try {
      await coder.settings({ concurrency });
      const requests: StartCoderRunRequest[] = rows.map((r) => ({
        draftId: draft.id,
        tadTitle: draftTitle(draft),
        taskTitle: r.task.title,
        jiraKey: r.task.jiraKeys[0],
        profile: r.profile,
        repo: r.repo,
        baseBranch: r.base.trim() || appSettings.value.workspace.defaultBaseBranch,
        targetBranch: r.target.trim() || r.base.trim() || appSettings.value.workspace.defaultBaseBranch,
        spec: r.spec,
      }));
      await coder.start(requests);
      toasts.show(`${requests.length} task masuk antrean agent.`, 'ok');
      open = false;
      onstarted?.();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      starting = false;
    }
  }
</script>

<datalist id="base-branch-list">
  <option value="staging">staging</option>
  <option value="development">development</option>
</datalist>
<datalist id="target-branch-list">
  <option value="staging">staging</option>
  <option value="development">development</option>
  <option value="main">main</option>
</datalist>

<Modal bind:open title="Kerjakan dengan agent" subtitle="Setiap task dikerjakan di clone dan branch sendiri. Tidak ada yang di-push sebelum kamu review." width={980}>
  <div class="branch-defaults">
    <span class="defaults-label"><Icon name="merge" size={13} /> Cabang Git Default:</span>
    <label class="default-field">
      <span>Buat dari:</span>
      <select class="input input-sm mono" value={defaultBase} onchange={(e) => applyBaseToAll(e.currentTarget.value)}>
        <option value="staging">staging</option>
        <option value="development">development</option>
      </select>
    </label>
    <label class="default-field">
      <span>MR ke:</span>
      <select class="input input-sm mono" value={defaultTarget} onchange={(e) => applyTargetToAll(e.currentTarget.value)}>
        <option value="staging">staging</option>
        <option value="development">development</option>
        <option value="main">main</option>
      </select>
    </label>
    <span class="muted small">(set semua task sekaligus)</span>
  </div>

  <div class="rows">
    {#each rows as r (r.task.title)}
      {@const warn = warning(r)}
      <section class="row">
        <div class="title">
          <strong>{r.task.title}</strong>
          <span class="muted small">{r.task.jiraKeys.join(', ') || 'tanpa Jira key'} · service {r.task.service || '—'}</span>
        </div>
        <div class="fields">
          <label class="field"><span>Profil</span>
            <select class="input" bind:value={r.profile}>
              <option value="backend">Backend</option>
              <option value="frontend">Frontend</option>
            </select>
          </label>
          <label class="field"><span>Repo</span>
            <select class="input" bind:value={r.repo}>
              <option value="">Pilih repo…</option>
              {#each repos as repo (repo)}<option value={repo}>{repo}</option>{/each}
            </select>
          </label>
          <label class="field"><span>Buat dari (Base)</span>
            <input class="input mono" list="base-branch-list" bind:value={r.base} placeholder="staging" />
          </label>
          <label class="field"><span>MR ke (Target)</span>
            <input class="input mono" list="target-branch-list" bind:value={r.target} placeholder="staging" />
          </label>
        </div>
        {#if warn}
          <label class="warn">
            <input type="checkbox" bind:checked={r.ack} disabled={!r.spec.trim()} />
            <Icon name="alert" size={13} /> {warn} {#if r.spec.trim()}Tetap kerjakan.{/if}
          </label>
        {/if}
      </section>
    {/each}
  </div>

  <div class="policy">
    <p><strong>Yang terjadi otomatis:</strong> clone repo → branch <code>feature/&lt;JIRA&gt;-…</code> dari Base branch → agent menulis code dan test → Cockpit menjalankan test dan commit. Jira digeser To Do → In Progress saat agent mulai.</p>
    <p><strong>Yang menunggu kamu:</strong> lihat diff dan Kesesuaian TAD → <em>Push & buat MR Draft</em> (menargetkan Target MR) → review di MR Review. Approve/merge selalu manual.</p>
  </div>

  {#snippet footer()}
    <label class="conc">Paralel
      <select class="input" bind:value={concurrency}>
        {#each [1, 2, 3, 4] as n (n)}<option value={n}>{n}</option>{/each}
      </select>
      <span class="muted small">task di repo yang sama selalu berurutan</span>
    </label>
    <span class="spacer"></span>
    <button class="btn" onclick={() => (open = false)}>Batal</button>
    <button class="btn btn-primary" onclick={start} disabled={starting || blocked || !rows.length}>
      <Icon name="sparkles" size={14} /> {starting ? 'Memulai…' : `Mulai ${rows.length} agent`}
    </button>
  {/snippet}
</Modal>

<style>
  .branch-defaults {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    margin-bottom: 12px;
    border-radius: 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-size: 13px;
  }
  .defaults-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .default-field {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .default-field select {
    padding: 4px 8px;
    height: 30px;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 54vh;
    overflow: auto;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .title {
    display: flex;
    flex-direction: column;
  }
  .small {
    font-size: 12.5px;
  }
  .fields {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr) 140px 140px;
    gap: 10px;
  }
  .warn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 12.5px;
  }
  .policy {
    margin-top: 12px;
    padding: 10px 14px;
    border-radius: 12px;
    background: var(--surface-2);
    font-size: 12.5px;
    color: var(--text-2);
  }
  .policy p {
    margin: 4px 0;
  }
  .conc {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .conc select {
    width: 64px;
  }
  .spacer {
    flex: 1;
  }
</style>
