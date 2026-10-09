<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { jira } from '../lib/jira/client';
  import type { JiraIssueDetail, JiraTransition } from '../lib/jira/types';
  import { suggestTransition, type ReviewVerdict } from '../lib/tad/task-links';

  let {
    keys,
    mrUrl,
    headSha,
    verdict,
    jiraBase,
  }: {
    keys: string[];
    mrUrl?: string;
    headSha?: string;
    /** Outcome of the AI review or MR state; drives the suggested transition. */
    verdict?: ReviewVerdict;
    jiraBase?: string;
  } = $props();

  type Row = { issue?: JiraIssueDetail; error?: string; transitions?: JiraTransition[]; loading: boolean; moving: boolean };
  let rows = $state<Record<string, Row>>({});

  const VERDICT_LABEL: Record<ReviewVerdict, string> = {
    approve: 'review APPROVE',
    changes: 'review REQUEST CHANGES',
    merged: 'MR sudah merged',
  };

  $effect(() => {
    const ks = keys;
    untrack(() => {
      for (const k of ks) if (!rows[k]) void load(k);
    });
  });

  async function load(key: string) {
    rows[key] = { loading: true, moving: false };
    try {
      const [issue, transitions] = await Promise.all([jira.issue(key), jira.transitions(key)]);
      rows[key] = { issue, transitions, loading: false, moving: false };
    } catch (e) {
      rows[key] = { error: (e as Error).message, loading: false, moving: false };
    }
  }

  async function move(key: string, t: JiraTransition) {
    const row = rows[key];
    if (!row?.issue) return;
    const ok = await confirmDialog({
      title: `Pindahkan ${key}?`,
      message: [
        `${row.issue.summary}`,
        '',
        `Status: ${row.issue.status} → ${t.to.name} (transisi "${t.name}")`,
        mrUrl ? `MR: ${mrUrl}${headSha ? ` @ ${headSha.slice(0, 8)}` : ''}` : '',
        '',
        'Perubahan ini langsung tercatat di Jira dan di Audit log Cockpit.',
      ]
        .filter((l, i, a) => l || a[i - 1])
        .join('\n'),
      confirmText: `Pindahkan ke ${t.to.name}`,
    });
    if (!ok) return;
    row.moving = true;
    try {
      const res = await jira.transition(key, t.id, { mrUrl, headSha, expectedStatus: row.issue.status });
      toasts.show(`${key}: ${res.from ?? row.issue.status} → ${res.to ?? t.to.name}`, 'ok');
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      await load(key);
    }
  }
</script>

<section class="jira">
  <h4><Icon name="jira" size={14} /> Tiket Jira</h4>
  {#if !keys.length}
    <p class="muted small">Tidak ada Jira key di branch, judul, deskripsi, atau commit MR ini. Gunakan nama branch seperti <code>feature/MU-1234-…</code>.</p>
  {/if}
  {#each keys as key (key)}
    {@const row = rows[key]}
    {@const suggested = row?.transitions ? suggestTransition(row.transitions, verdict) : undefined}
    <div class="issue">
      <div class="issue-head">
        {#if jiraBase}
          <a class="key mono" href="{jiraBase}/browse/{key}" target="_blank" rel="noreferrer">{key}</a>
        {:else}
          <span class="key mono">{key}</span>
        {/if}
        {#if row?.issue}
          <span class="status">{row.issue.status}</span>
          <span class="summary" title={row.issue.summary}>{row.issue.summary}</span>
        {:else if row?.loading}
          <span class="muted small">Memuat…</span>
        {/if}
        <button class="icon-btn" title="Muat ulang" onclick={() => load(key)} disabled={row?.loading}><Icon name="refresh" size={13} /></button>
      </div>
      {#if row?.error}
        <p class="err small">{row.error}</p>
      {:else if row?.issue}
        <div class="meta muted small">
          {row.issue.issueType}{row.issue.assignee ? ` · ${row.issue.assignee.displayName}` : ' · belum ada assignee'}
        </div>
        {#if row.transitions?.length}
          <div class="moves">
            {#if suggested}
              <button class="btn btn-primary btn-sm" onclick={() => move(key, suggested)} disabled={row.moving} title="Disarankan karena {verdict ? VERDICT_LABEL[verdict] : ''}">
                <Icon name="sparkles" size={12} /> {suggested.to.name}
              </button>
              <span class="muted small">disarankan ({verdict ? VERDICT_LABEL[verdict] : ''})</span>
            {/if}
            <select
              class="input move-select"
              disabled={row.moving}
              onchange={(e) => {
                const t = row.transitions?.find((x) => x.id === e.currentTarget.value);
                e.currentTarget.value = '';
                if (t) void move(key, t);
              }}
            >
              <option value="">Pindahkan ke…</option>
              {#each row.transitions as t (t.id)}
                <option value={t.id}>{t.to.name}{t.name !== t.to.name ? ` (${t.name})` : ''}</option>
              {/each}
            </select>
          </div>
        {:else}
          <p class="muted small">Tidak ada transisi yang tersedia dari status ini untuk akunmu.</p>
        {/if}
      {/if}
    </div>
  {/each}
</section>

<style>
  .jira {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  h4 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }
  .small {
    font-size: 12.5px;
  }
  .issue {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--surface-2);
  }
  .issue-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .key {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--accent);
    text-decoration: none;
    flex-shrink: 0;
  }
  .status {
    flex-shrink: 0;
    padding: 1px 9px;
    border-radius: 999px;
    background: var(--surface);
    font-size: 12px;
    font-weight: 500;
  }
  .summary {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--text-3);
    cursor: pointer;
  }
  .icon-btn:hover {
    background: var(--surface-hover);
  }
  .moves {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .move-select {
    width: auto;
    min-width: 180px;
    min-height: 30px;
    padding: 3px 10px;
    font-size: 12.5px;
  }
  .err {
    margin: 0;
    color: var(--err);
  }
  code {
    font-size: 12px;
  }
</style>
