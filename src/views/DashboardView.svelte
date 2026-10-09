<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { teams } from '../lib/teams/client';
  import type { TeamsStatus, TeamsChat } from '../lib/teams/types';
  import { drafts, draftTitle } from '../tad/drafts.svelte';
  import { aiProviders } from '../lib/ai/providers.svelte';
  import { connector } from '../lib/confluence/client';
  import { jira } from '../lib/jira/client';
  import type { JiraStatus, JiraIssue } from '../lib/jira/types';
  import { OPEN_MR_KEY } from '../lib/gitlab/client';
  import { aiUsage } from '../lib/ai/usage.svelte';
  import { api } from '../lib/api-base';

  let teamsStatus = $state<TeamsStatus | null>(null);
  let teamsChats = $state<TeamsChat[]>([]);
  let loadingTeams = $state(true);
  let confluenceConfigured = $state(false);
  let jiraStatus = $state<JiraStatus | null>(null);
  let jiraIssues = $state<JiraIssue[]>([]);

  // Quick MR Queue
  let manualMR = $state('');
  let customMRs = $state<string[]>(loadCustomMRs());

  function loadCustomMRs(): string[] {
    try {
      return JSON.parse(localStorage.getItem('tlc.dashboard.custom_mrs') ?? '[]');
    } catch {
      return [];
    }
  }

  function saveCustomMRs(list: string[]) {
    customMRs = list;
    try {
      localStorage.setItem('tlc.dashboard.custom_mrs', JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  function addManualMR() {
    if (!manualMR.trim()) return;
    const url = manualMR.trim();
    if (!customMRs.includes(url)) {
      saveCustomMRs([url, ...customMRs]);
      toasts.show('Link MR ditambahkan ke antrian review!', 'ok');
    }
    manualMR = '';
  }

  function removeCustomMR(url: string) {
    saveCustomMRs(customMRs.filter((u) => u !== url));
  }

  // Derived MRs
  const detectedMRs = $derived.by(() => {
    const list: { url: string; source: string; channelId?: string }[] = [];
    for (const c of teamsChats) {
      if (c.detectedMRs) {
        for (const url of c.detectedMRs) {
          list.push({ url, source: c.title, channelId: c.id });
        }
      }
    }
    for (const url of customMRs) {
      list.push({ url, source: 'Ditambahkan Manual' });
    }
    return list;
  });

  onMount(() => {
    refreshAll();
  });

  async function refreshAll() {
    loadingTeams = true;
    try {
      teamsStatus = await teams.status().catch(() => null);
      if (teamsStatus?.connected) {
        teamsChats = await teams.chats().catch(() => []);
      }
      const confStatus = await connector.status().catch(() => null);
      confluenceConfigured = Boolean(confStatus?.configured);
      jiraStatus = await jira.status().catch(() => null);
      if (jiraStatus?.configured) {
        jiraIssues = await jira.issues('assignee = currentUser() ORDER BY updated DESC', 6).catch(() => []);
      } else {
        jiraIssues = [];
      }
      await aiProviders.load();
      aiUsage.load();
    } finally {
      loadingTeams = false;
    }
  }

  function navigateTo(hash: string) {
    location.hash = hash;
  }

  /** Hands the link to the MR Review page, which opens it on load. */
  function openMr(url: string) {
    try {
      sessionStorage.setItem(OPEN_MR_KEY, url);
    } catch {
      /* the page still opens, just without the MR */
    }
    navigateTo('#/mr');
  }

  // ── Header ──
  const greeting = $derived.by(() => {
    const h = new Date().getHours();
    return h < 11 ? 'Selamat pagi' : h < 15 ? 'Selamat siang' : h < 18 ? 'Selamat sore' : 'Selamat malam';
  });
  const firstName = $derived(teamsStatus?.user?.displayName.split(/\s+/)[0]);

  // ── MR card ──
  let addingMR = $state(false);
  const mrFromTeams = $derived(detectedMRs.filter((m) => m.channelId).length);
  const channelsWithMR = $derived(
    [...teamsChats].sort((a, b) => (b.detectedMRs?.length ?? 0) - (a.detectedMRs?.length ?? 0)).slice(0, 3),
  );

  function parseMR(url: string): { project: string; iid: string } {
    const m = url.match(/^https?:\/\/[^/]+\/(.+?)\/-?\/?merge_requests\/(\d+)/);
    return m ? { project: m[1].replace(/\/-$/, ''), iid: m[2] } : { project: url, iid: '' };
  }

  // ── Stat cards ──
  const publishedCount = $derived(drafts.sorted.filter((d) => d.confluence?.pageId).length);
  const jiraInProgress = $derived(jiraIssues.filter((i) => i.statusCategory === 'indeterminate').length);
  const pendingReviews = $derived(drafts.sorted.filter((d) => d.proposal).length);
  const allRevisions = $derived(drafts.sorted.flatMap((d) => d.revisions ?? []));
  const monthStart = $derived(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime());
  const aiRevisionsThisMonth = $derived(
    allRevisions.filter((r) => r.summary.startsWith('AI') && Date.parse(r.timestamp) >= monthStart).length,
  );

  // ── Revision chart: last 8 months, AI vs everything else ──
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const chart = $derived.by(() => {
    const now = new Date();
    const buckets = Array.from({ length: 8 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 7 + i, 1);
      return { key: `${d.getFullYear()}-${d.getMonth()}`, label: MONTHS[d.getMonth()], ai: 0, other: 0 };
    });
    for (const r of allRevisions) {
      const t = new Date(r.timestamp);
      const b = buckets.find((x) => x.key === `${t.getFullYear()}-${t.getMonth()}`);
      if (!b) continue;
      if (r.summary.startsWith('AI')) b.ai++;
      else b.other++;
    }
    const peak = Math.max(...buckets.map((b) => b.ai + b.other));
    const step = Math.max(1, Math.ceil(peak / 4));
    return { buckets, max: step * 4, ticks: [4, 3, 2, 1, 0].map((n) => n * step) };
  });

  // ── Activity table ──
  type RowKind = 'mr' | 'tad' | 'jira';
  type Row = {
    /** Unique per row; ids and titles can repeat (e.g. two drafts of the same TAD). */
    key: string;
    kind: RowKind;
    id: string;
    title: string;
    source: string;
    status: string;
    tone: 'ok' | 'warn' | 'accent' | 'muted';
    date?: string;
    href?: string;
    hash?: string;
    remove?: () => void;
    /** Opens the row inside Cockpit when a plain hash link isn't enough. */
    onOpen?: () => void;
  };
  let query = $state('');
  let kindFilter = $state<'all' | RowKind>('all');

  const rows = $derived.by(() => {
    const out: Row[] = [];
    for (const mr of detectedMRs) {
      const { project, iid } = parseMR(mr.url);
      out.push({
        kind: 'mr',
        key: `mr:${mr.url}:${mr.channelId ?? 'manual'}`,
        onOpen: () => openMr(mr.url),
        id: iid ? `!${iid}` : 'MR',
        title: project,
        source: mr.source,
        status: 'Perlu review',
        tone: 'warn',
        href: mr.url,
        remove: mr.channelId ? undefined : () => removeCustomMR(mr.url),
      });
    }
    for (const d of drafts.sorted) {
      out.push({
        kind: 'tad',
        key: `tad:${d.id}`,
        id: d.source?.jiraKeys?.[0] ?? `TAD-${d.id.slice(0, 4).toUpperCase()}`,
        title: draftTitle(d),
        source: 'TAD Workspace',
        status: d.pendingJobId ? 'AI bekerja' : d.proposal ? 'Menunggu review' : d.confluence?.pageId ? 'Published' : 'Draft',
        tone: d.pendingJobId ? 'accent' : d.proposal ? 'warn' : d.confluence?.pageId ? 'ok' : 'muted',
        date: d.updatedAt,
        href: d.confluence?.url,
        hash: '#/tad',
      });
    }
    for (const i of jiraIssues) {
      out.push({
        kind: 'jira',
        key: `jira:${i.key}`,
        id: i.key,
        title: i.summary,
        source: `Jira · ${i.issueType}`,
        status: i.status,
        tone: i.statusCategory === 'done' ? 'ok' : i.statusCategory === 'indeterminate' ? 'accent' : 'muted',
        date: i.updated,
        href: i.url,
      });
    }
    // Open MRs need attention first; the rest newest first.
    return out.sort((a, b) => (a.kind === 'mr' ? -1 : b.kind === 'mr' ? 1 : (b.date ?? '').localeCompare(a.date ?? '')));
  });

  const visibleRows = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (kindFilter === 'all' || r.kind === kindFilter) &&
        (!q || `${r.id} ${r.title} ${r.source} ${r.status}`.toLowerCase().includes(q)),
    );
  });

  function formatDate(iso?: string): string {
    if (!iso) return '—';
    const t = new Date(iso);
    return Number.isNaN(t.getTime())
      ? '—'
      : t.toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const KIND_ICON = { mr: 'merge', tad: 'doc', jira: 'jira' } as const;
  const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude CLI', antigravity: 'Antigravity CLI' };
</script>


<section class="page">
  <header class="hero">
    <div>
      <h1>{greeting}{#if firstName}, {firstName}{/if}</h1>
      <p>Pantau antrian review, dokumen TAD, dan progres tim dari satu tempat.</p>
    </div>
    <button class="btn" onclick={refreshAll} disabled={loadingTeams}>
      <Icon name="refresh" size={14} />
      {loadingTeams ? 'Memuat…' : 'Refresh data'}
    </button>
  </header>

  <div class="row-top">
    <!-- MR queue (the reference's balance card) -->
    <article class="card">
      <div class="card-head">
        <span class="card-label">Antrian Review MR</span>
        <span class="tag"><Icon name="merge" size={13} /> GitLab</span>
      </div>
      <div class="big">{detectedMRs.length} <small>MR</small></div>
      <div class="trend">
        <span class="delta">{mrFromTeams} dari Teams</span>
        <span class="muted">· {customMRs.length} ditambahkan manual</span>
      </div>

      <div class="actions">
        <button class="btn btn-primary btn-lg" onclick={() => (detectedMRs[0] ? openMr(detectedMRs[0].url) : navigateTo('#/mr'))}>
          <Icon name="sparkles" size={16} /> Review MR
        </button>
        <button class="btn btn-soft btn-lg" onclick={() => (addingMR = !addingMR)} aria-expanded={addingMR}>
          <Icon name="plus" size={16} /> Tambah MR
        </button>
      </div>
      {#if addingMR}
        <form
          class="add-mr"
          onsubmit={(e) => {
            e.preventDefault();
            addManualMR();
          }}
        >
          <!-- svelte-ignore a11y_autofocus -->
          <input class="input" type="url" placeholder="https://gitlab…/merge_requests/123" bind:value={manualMR} autofocus />
          <button class="btn btn-primary" disabled={!manualMR.trim()}>Tambah</button>
        </form>
      {/if}

      <div class="inset">
        <div class="inset-head">
          <span>Channel Teams</span>
          <span class="muted">| {teamsStatus?.connected ? `Total ${teamsChats.length} channel` : 'Belum terhubung'}</span>
        </div>
        {#if !teamsStatus?.connected}
          <button class="inset-empty" onclick={() => navigateTo('#/teams')}>
            <Icon name="teams" size={16} /> Login MS Teams untuk mendeteksi link MR otomatis
          </button>
        {:else if channelsWithMR.length === 0}
          <p class="inset-empty muted">Belum ada percakapan.</p>
        {:else}
          <div class="mini-grid">
            {#each channelsWithMR as ch (ch.id)}
              <button class="mini" onclick={() => navigateTo('#/teams')} title={ch.title}>
                <span class="mini-title">{ch.title}</span>
                <strong>{ch.detectedMRs?.length ?? 0} MR</strong>
                <span class="mini-sub">{ch.lastMessage?.sender ?? '—'}</span>
                <span class="mini-status" class:on={(ch.detectedMRs?.length ?? 0) > 0}>
                  {(ch.detectedMRs?.length ?? 0) > 0 ? 'Ada MR' : 'Tenang'}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </article>

    <!-- 2×2 stats -->
    <article class="card stats">
      <button class="stat hero-stat" onclick={() => navigateTo('#/tad')}>
        <span class="stat-head">Draft TAD <span class="stat-icon"><Icon name="doc" size={16} /></span></span>
        <span class="stat-value">{drafts.sorted.length}</span>
        <span class="stat-foot"><span class="delta">{publishedCount} published</span> di Confluence</span>
      </button>
      <button class="stat" onclick={() => navigateTo('#/connections')}>
        <span class="stat-head">Tiket Jira <span class="stat-icon"><Icon name="jira" size={16} /></span></span>
        <span class="stat-value">{jiraStatus?.configured ? jiraIssues.length : '—'}</span>
        <span class="stat-foot">
          {#if jiraStatus?.configured}<span class="delta">{jiraInProgress} in progress</span> milik saya{:else}Belum terhubung{/if}
        </span>
      </button>
      <button class="stat" onclick={() => navigateTo('#/tad')}>
        <span class="stat-head">Revisi AI <span class="stat-icon"><Icon name="sparkles" size={16} /></span></span>
        <span class="stat-value">{aiRevisionsThisMonth}</span>
        <span class="stat-foot">
          <span class="delta" class:warn={pendingReviews > 0}>{pendingReviews} perlu review</span> bulan ini
        </span>
      </button>
      <button class="stat" onclick={() => navigateTo('#/connections')}>
        <span class="stat-head">Koneksi <span class="stat-icon"><Icon name="plug" size={16} /></span></span>
        <span class="stat-value">{[teamsStatus?.connected, confluenceConfigured, jiraStatus?.configured].filter(Boolean).length}<small>/3</small></span>
        <span class="stat-foot">Teams · Confluence · Jira</span>
      </button>
    </article>

    <!-- Revision chart -->
    <article class="card">
      <h2>Aktivitas TAD</h2>
      <p class="sub">Revisi dokumen per bulan, dari semua draft.</p>
      <div class="inset chart-box">
        <div class="chart-head">
          <span>AI vs Manual</span>
          <span class="legend"><i class="sw sw-ai"></i> AI <i class="sw sw-other"></i> Manual &amp; import</span>
        </div>
        <div class="chart">
          <div class="y-axis">
            {#each chart.ticks as t (t)}<span>{t}</span>{/each}
          </div>
          <div class="plot">
            <div class="grid" aria-hidden="true">
              {#each chart.ticks as t (t)}<span style:bottom="{(t / chart.max) * 100}%"></span>{/each}
            </div>
            {#each chart.buckets as b (b.key)}
              <div class="col" title="{b.label}: {b.ai} revisi AI, {b.other} manual/import">
                <div class="bar">
                  {#if b.ai}<span class="seg seg-ai" style:height="{(b.ai / chart.max) * 100}%"></span>{/if}
                  {#if b.other}<span class="seg seg-other" style:height="{(b.other / chart.max) * 100}%"></span>{/if}
                  {#if !b.ai && !b.other}<span class="seg seg-empty"></span>{/if}
                </div>
                <span class="x">{b.label}</span>
              </div>
            {/each}
          </div>
        </div>
      </div>
    </article>
  </div>

  <div class="row-bottom">
    <div class="col-left">
      <!-- AI plan usage (the reference's spending-limit card) -->
      <article class="card">
        <div class="card-head">
          <h3>Limit & Saldo AI</h3>
          <button class="btn btn-ghost btn-sm" onclick={() => aiUsage.load(true)} disabled={aiUsage.loading} title="Perbarui status">
            <Icon name="refresh" size={13} />
          </button>
        </div>
        {#each ['claude', 'antigravity'] as id (id)}
          {@const usage = aiUsage.get(id as 'claude' | 'antigravity')}
          <div class="limit">
            <span class="limit-name">{PROVIDER_LABEL[id]}</span>
            {#if usage?.windows.length}
              {#each usage.windows.slice(0, 2) as w (w.label)}
                <div class="meter" title={w.resets ? `Reset ${w.resets}` : undefined}>
                  <span class="meter-fill" class:hot={w.usedPercent >= 90} style:width="{Math.min(100, w.usedPercent)}%"></span>
                </div>
                <div class="meter-foot">
                  <span><strong>{w.usedPercent}%</strong> <span class="muted">{w.label}</span></span>
                  <span class="muted">100%</span>
                </div>
              {/each}
            {:else}
              <p class="muted small">{usage?.error ?? (aiUsage.loading ? 'Membaca limit…' : 'Limit belum terbaca.')}</p>
            {/if}
          </div>
        {/each}
        {#if aiUsage.get('inferhub')?.balance}
          {@const inferhubUsage = aiUsage.get('inferhub')}
          <div class="limit">
            <span class="limit-name">InferHub</span>
            <div class="meter-foot">
              <span><strong>{inferhubUsage?.balance?.amount} {inferhubUsage?.balance?.currency ?? 'USDC'}</strong> <span class="muted">saldo akun</span></span>
              {#if inferhubUsage?.balance?.email}<span class="muted">{inferhubUsage.balance.email}</span>{/if}
            </div>
          </div>
        {/if}
      </article>

    </div>

    <!-- Unified activity table -->
    <article class="card table-card">
      <div class="table-head">
        <h2>Aktivitas terbaru</h2>
        <label class="search">
          <Icon name="search" size={16} />
          <input type="search" placeholder="Cari" bind:value={query} aria-label="Cari aktivitas" />
        </label>
        <label class="filter">
          <select bind:value={kindFilter} aria-label="Filter jenis">
            <option value="all">Semua</option>
            <option value="mr">MR</option>
            <option value="tad">TAD</option>
            <option value="jira">Jira</option>
          </select>
          <Icon name="filter" size={14} />
        </label>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Aktivitas</th>
              <th>Sumber</th>
              <th>Status</th>
              <th>Diperbarui</th>
              <th><span class="sr-only">Aksi</span></th>
            </tr>
          </thead>
          <tbody>
            {#each visibleRows as r (r.key)}
              <tr>
                <td class="mono id">{r.id}</td>
                <td>
                  <span class="activity">
                    <span class="kind kind-{r.kind}"><Icon name={KIND_ICON[r.kind]} size={14} /></span>
                    <span class="activity-title" title={r.title}>{r.title}</span>
                  </span>
                </td>
                <td class="muted source" title={r.source}>{r.source}</td>
                <td><span class="status tone-{r.tone}">{r.status}</span></td>
                <td class="date">{formatDate(r.date)}</td>
                <td class="row-actions">
                  {#if r.onOpen}
                    <button class="icon-btn" onclick={r.onOpen} title="Review di Cockpit"><Icon name="eye" size={15} /></button>
                  {:else if r.hash}
                    <button class="icon-btn" onclick={() => navigateTo(r.hash!)} title="Buka di Cockpit"><Icon name="eye" size={15} /></button>
                  {/if}
                  {#if r.href}
                    <a class="icon-btn" href={r.href} target="_blank" rel="noreferrer" title="Buka di sumber"><Icon name="external" size={15} /></a>
                  {/if}
                  {#if r.remove}
                    <button class="icon-btn" onclick={r.remove} title="Hapus dari antrian"><Icon name="trash" size={15} /></button>
                  {/if}
                </td>
              </tr>
            {:else}
              <tr>
                <td colspan="6" class="empty muted">
                  {rows.length ? 'Tidak ada yang cocok dengan pencarian.' : 'Belum ada aktivitas. Tambahkan MR, buat draft TAD, atau hubungkan Jira.'}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </article>
  </div>
</section>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
    padding: 6px 4px 8px;
  }
  .hero {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 22px;
  }
  h1 {
    margin: 0 0 6px;
    font-size: 38px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .hero p {
    margin: 0;
    color: var(--text-2);
    font-size: 15px;
  }

  .row-top {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px;
    margin-bottom: 18px;
  }
  .row-bottom {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    gap: 18px;
    align-items: start;
  }
  .col-left {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .card {
    background: var(--surface);
    border-radius: var(--radius-lg);
    padding: 20px;
    box-shadow: var(--shadow-sm);
    min-width: 0;
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .card-label {
    color: var(--text-2);
    font-size: 15px;
  }
  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: 17px;
    font-weight: 500;
  }
  .head-icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 1px solid var(--border);
    color: var(--accent);
  }
  .sub {
    margin: 4px 0 16px;
    color: var(--text-2);
  }
  .small {
    font-size: 12.5px;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--text-2);
  }

  .big {
    margin: 10px 0 6px;
    font-size: 34px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .big small,
  .stat-value small {
    font-size: 0.5em;
    font-weight: 500;
    color: var(--text-3);
    margin-left: 2px;
  }
  .trend {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .delta {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 500;
    font-size: 12.5px;
  }
  .delta.warn {
    background: var(--warn-soft);
    color: var(--warn);
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 18px 0 14px;
  }
  .btn-lg {
    height: 48px;
    justify-content: center;
    font-size: 15px;
  }
  .btn-soft {
    background: var(--surface-2);
    border-color: transparent;
  }
  .btn-block {
    width: 100%;
    justify-content: center;
  }
  .add-mr {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
  }

  .inset {
    background: var(--surface-2);
    border-radius: 16px;
    padding: 14px;
  }
  .inset-head {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
    font-size: 14px;
  }
  .inset-empty {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    margin: 0;
    padding: 14px;
    border: 1px dashed var(--border-strong);
    border-radius: 12px;
    background: none;
    color: var(--text-2);
    cursor: pointer;
    font-size: 13px;
    text-align: left;
  }
  p.inset-empty {
    cursor: default;
  }
  .mini-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .mini {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 10px 12px;
    border: 0;
    border-radius: 12px;
    background: var(--surface);
    text-align: left;
    cursor: pointer;
  }
  .mini:hover {
    box-shadow: 0 0 0 1px var(--accent-2);
  }
  .mini-title,
  .mini-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini-title {
    font-weight: 500;
    font-size: 12.5px;
  }
  .mini strong {
    font-size: 16px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .mini-sub {
    color: var(--text-3);
    font-size: 11px;
  }
  .mini-status {
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-3);
  }
  .mini-status.on {
    color: var(--accent);
    font-weight: 500;
  }

  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-auto-rows: 1fr;
    gap: 14px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 14px;
    min-width: 0;
    padding: 18px;
    border: 0;
    border-radius: 18px;
    background: var(--surface-2);
    text-align: left;
    cursor: pointer;
    transition: transform 0.15s;
  }
  .stat:hover {
    transform: translateY(-2px);
  }
  .stat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 15px;
  }
  .stat-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--surface-hover);
    color: var(--text-2);
  }
  .stat-value {
    font-size: 34px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .stat-foot {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    color: var(--text-3);
  }
  .hero-stat {
    background: var(--accent-grad);
    color: #fff;
  }
  .hero-stat .stat-icon {
    background: rgb(255 255 255 / 0.16);
    color: #fff;
  }
  .hero-stat .stat-foot {
    color: rgb(255 255 255 / 0.75);
  }
  .hero-stat .delta {
    background: rgb(255 255 255 / 0.16);
    color: #fff;
  }

  .chart-box {
    padding: 16px 16px 12px;
  }
  .chart-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 14px;
    font-size: 14px;
  }
  .legend {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-2);
  }
  .sw {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    margin-left: 6px;
  }
  .sw-ai,
  .seg-ai {
    background: repeating-linear-gradient(135deg, var(--accent-2) 0 4px, color-mix(in srgb, var(--accent-2) 70%, #fff) 4px 7px);
  }
  .sw-other,
  .seg-other {
    background: var(--ink);
  }
  .chart {
    display: flex;
    gap: 8px;
    height: 210px;
  }
  .y-axis {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding-bottom: 22px;
    font-size: 11.5px;
    color: var(--text-3);
    text-align: right;
    line-height: 0;
  }
  .plot {
    position: relative;
    flex: 1;
    display: flex;
    gap: 8px;
    padding-bottom: 22px;
  }
  .grid {
    position: absolute;
    inset: 0 0 22px;
    pointer-events: none;
  }
  .grid span {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px dashed var(--border-strong);
  }
  .col {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
  }
  .bar {
    position: relative;
    flex: 1;
    width: 100%;
    max-width: 30px;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 4px;
  }
  .seg {
    display: block;
    width: 100%;
    border-radius: 7px;
    min-height: 6px;
  }
  .seg-empty {
    height: 6px;
    background: var(--border);
  }
  .x {
    position: absolute;
    bottom: -22px;
    font-size: 11.5px;
    color: var(--text-3);
    line-height: 22px;
  }

  .limit {
    margin-top: 16px;
  }
  .limit-name {
    display: block;
    font-weight: 500;
    font-size: 13px;
    margin-bottom: 8px;
  }
  .meter {
    height: 14px;
    border-radius: 999px;
    background: repeating-linear-gradient(135deg, var(--surface-2) 0 5px, var(--border) 5px 7px);
    overflow: hidden;
  }
  .meter-fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
    transition: width 0.3s;
  }
  .meter-fill.hot {
    background: var(--err);
  }
  .meter-foot {
    display: flex;
    justify-content: space-between;
    margin: 6px 0 10px;
    font-size: 12.5px;
  }

  .table-card {
    padding: 22px;
  }
  .table-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
  }
  .table-head h2 {
    flex: 1;
  }
  .search,
  .filter {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 42px;
    padding: 0 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text-2);
  }
  .search {
    width: min(280px, 40vw);
  }
  .search input,
  .filter select {
    border: 0;
    outline: none;
    background: none;
    min-width: 0;
  }
  .search input {
    flex: 1;
  }
  .search:focus-within,
  .filter:focus-within {
    border-color: var(--accent);
  }
  .filter select {
    appearance: none;
    padding-right: 4px;
    cursor: pointer;
  }

  .table-wrap {
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  th {
    padding: 12px 14px;
    background: var(--surface-2);
    color: var(--text-2);
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
  }
  td {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    vertical-align: middle;
  }
  tbody tr:hover {
    background: var(--surface-2);
  }
  .id {
    font-size: 12.5px;
    white-space: nowrap;
  }
  .activity {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .activity-title,
  .source {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .activity-title {
    max-width: 320px;
  }
  .source {
    max-width: 180px;
  }
  .kind {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    flex-shrink: 0;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .kind-mr {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .kind-jira {
    background: var(--surface-2);
    color: var(--text-2);
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .status::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .tone-ok::before {
    background: var(--ok);
  }
  .tone-warn::before {
    background: var(--warn);
  }
  .tone-accent::before {
    background: var(--accent);
  }
  .tone-muted::before {
    background: var(--text-3);
  }
  .date {
    white-space: nowrap;
    color: var(--text-2);
  }
  .row-actions {
    display: flex;
    justify-content: flex-end;
    gap: 2px;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--text-3);
    cursor: pointer;
  }
  .icon-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .empty {
    padding: 28px;
    text-align: center;
  }

  @media (max-width: 1280px) {
    .row-top {
      grid-template-columns: 1fr 1fr;
    }
    .row-top > :last-child {
      grid-column: 1 / -1;
    }
  }
  @media (max-width: 960px) {
    .row-top,
    .row-bottom {
      grid-template-columns: minmax(0, 1fr);
    }
    h1 {
      font-size: 28px;
    }
    .table-head {
      flex-wrap: wrap;
    }
  }
</style>
