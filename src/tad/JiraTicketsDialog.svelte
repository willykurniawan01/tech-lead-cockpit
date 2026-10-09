<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { toasts } from '../components/toast.svelte';
  import { syncTadToConfluence } from '../lib/confluence/sync';
  import { jira } from '../lib/jira/client';
  import type { JiraIssue, JiraProject, TadTicketResult } from '../lib/jira/types';
  import { appSettings } from '../lib/settings/store.svelte';
  import { droppedTicketKeys, tasksWithoutTicket, ticketDescription } from '../lib/tad/tad-tickets';
  import { parseScopeTasks, setScopeJiraKeys, type ScopeTask } from '../lib/tad/task-links';
  import { draftTitle, drafts, type Draft } from './drafts.svelte';

  /**
   * Jira tickets for Development Scope tasks that have none (tasks added when the scope changed).
   * Defaults copy the TAD's existing tickets; the new keys are written back into the scope table as
   * one revision, and publishing to Confluence is offered afterwards.
   */
  let { open = $bindable(false), draft }: { open: boolean; draft: Draft } = $props();

  let tasks = $state<ScopeTask[]>([]);
  let selected = $state<Record<string, boolean>>({});
  let expanded = $state<string | null>(null);
  let projects = $state<JiraProject[]>([]);
  let types = $state<{ id: string; name: string }[]>([]);
  let project = $state('');
  let issueType = $state('');
  let parentKey = $state('');
  let parentSummary = $state('');
  let labels = $state('');
  let components = $state('');
  let basedOn = $state<string[]>([]);
  let dropped = $state<JiraIssue[]>([]);
  let loading = $state(false);
  let error = $state('');
  let creating = $state(false);
  let results = $state<TadTicketResult[] | null>(null);
  let notWritten = $state<string[]>([]);
  let publishing = $state(false);
  let published = $state(false);
  let wasOpen = false;

  const tad = $derived({ title: draftTitle(draft), url: draft.confluence.url });
  const chosen = $derived(tasks.filter((t) => selected[t.title]));
  const linked = $derived(Boolean(draft.confluence.pageId));

  $effect(() => {
    if (open && !wasOpen) untrack(() => void load());
    wasOpen = open;
  });

  // Issue types depend on the project.
  $effect(() => {
    const p = project;
    if (!p) return;
    untrack(() => {
      jira
        .issueTypes(p)
        .then((t) => {
          if (project !== p) return;
          types = t;
          if (!t.some((x) => x.name === issueType)) issueType = t.find((x) => x.name === 'Task')?.name ?? t[0]?.name ?? '';
        })
        .catch(() => (types = []));
    });
  });

  async function load() {
    tasks = tasksWithoutTicket(draft.markdown);
    selected = Object.fromEntries(tasks.map((t) => [t.title, true]));
    results = null;
    notWritten = [];
    published = false;
    error = '';
    dropped = [];
    loading = true;
    const existing = [...new Set(parseScopeTasks(draft.markdown).flatMap((t) => t.jiraKeys))];
    try {
      const status = await jira.status();
      if (!status.configured) throw new Error(status.error ?? 'Jira belum terhubung. Atur di menu Koneksi.');
      const [list, tpl] = await Promise.all([jira.projects(), existing.length ? jira.tadTemplate(existing) : Promise.resolve(null)]);
      projects = list;
      project = tpl?.projectKey ?? appSettings.value.jira.defaultProject ?? '';
      if (!list.some((p) => p.key === project)) project = list[0]?.key ?? project;
      if (tpl?.issueType) issueType = tpl.issueType;
      parentKey = tpl?.parent?.key ?? '';
      parentSummary = tpl?.parent?.summary ?? '';
      labels = (tpl?.labels ?? []).join(', ');
      components = (tpl?.components ?? []).join(', ');
      basedOn = tpl?.basedOn ?? [];
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
    const gone = droppedTicketKeys(draft.markdown, draft.revisions);
    if (gone.length) {
      jira
        .issues(`key in (${gone.join(',')})`, gone.length)
        .then((list) => (dropped = list.filter((i) => i.statusCategory !== 'done')))
        .catch(() => {});
    }
  }

  const split = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  async function create() {
    if (!chosen.length || !project || !issueType) return;
    creating = true;
    error = '';
    try {
      const md = draft.markdown;
      const out = await jira.createTadTickets({
        projectKey: project,
        issueType,
        parentKey: parentKey.trim() || undefined,
        labels: split(labels),
        components: split(components),
        items: chosen.map((t) => ({ title: t.title, description: ticketDescription(md, t, tad) })),
      });
      results = out;
      const keys = Object.fromEntries(out.flatMap((r) => (r.key ? [[r.title, r.key]] : [])));
      if (Object.keys(keys).length) {
        const next = setScopeJiraKeys(draft.markdown, keys);
        notWritten = Object.keys(keys).filter((t) => !next.written.includes(t));
        if (next.written.length) {
          drafts.applyRevision(draft.id, next.markdown, `Tambah tiket Jira: ${next.written.map((t) => keys[t]).join(', ')}`);
          drafts.saveNow();
        }
      }
      const made = out.filter((r) => r.key && !r.existed).length;
      const reused = out.filter((r) => r.existed).length;
      const failed = out.filter((r) => r.error).length;
      toasts.show(
        `${made} tiket dibuat${reused ? `, ${reused} ditautkan ke tiket yang sudah ada` : ''}${failed ? `, ${failed} gagal` : ''}.`,
        failed ? 'err' : 'ok',
        6000,
      );
    } catch (e) {
      error = (e as Error).message;
    } finally {
      creating = false;
    }
  }

  async function publish() {
    publishing = true;
    try {
      const res = await syncTadToConfluence(draft, 'Tambah tiket Jira untuk task baru');
      published = true;
      toasts.show(`Confluence diperbarui ke v${res.version}.`, 'ok');
    } catch (e) {
      toasts.show((e as Error).message, 'err', 8000);
    } finally {
      publishing = false;
    }
  }
</script>

<Modal bind:open title="Buat tiket Jira untuk task baru" subtitle="Task di Development Scope yang belum punya tiket, misalnya setelah scope berubah" width={820}>
  <div class="tickets">
    {#if loading}
      <p class="muted">Membaca tiket yang sudah ada di TAD ini…</p>
    {:else if results}
      <ul class="results">
        {#each results as r (r.title)}
          <li>
            {#if r.error}
              <Icon name="alert" size={13} /> <span class="t">{r.title}</span> <span class="err">{r.error}</span>
            {:else}
              <Icon name="check" size={13} /> <span class="t">{r.title}</span>
              <a href={r.url} target="_blank" rel="noreferrer">{r.key}</a>
              {#if r.existed}<span class="pill">sudah ada, ditautkan</span>{/if}
            {/if}
          </li>
        {/each}
      </ul>
      {#if notWritten.length}
        <p class="note warn">Key untuk {notWritten.length} task tidak bisa ditulis otomatis karena barisnya tidak ditemukan di tabel Development Scope. Isi kolom Jira-nya manual: {notWritten.join('; ')}</p>
      {:else if results.some((r) => r.key)}
        <p class="muted small">Key tiket sudah ditulis ke kolom Jira Task di Development Scope (satu revisi, bisa dikembalikan dari Revisi).</p>
      {/if}
      {#if linked && results.some((r) => r.key)}
        <p class="muted small">
          {published ? 'Halaman Confluence sudah diperbarui.' : 'Tabel di Confluence belum berisi key baru. Publish sekarang agar tim melihatnya; kalau halaman sudah diubah orang lain, kamu diminta menggabungkan dulu.'}
        </p>
      {/if}
    {:else}
      {#if error}<p class="note err">{error}</p>{/if}
      {#if !tasks.length}
        <p class="muted">Semua task di Development Scope sudah punya tiket Jira.</p>
      {:else}
        <div class="form">
          <label>
            <span>Project</span>
            <select class="input" bind:value={project}>
              {#each projects as p (p.key)}<option value={p.key}>{p.key} · {p.name}</option>{/each}
              {#if project && !projects.some((p) => p.key === project)}<option value={project}>{project}</option>{/if}
            </select>
          </label>
          <label>
            <span>Tipe issue</span>
            <select class="input" bind:value={issueType}>
              {#each types as t (t.id)}<option value={t.name}>{t.name}</option>{/each}
              {#if issueType && !types.some((t) => t.name === issueType)}<option value={issueType}>{issueType}</option>{/if}
            </select>
          </label>
          <label>
            <span>Epic / parent</span>
            <input class="input" bind:value={parentKey} placeholder="mis. MU-2100 (kosongkan jika tidak ada)" />
          </label>
          <label>
            <span>Label</span>
            <input class="input" bind:value={labels} placeholder="pisahkan dengan koma" />
          </label>
          <label>
            <span>Component</span>
            <input class="input" bind:value={components} placeholder="pisahkan dengan koma" />
          </label>
        </div>
        <p class="muted small">
          {#if basedOn.length}
            Default diambil dari {basedOn.length} tiket yang sudah ada di TAD ini{parentSummary && parentKey ? ` (epic: ${parentSummary})` : ''}.
          {:else}
            TAD ini belum punya tiket Jira, jadi isi project dan epic-nya sendiri.
          {/if}
          Tiket dengan judul yang sama persis di project ini ditautkan, tidak dibuat ulang.
        </p>

        <ul class="tasks">
          {#each tasks as t (t.title)}
            <li>
              <label class="row">
                <input type="checkbox" bind:checked={selected[t.title]} />
                <span class="t">{t.title}</span>
                {#if t.service}<span class="pill">{t.service}</span>{/if}
              </label>
              <button class="btn btn-ghost btn-sm" onclick={() => (expanded = expanded === t.title ? null : t.title)}>{expanded === t.title ? 'Tutup' : 'Deskripsi'}</button>
              {#if expanded === t.title}
                <pre class="desc">{ticketDescription(draft.markdown, t, tad)}</pre>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    {#if dropped.length && !loading}
      <div class="dropped">
        <strong>Tiket dari task yang sudah dihapus dari scope</strong>
        <p class="muted small">Masih terbuka di Jira. Cockpit tidak mengubahnya; tutup atau pindahkan sendiri bila memang tidak dikerjakan.</p>
        <ul>
          {#each dropped as i (i.key)}
            <li><a href={i.url} target="_blank" rel="noreferrer">{i.key}</a> {i.summary} <span class="pill">{i.status}</span></li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <div class="foot">
      <span class="grow"></span>
      {#if results}
        <button class="btn btn-sm" onclick={() => (open = false)}>Tutup</button>
        {#if linked && results.some((r) => r.key) && !published}
          <button class="btn btn-primary btn-sm" onclick={publish} disabled={publishing}><Icon name="upload" size={13} /> {publishing ? 'Mempublish…' : 'Publish ke Confluence'}</button>
        {/if}
      {:else}
        <button class="btn btn-sm" onclick={() => (open = false)}>Batal</button>
        <button class="btn btn-primary btn-sm" onclick={create} disabled={creating || loading || !chosen.length || !project || !issueType}>
          <Icon name="jira" size={13} />
          {creating ? 'Membuat tiket…' : `Buat ${chosen.length} tiket${issueType ? ` ${issueType}` : ''}${project ? ` di ${project}` : ''}`}
        </button>
      {/if}
    </div>
  {/snippet}
</Modal>

<style>
  .tickets {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .form {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px 12px;
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }
  .form label span {
    color: var(--text-2, var(--text));
    font-weight: 600;
  }
  .tasks,
  .results,
  .dropped ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tasks li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
  }
  .t {
    overflow-wrap: anywhere;
  }
  .results li {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 12.5px;
  }
  .desc {
    flex-basis: 100%;
    margin: 4px 0 0;
    max-height: 260px;
    overflow: auto;
    padding: 8px;
    border-radius: var(--radius-sm);
    background: var(--bg);
    border: 1px solid var(--border);
    font-size: 11.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .pill {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--surface-hover);
    white-space: nowrap;
  }
  .note {
    margin: 0;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    font-size: 12.5px;
  }
  .note.warn {
    background: var(--warn-soft);
  }
  .note.err,
  .err {
    color: var(--err);
  }
  .dropped {
    padding: 8px 10px;
    border: 1px dashed var(--warn);
    border-radius: var(--radius-sm);
    font-size: 12.5px;
  }
  .dropped p {
    margin: 2px 0 6px;
  }
  .small {
    font-size: 12px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .grow {
    flex: 1;
  }
</style>
