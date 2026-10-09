<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import type { EstimateProject } from '../lib/estimate/types';
  import { report, type ReportSettings } from '../lib/report/client';
  import { formatWib } from '../lib/report/snapshot';
  import { reportSync } from '../lib/report/sync.svelte';
  import { DAY_LONG, DAY_SHORT, EVERY_DAY, MAX_TIMES, WEEKDAYS, describeSchedule, isTime, nextSends, toServerTime } from '../lib/report/schedule';

  let { open = $bindable(false), projects }: { open: boolean; projects: EstimateProject[] } = $props();

  let settings = $state<ReportSettings | null>(null);
  let deliverMode = $state<'allowlist' | 'custom'>('allowlist');
  let customDeliver = $state('');
  let saving = $state(false);
  let busy = $state<'' | 'sync' | 'install' | 'preview' | 'send' | 'status'>('');
  let error = $state('');
  let previewText = $state('');
  let previewMeta = $state('');
  let statusText = $state('');
  /** The previewed message is shown with a send confirmation. */
  let confirmingSend = $state(false);
  let noSnapshot = $state(false);

  $effect(() => {
    if (open) void load();
  });

  async function load() {
    error = '';
    previewText = '';
    statusText = '';
    try {
      settings = await report.settings();
      deliverMode = settings.deliver === 'allowlist' ? 'allowlist' : 'custom';
      customDeliver = settings.deliver === 'allowlist' ? '' : settings.deliver;
      confirmingSend = false;
      if (settings.installed) void preview();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  // Schedule -------------------------------------------------------------------------------

  /** Mon..Sun order for the day chips. */
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const deliverValue = $derived(deliverMode === 'allowlist' ? 'allowlist' : customDeliver.trim());
  const validTimes = $derived((settings?.times ?? []).filter(isTime));
  const scheduleText = $derived(settings && settings.days.length && validTimes.length ? describeSchedule({ days: settings.days, times: validTimes }) : 'Belum ada jadwal');
  let nowTick = $state(Date.now());
  $effect(() => {
    if (!open) return;
    const t = setInterval(() => (nowTick = Date.now()), 60_000);
    return () => clearInterval(t);
  });
  const upcoming = $derived(settings && settings.days.length && validTimes.length ? nextSends({ days: settings.days, times: validTimes }, new Date(nowTick), 3) : []);
  const sameList = (a: (string | number)[], b: (string | number)[]) => [...a].sort().join() === [...b].sort().join();
  /** Installed on the VPS exactly as shown (days, times, destination). */
  const installedMatches = $derived(
    Boolean(settings?.installed && sameList(settings.installed.days, settings.days) && sameList(settings.installed.times, validTimes) && settings.installed.deliverSetting === deliverValue),
  );

  function toggleDay(d: number) {
    if (!settings) return;
    settings.days = settings.days.includes(d) ? settings.days.filter((x) => x !== d) : [...settings.days, d].sort((a, b) => a - b);
  }

  function addTime() {
    if (!settings || settings.times.length >= MAX_TIMES) return;
    const last = settings.times[settings.times.length - 1] ?? '08:00';
    const [h, m] = last.split(':').map(Number);
    settings.times = [...settings.times, `${String(Math.min(23, (h || 8) + 3)).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`];
  }

  function removeTime(i: number) {
    if (!settings || settings.times.length <= 1) return;
    settings.times = settings.times.filter((_, j) => j !== i);
  }

  const relative = (d: Date) => {
    const mins = Math.round((d.getTime() - nowTick) / 60_000);
    if (mins < 60) return `${mins} menit lagi`;
    if (mins < 24 * 60) return `${Math.round(mins / 60)} jam lagi`;
    return `${Math.round(mins / 1440)} hari lagi`;
  };

  function toggleProject(id: string) {
    if (!settings) return;
    settings.projectIds = settings.projectIds.includes(id) ? settings.projectIds.filter((p) => p !== id) : [...settings.projectIds, id];
  }

  async function save(): Promise<boolean> {
    if (!settings) return false;
    saving = true;
    error = '';
    try {
      settings = await report.saveSettings({ ...$state.snapshot(settings), times: validTimes, deliver: deliverValue });
      return true;
    } catch (e) {
      error = (e as Error).message;
      return false;
    } finally {
      saving = false;
    }
  }

  async function syncNow() {
    if (!(await save())) return;
    busy = 'sync';
    const r = await reportSync.syncNow();
    busy = '';
    settings = await report.settings().catch(() => settings);
    if (r.ok) toasts.show('Snapshot progres terkirim ke VPS.', 'ok');
    else toasts.show(r.skipped ?? r.error ?? 'Sinkron gagal.', r.skipped ? 'info' : 'err', 6000);
  }

  async function install() {
    if (!settings || !(await save())) return;
    const ok = await confirmDialog({
      title: 'Pasang di VPS?',
      message: `Cockpit akan mengunggah reporter ke ${settings.user}@${settings.host} dan memasang jadwal Hermes: ${describeSchedule({ days: settings.days, times: settings.times })} (${settings.times.length} job). Job lama laporan ini diganti.`,
      confirmText: 'Pasang',
    });
    if (!ok) return;
    busy = 'install';
    try {
      const r = await report.install();
      settings = r.settings;
      statusText = r.output;
      toasts.show('Laporan terjadwal terpasang di Hermes VPS.', 'ok');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = '';
    }
  }

  async function preview() {
    busy = 'preview';
    error = '';
    try {
      const r = await report.preview();
      noSnapshot = r.meta.error === 'no-snapshot';
      previewText = r.text || '(kosong — tidak ada proyek dengan TAD)';
      const m = r.meta;
      previewMeta = [m.generatedAt ? `Data per ${formatWib(m.generatedAt)}` : '', m.jiraRefreshedAt ? 'status Jira diperbarui' : m.jiraError ? `refresh Jira gagal: ${m.jiraError}` : 'status Jira dari snapshot', m.previousAt ? `dibanding laporan ${formatWib(m.previousAt)}` : 'belum ada laporan sebelumnya']
        .filter(Boolean)
        .join(' · ');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = '';
    }
  }

  /** Step 1: render the exact message on the VPS and show it with the destination. */
  async function reviewBeforeSend() {
    if (!settings?.installed) return;
    await preview();
    if (previewText && !error) confirmingSend = true;
  }

  /** Step 2: Hermes runs the job, rendering and delivering the same message. */
  async function sendNow() {
    if (!settings?.installed) return;
    confirmingSend = false;
    busy = 'send';
    try {
      statusText = (await report.sendNow()).output;
      toasts.show('Hermes mengirim laporan; cek WhatsApp.', 'ok');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = '';
    }
  }

  async function status() {
    busy = 'status';
    try {
      statusText = await report.status();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = '';
    }
  }

  const fmt = (iso?: string) => (iso ? formatWib(iso) : '-');
</script>

<Modal bind:open title="Laporan Terjadwal" subtitle="Progres proyek dikirim otomatis ke WhatsApp oleh Hermes di VPS — laptop tidak perlu menyala" width={780}>
  {#if !settings}
    <p class="muted">{error || 'Memuat…'}</p>
  {:else}
    <div class="body">
      <section class="how muted small">
        Cockpit mengirim snapshot progres (MR GitLab + Jira, logika progres sama dengan Task Board) ke VPS tiap 15 menit selama app terbuka dan VPN aktif.
        Pada jam kirim, Hermes memperbarui status Jira dan mengirim laporannya; bila data sudah lama, pesannya diberi peringatan.
      </section>

      <div class="grid">
        <label class="field">
          <span>VPS (IP / host)</span>
          <input class="input mono" bind:value={settings.host} placeholder="203.0.113.10" />
        </label>
        <label class="field">
          <span>User SSH</span>
          <input class="input mono" bind:value={settings.user} />
        </label>
        <label class="field small-field">
          <span>Port</span>
          <input class="input mono" type="number" bind:value={settings.port} min="1" max="65535" />
        </label>
      </div>
      <p class="muted small">Login memakai SSH key laptop ini (tanpa password). Belum terpasang? Jalankan <code>ssh-copy-id {settings.user}@{settings.host || 'IP-VPS'}</code>.</p>

      <div class="field">
        <span>Proyek yang dilaporkan</span>
        {#if !projects.length}<p class="muted small">Belum ada proyek.</p>{/if}
        <div class="checks">
          {#each projects as p (p.id)}
            <label class="check"><input type="checkbox" checked={settings.projectIds.includes(p.id)} onchange={() => toggleProject(p.id)} /> {p.name} <span class="muted small">({p.draftIds.length} TAD)</span></label>
          {/each}
        </div>
      </div>

      <section class="schedule">
        <div class="sched-summary">
          <span class="muted small">Jadwal kirim</span>
          <strong class="sched-text">{scheduleText}</strong>
          {#if upcoming.length}
            <div class="next">
              {#each upcoming as d, i (d.getTime())}
                <span class="next-item" class:first={i === 0}>{i === 0 ? 'Berikutnya: ' : ''}{formatWib(d.toISOString())}{i === 0 ? ` (${relative(d)})` : ''}</span>
              {/each}
            </div>
          {/if}
          {#if settings.installed?.serverOffset && validTimes.length}
            <span class="muted small">Di jam server VPS (UTC{settings.installed.serverOffset.slice(0, 3)}:{settings.installed.serverOffset.slice(3)}): {validTimes.map((t) => { const s2 = toServerTime(t, settings!.installed!.serverOffset); return `${t} WIB = ${s2.time}${s2.dayShift > 0 ? ' (+1 hari)' : ''}`; }).join(' · ')}</span>
          {/if}
          {#if !settings.installed}
            <span class="badge warn-badge">Belum terpasang di VPS — klik "Pasang di VPS"</span>
          {:else if installedMatches}
            <span class="badge ok-badge"><Icon name="check" size={11} /> Terpasang di Hermes VPS sesuai jadwal ini ({settings.installed.jobs.length} job) → {settings.installed.deliver}</span>
          {:else}
            <span class="badge warn-badge">Jadwal/tujuan berubah — belum aktif sampai kamu klik "Perbarui di VPS". Yang berjalan sekarang: {describeSchedule({ days: settings.installed.days, times: settings.installed.times })}</span>
          {/if}
        </div>

        <div class="sched-edit">
          <div class="field">
            <span>Hari</span>
            <div class="days">
              {#each DAY_ORDER as d (d)}
                <button type="button" class="day" class:on={settings.days.includes(d)} onclick={() => toggleDay(d)} aria-pressed={settings.days.includes(d)} title={DAY_LONG[d]}>{DAY_SHORT[d]}</button>
              {/each}
              <button type="button" class="btn btn-ghost btn-xs" onclick={() => settings && (settings.days = [...WEEKDAYS])}>Hari kerja</button>
              <button type="button" class="btn btn-ghost btn-xs" onclick={() => settings && (settings.days = [...EVERY_DAY])}>Setiap hari</button>
            </div>
          </div>
          <div class="field">
            <span>Jam kirim (WIB)</span>
            <div class="times">
              {#each settings.times as _, i (i)}
                <span class="time-item">
                  <input class="input time" type="time" bind:value={settings.times[i]} aria-label="Jam kirim {i + 1}" />
                  {#if settings.times.length > 1}<button type="button" class="x-btn" onclick={() => removeTime(i)} aria-label="Hapus jam {settings.times[i]}"><Icon name="x" size={11} /></button>{/if}
                </span>
              {/each}
              {#if settings.times.length < MAX_TIMES}<button type="button" class="btn btn-ghost btn-xs" onclick={addTime}><Icon name="plus" size={11} /> Tambah jam</button>{/if}
            </div>
          </div>
          <div class="field">
            <span>Kirim ke</span>
            <select class="input" bind:value={deliverMode}>
              <option value="allowlist">Nomor di allowlist bot (chat pribadi)</option>
              <option value="custom">Nomor / grup lain</option>
            </select>
            {#if deliverMode === 'custom'}
              <input class="input mono" bind:value={customDeliver} placeholder="whatsapp:62812xxxx atau whatsapp:1203…@g.us" />
            {/if}
          </div>
        </div>
        <p class="muted small sched-note">Hermes mengirim pada jadwal ini meskipun laptop mati; isi pesan memakai data sinkron terakhir dari Cockpit. Hari libur nasional tidak dilewati otomatis.</p>
      </section>

      <label class="check"><input type="checkbox" bind:checked={settings.enabled} /> <strong>Sinkron otomatis</strong>: kirim data terbaru ke VPS tiap 15 menit selama Cockpit terbuka (VPN aktif)</label>

      <div class="state">
        <div><span class="muted small">Sinkron data terakhir</span><strong>{fmt(settings.lastSync?.at)}</strong>
          {#if settings.lastSync && !settings.lastSync.ok}<span class="err small">{settings.lastSync.error}</span>{/if}
          {#if reportSync.last?.skipped}<span class="warn small">{reportSync.last.skipped}</span>{/if}
        </div>
        <div><span class="muted small">Job Hermes di VPS</span><strong>{settings.installed ? settings.installed.jobs.map((j) => `${j.name} (${j.cron})`).join(' · ') : 'Belum dipasang'}</strong>
          {#if settings.installed}<span class="muted small">dipasang {fmt(settings.installed.at)}</span>{/if}
        </div>
      </div>

      {#if error}<p class="err small">{error}</p>{/if}

      <div class="actions">
        <button class="btn btn-sm" onclick={save} disabled={saving}>{saving ? 'Menyimpan…' : 'Simpan'}</button>
        <button class="btn btn-sm" onclick={syncNow} disabled={Boolean(busy) || !settings.host}><Icon name="refresh" size={13} /> {busy === 'sync' ? 'Sinkron…' : 'Sinkron sekarang'}</button>
        <button class="btn btn-sm" onclick={install} disabled={Boolean(busy) || !settings.host}><Icon name="upload" size={13} /> {busy === 'install' ? 'Memasang…' : settings.installed ? (installedMatches ? 'Pasang ulang di VPS' : 'Perbarui di VPS') : 'Pasang di VPS'}</button>
        <button class="btn btn-sm" onclick={preview} disabled={Boolean(busy) || !settings.installed}><Icon name="eye" size={13} /> {busy === 'preview' ? 'Memuat…' : 'Muat ulang pratinjau'}</button>
        <button class="btn btn-sm" onclick={status} disabled={Boolean(busy) || !settings.installed}>Status cron</button>
        <span class="grow"></span>
        <button class="btn btn-primary btn-sm" onclick={reviewBeforeSend} disabled={Boolean(busy) || !settings.installed}><Icon name="send" size={13} /> {busy === 'send' ? 'Mengirim…' : 'Kirim sekarang…'}</button>
      </div>

      {#if previewText}
        <div class="preview" class:confirming={confirmingSend}>
          <div class="preview-head">
            <strong>{confirmingSend ? 'Pesan ini akan dikirim' : 'Pratinjau pesan'}</strong>
            <span class="muted small">{confirmingSend ? `ke ${settings.installed?.deliver} · ` : ''}{previewMeta}</span>
          </div>
          <pre>{previewText}</pre>
          {#if noSnapshot}
            <p class="warn small">VPS belum punya data dari Cockpit, jadi pesan sore ini hanya berisi peringatan. Klik <strong>Sinkron sekarang</strong> (VPN aktif), lalu muat ulang pratinjau.</p>
          {/if}
          {#if confirmingSend}
            <div class="confirm-row">
              <button class="btn btn-sm" onclick={() => (confirmingSend = false)}>Batal</button>
              <button class="btn btn-primary btn-sm" onclick={sendNow} disabled={Boolean(busy)}><Icon name="send" size={13} /> Ya, kirim pesan ini</button>
            </div>
          {:else}
            <p class="muted small">Pesan terjadwal ({settings.installed ? describeSchedule({ days: settings.installed.days, times: settings.installed.times }) : 'belum dipasang'}) dibuat dengan cara yang sama, dari data terakhir saat itu.</p>
          {/if}
        </div>
      {/if}
      {#if statusText}
        <pre class="status">{statusText}</pre>
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .how {
    line-height: 1.5;
    margin: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: 2fr 1fr 0.6fr;
    gap: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
  }
  .small {
    font-size: 12px;
  }
  .state {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .state > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12.5px;
    min-width: 0;
    word-break: break-word;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .grow {
    flex: 1;
  }
  .err {
    color: var(--err);
    margin: 0;
  }
  .warn {
    color: var(--warn);
  }
  pre {
    margin: 0;
    padding: 10px 12px;
    max-height: 340px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .preview {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .preview.confirming {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .preview-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
  }
  .preview p {
    margin: 0;
  }
  .confirm-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  @media (max-width: 720px) {
    .grid,
    .state {
      grid-template-columns: 1fr;
    }
  }
  .schedule {
    display: grid;
    grid-template-columns: 1fr 1.1fr;
    gap: 14px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .sched-summary {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sched-text {
    font-size: 16px;
  }
  .next {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12.5px;
  }
  .next-item {
    color: var(--muted, var(--text-2));
  }
  .next-item.first {
    color: var(--text);
    font-weight: 600;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    align-self: flex-start;
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11.5px;
    line-height: 1.4;
  }
  .ok-badge {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .warn-badge {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .sched-edit {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .days,
  .times {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .day {
    min-width: 40px;
    padding: 4px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .day.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .time-item {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .input.time {
    width: 112px;
  }
  .x-btn {
    display: inline-grid;
    place-items: center;
    border: none;
    background: none;
    color: var(--muted, var(--text-2));
    cursor: pointer;
  }
  .btn-xs {
    padding: 2px 8px;
    font-size: 11.5px;
  }
  .sched-note {
    grid-column: 1 / -1;
    margin: 0;
  }
  @media (max-width: 720px) {
    .schedule {
      grid-template-columns: 1fr;
    }
  }
</style>
