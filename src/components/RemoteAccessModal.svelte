<script lang="ts">
  import QRCode from 'qrcode';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  import { confirmDialog } from './confirm.svelte';
  import { toasts } from './toast.svelte';
  import { security } from '../lib/auth/security.svelte';
  import { remote, remainingLabel, untilIso } from '../lib/remote/client';
  import { remoteStatus } from '../lib/remote/remote-status.svelte';
  import type { RemoteDuration, RemotePairing, RemoteSettings } from '../lib/remote/types';
  import { estimate } from '../lib/estimate/client';
  import type { EstimateProject } from '../lib/estimate/types';
  import { wa } from '../lib/whatsapp/client';
  import type { WaChat } from '../lib/whatsapp/types';

  /** Remote Access settings: turn on (PIN/Touch ID + duration), pair phones, revoke, report targets. */
  let { open = $bindable(false) }: { open: boolean } = $props();

  const status = $derived(remoteStatus.status);
  let durationKind = $state<'2h' | '8h' | 'until'>('2h');
  let untilTime = $state('18:00');
  let pin = $state('');
  let busy = $state(false);
  let error = $state('');
  let pairing = $state<RemotePairing | null>(null);
  let qr = $state('');
  let settings = $state<RemoteSettings>({ reportTargets: {} });
  let projects = $state<EstimateProject[]>([]);
  let groups = $state<WaChat[]>([]);
  let waNote = $state('');

  $effect(() => {
    if (!open) return;
    const stop = remoteStatus.watch();
    error = '';
    pin = '';
    void loadTargets();
    return stop;
  });

  // Pairing code countdown; it disappears when it expires or Remote goes off.
  $effect(() => {
    if (!pairing) return;
    const t = setInterval(() => {
      remoteStatus.now = Date.now();
      if (!pairing || Date.parse(pairing.expiresAt) <= Date.now() || !remoteStatus.status?.active) pairing = null;
    }, 1000);
    return () => clearInterval(t);
  });

  async function loadTargets() {
    try {
      [settings, projects] = await Promise.all([remote.settings(), estimate.projects()]);
    } catch (e) {
      error = (e as Error).message;
    }
    try {
      const s = await wa.status();
      if (s.connection === 'open') {
        groups = (await wa.chats()).filter((c) => c.isGroup);
        waNote = groups.length ? '' : 'Belum ada grup WhatsApp yang terlihat.';
      } else waNote = 'WhatsApp belum terhubung; hubungkan di menu WhatsApp untuk memilih grup.';
    } catch {
      waNote = 'Status WhatsApp tidak terbaca.';
    }
  }

  function duration(): RemoteDuration | null {
    if (durationKind !== 'until') return { kind: durationKind };
    const until = untilIso(untilTime);
    return until ? { kind: 'until', until } : null;
  }

  /** Remote opens a door to the laptop: confirm it is the owner, every time. */
  async function reauth(useTouchId: boolean): Promise<boolean> {
    if (security.isLockedOut()) {
      error = `Terlalu banyak percobaan. Coba lagi dalam ${security.lockoutSecondsRemaining()} detik.`;
      return false;
    }
    const ok = useTouchId ? await security.verifyBiometrics() : await security.verifyPin(pin);
    pin = '';
    if (!ok) error = useTouchId ? 'Touch ID gagal atau dibatalkan.' : 'PIN salah.';
    return ok;
  }

  async function enable(useTouchId: boolean) {
    error = '';
    const d = duration();
    if (!d) {
      error = 'Isi jam selesai (HH:MM).';
      return;
    }
    if (!useTouchId && !pin) {
      error = 'Masukkan PIN Cockpit.';
      return;
    }
    busy = true;
    try {
      if (!(await reauth(useTouchId))) return;
      remoteStatus.apply(await remote.enable(d));
      toasts.show('Remote Cockpit aktif.', 'ok');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function disable() {
    busy = true;
    try {
      remoteStatus.apply(await remote.disable());
      pairing = null;
      toasts.show('Remote Cockpit dimatikan. Listener ditutup dan semua sesi dicabut.', 'ok');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function startPairing() {
    error = '';
    try {
      pairing = await remote.pair();
      qr = await QRCode.toDataURL(pairing.url, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function revoke(id: string, name: string) {
    const ok = await confirmDialog({ title: 'Cabut perangkat', message: `Cabut "${name}"? Sesinya langsung berhenti dan perangkat harus dipasangkan ulang.`, confirmText: 'Cabut', danger: true });
    if (!ok) return;
    try {
      remoteStatus.apply(await remote.revoke(id));
      toasts.show(`${name} dicabut.`, 'ok');
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function setTarget(projectId: string, jid: string) {
    const next = { ...settings.reportTargets };
    if (jid) next[projectId] = { jid, name: groups.find((g) => g.jid === jid)?.name ?? settings.reportTargets[projectId]?.name ?? jid };
    else delete next[projectId];
    try {
      settings = await remote.saveSettings({ reportTargets: next });
    } catch (e) {
      error = (e as Error).message;
    }
  }

  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
  const STOP: Record<string, string> = { expired: 'durasi habis', desktop: 'dimatikan dari laptop', phone: 'dimatikan dari HP', 'too-many-failures': 'terlalu banyak percobaan gagal', 'connector-restart': 'connector dimulai ulang', 'connector-stop': 'connector berhenti' };
</script>

<Modal bind:open title="Remote Cockpit" subtitle="Pantau dan kendalikan Cockpit dari HP lewat Tailscale" width={640}>
  <div class="remote">
    {#if error}<p class="err small" role="alert">{error}</p>{/if}

    {#if status?.active}
      <section class="box on">
        <div class="row">
          <span class="dot" aria-hidden="true"></span>
          <strong>Aktif · sisa {remainingLabel(remoteStatus.remainingMs)}</strong>
          <span class="muted small">sampai {fmt(status.expiresAt)}</span>
          <button class="btn btn-sm danger-btn" onclick={disable} disabled={busy}><Icon name="stop" size={14} /> Matikan</button>
        </div>
        <div class="muted small">Alamat: <code>{status.baseUrl}/m/</code> (hanya dari tailnet Anda)</div>
        {#if !status.https}
          <p class="warn small">HTTPS belum tersedia: {status.httpsIssue} Halaman tetap bisa dibuka lewat HTTP di dalam tailnet, tetapi "Add to Home Screen" sebagai PWA butuh HTTPS.</p>
        {/if}
      </section>

      <section>
        <h4>Pasangkan perangkat</h4>
        {#if pairing}
          <div class="pairing">
            {#if qr}<img src={qr} alt="QR pairing" width="220" height="220" />{/if}
            <div>
              <div class="code mono">{pairing.code}</div>
              <p class="muted small">Pindai QR dengan kamera HP (Tailscale di HP harus tersambung), atau buka <code>{status.baseUrl}/m/</code> lalu ketik kodenya. Berlaku {Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - remoteStatus.now) / 1000))} detik, sekali pakai.</p>
            </div>
          </div>
        {:else}
          <button class="btn btn-sm" onclick={startPairing}><Icon name="plus" size={14} /> Buat kode pairing</button>
        {/if}
      </section>
    {:else}
      <section class="box">
        <p class="small">Remote <strong>nonaktif</strong>: tidak ada listener selain 127.0.0.1. Saat diaktifkan, Cockpit membuka listener kedua khusus di alamat Tailscale Mac ini, hanya untuk halaman mobile dan API terbatas (tanpa push code, publish, transisi Jira, atau token).</p>
        {#if status?.lastStop}<p class="muted small">Terakhir mati {fmt(status.lastStop.at)} ({STOP[status.lastStop.reason] ?? status.lastStop.reason}).</p>{/if}
        <fieldset class="durations">
          <legend class="small">Durasi</legend>
          <label><input type="radio" bind:group={durationKind} value="2h" /> 2 jam</label>
          <label><input type="radio" bind:group={durationKind} value="8h" /> 8 jam</label>
          <label><input type="radio" bind:group={durationKind} value="until" /> Sampai jam <input class="input time" type="time" bind:value={untilTime} disabled={durationKind !== 'until'} /></label>
        </fieldset>
        <form
          class="auth"
          onsubmit={(e) => {
            e.preventDefault();
            void enable(false);
          }}
        >
          <input class="input pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="PIN Cockpit" bind:value={pin} aria-label="PIN Cockpit" />
          <button class="btn btn-primary btn-sm" type="submit" disabled={busy}><Icon name="lock" size={14} /> Aktifkan dengan PIN</button>
          {#if security.biometricsEnabled}
            <button class="btn btn-sm" type="button" onclick={() => enable(true)} disabled={busy}><Icon name="fingerprint" size={14} /> Touch ID</button>
          {/if}
        </form>
        <p class="muted small">Mati otomatis saat durasi habis atau Cockpit ditutup/restart. Butuh Tailscale aktif di Mac dan HP.</p>
      </section>
    {/if}

    <section>
      <h4>Perangkat terpasang</h4>
      {#if status?.devices.length}
        <ul class="devices">
          {#each status.devices as d (d.id)}
            <li>
              <span class="dot" class:off={!d.connected} aria-hidden="true"></span>
              <span class="grow"><strong>{d.name}</strong> <span class="muted small">· dipasangkan {fmt(d.pairedAt)}{d.lastSeenAt ? ` · terakhir ${fmt(d.lastSeenAt)}` : ''}</span></span>
              <button class="btn btn-ghost btn-sm" onclick={() => revoke(d.id, d.name)}><Icon name="trash" size={14} /> Cabut</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted small">Belum ada perangkat.</p>
      {/if}
    </section>

    <section>
      <h4>Tujuan Progress Report dari HP</h4>
      <p class="muted small">HP hanya bisa mengirim draft laporan proyek ke grup yang dipilih di sini.</p>
      {#if waNote}<p class="warn small">{waNote}</p>{/if}
      {#if projects.length}
        <div class="targets">
          {#each projects as p (p.id)}
            <label>
              <span>{p.name}</span>
              <select class="input" value={settings.reportTargets[p.id]?.jid ?? ''} onchange={(e) => setTarget(p.id, (e.currentTarget as HTMLSelectElement).value)}>
                <option value="">— Tidak dikirim —</option>
                {#if settings.reportTargets[p.id] && !groups.some((g) => g.jid === settings.reportTargets[p.id].jid)}
                  <option value={settings.reportTargets[p.id].jid}>{settings.reportTargets[p.id].name}</option>
                {/if}
                {#each groups as g (g.jid)}<option value={g.jid}>{g.name}</option>{/each}
              </select>
            </label>
          {/each}
        </div>
      {:else}
        <p class="muted small">Belum ada proyek.</p>
      {/if}
    </section>
  </div>
</Modal>

<style>
  .remote {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  section h4 {
    margin: 0 0 8px;
    font-size: 14px;
  }
  .box {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .box.on {
    border-color: color-mix(in srgb, var(--ok) 50%, var(--border));
    background: var(--ok-soft);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .row .btn {
    margin-left: auto;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--ok);
    flex: none;
  }
  .dot.off {
    background: var(--border-strong);
  }
  .danger-btn {
    color: var(--err);
  }
  .durations {
    border: none;
    padding: 0;
    margin: 0;
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    align-items: center;
  }
  .durations legend {
    font-weight: 600;
    margin-bottom: 6px;
  }
  .durations label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
  }
  .time {
    width: auto;
    padding: 4px 8px;
  }
  .auth {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .pin {
    width: 140px;
  }
  .pairing {
    display: flex;
    gap: 16px;
    align-items: center;
  }
  .pairing img {
    border-radius: 10px;
    background: #fff;
    padding: 6px;
  }
  .code {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 0.12em;
  }
  .devices {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .devices li {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .targets {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .targets label {
    display: grid;
    grid-template-columns: 1fr 1.2fr;
    gap: 10px;
    align-items: center;
    font-size: 14px;
  }
  .warn {
    color: var(--warn);
  }
  .err {
    color: var(--err);
  }
</style>
