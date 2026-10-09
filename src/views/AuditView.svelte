<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import type { AuditEvent } from '../lib/confluence/api-types';
  import { connector, ConnectorRequestError } from '../lib/confluence/client';

  let events = $state<AuditEvent[]>([]);
  let error = $state('');
  let loading = $state(true);

  async function refresh() {
    loading = true;
    try {
      events = await connector.audit();
      error = '';
    } catch (e) {
      error = e instanceof ConnectorRequestError ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh();
  });

  const ACTION_LABEL: Record<string, string> = {
    'confluence.create': 'Create',
    'confluence.update': 'Update',
    'whatsapp.send': 'Kirim WA',
    'remote.enable': 'Remote aktif',
    'remote.disable': 'Remote nonaktif',
    'remote.pair': 'Remote pairing',
    'remote.revoke': 'Remote cabut',
    'remote.connect': 'Remote tersambung',
    'remote.action': 'Remote aksi',
    'qa.run': 'Run E2E',
    'report.install': 'Pasang laporan',
    'report.send': 'Kirim laporan',
    'bug.ticket': 'Tiket bug',
  };

  const fmt = (ts: string) => new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<section class="page">
  <header>
    <div>
      <h1>Audit log</h1>
      <p class="muted">Semua write action: publish Confluence dan pesan WhatsApp yang dikirim. Disimpan lokal di <code>~/.tech-lead-cockpit/audit.jsonl</code> — metadata saja, tanpa isi dokumen atau isi pesan.</p>
    </div>
    <button class="btn" onclick={refresh} disabled={loading}><Icon name="refresh" /> Muat ulang</button>
  </header>

  {#if error}
    <p class="muted">{error}</p>
  {:else if !loading && !events.length}
    <div class="empty">
      <Icon name="history" size={28} />
      <p>Belum ada aktivitas publish.</p>
    </div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Waktu</th><th>Aksi</th><th>Halaman</th><th>Versi</th><th>Hasil</th><th>Actor</th></tr>
        </thead>
        <tbody>
          {#each events as e (e.ts + e.title)}
            <tr>
              <td class="nowrap">{fmt(e.ts)}</td>
              <td>{ACTION_LABEL[e.action] ?? e.action}</td>
              <td>
                <div>{e.title}</div>
                <div class="muted small">{e.spaceKey}{e.pageId ? ` · #${e.pageId}` : ''}{e.attachments ? ` · ${e.attachments} diagram` : ''}</div>
              </td>
              <td class="nowrap">{e.versionBefore ?? '—'} → {e.versionAfter ?? '—'}</td>
              <td>
                {#if e.result === 'success'}<span class="chip chip-ok">Berhasil</span>
                {:else}<span class="chip chip-err" title={e.error}>Gagal</span>{/if}
              </td>
              <td>{e.actor ?? '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .page {
    max-width: 1000px;
    margin: 0 auto;
    padding: 28px 24px;
    height: 100%;
    overflow: auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 20px;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 22px;
  }
  header p {
    margin: 0;
  }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .empty {
    display: grid;
    place-items: center;
    gap: 4px;
    padding: 48px;
    color: var(--text-3);
    border: 1px dashed var(--border-strong);
    border-radius: 10px;
  }
  .table-wrap {
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th {
    font-size: 12px;
    color: var(--text-3);
    font-weight: 600;
    background: var(--surface-2);
  }
  tr:last-child td {
    border-bottom: 0;
  }
  .nowrap {
    white-space: nowrap;
  }
  .small {
    font-size: 12px;
  }
</style>
