<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import type { WaStatus } from '../lib/whatsapp/types';

  let { status, busy, onconnect }: { status: WaStatus | null; busy: boolean; onconnect: () => void } = $props();

  const waiting = $derived(status?.connection === 'connecting' || status?.connection === 'reconnecting');
</script>

<section class="connect">
  <div class="card">
    <div class="head">
      <div class="icon"><Icon name="chat" size={22} /></div>
      <div>
        <h1>Hubungkan WhatsApp</h1>
        <p class="muted">Tautkan sebagai perangkat (seperti WhatsApp Web), lalu balas chat dengan bantuan AI dan template.</p>
      </div>
    </div>

    {#if status?.connection === 'qr' && status.qr}
      <div class="qr-wrap">
        <img src={status.qr} alt="QR code untuk menautkan WhatsApp" width="240" height="240" />
        <ol>
          <li>Buka WhatsApp di HP.</li>
          <li>Ketuk <strong>⋮ / Pengaturan → Perangkat tertaut → Tautkan perangkat</strong>.</li>
          <li>Arahkan kamera ke QR ini. QR diperbarui otomatis.</li>
        </ol>
      </div>
    {:else if waiting}
      <div class="waiting">
        <span class="spinner" aria-hidden="true"></span>
        {status?.connection === 'reconnecting' ? 'Menyambung ulang…' : status?.hasSession ? 'Memulihkan sesi…' : 'Menyiapkan QR…'}
      </div>
    {:else}
      {#if status?.error}<p class="alert"><Icon name="alert" /> {status.error}</p>{/if}
      <button class="btn btn-primary" onclick={onconnect} disabled={busy}>
        <Icon name="chat" /> {status?.hasSession ? 'Sambungkan kembali' : 'Tampilkan QR'}
      </button>
    {/if}

    <div class="notes">
      <p><Icon name="shield" size={14} /> <strong>Yang perlu diketahui</strong></p>
      <ul>
        <li>Ini koneksi tidak resmi (protokol WhatsApp Web). WhatsApp bisa membatasi nomor yang terlihat seperti bot, jadi aplikasi <strong>tidak pernah mengirim otomatis</strong>: setiap pesan kamu kirim sendiri, dan pengiriman dibatasi lajunya.</li>
        <li>Sesi tertaut disimpan lokal di <code>~/.tech-lead-cockpit/whatsapp-auth</code>. Isi chat hanya ada di memori selama aplikasi berjalan.</li>
        <li>Untuk draft AI, pesan terakhir chat yang kamu pilih dikirim ke Claude CLI.</li>
        <li>Membuka chat di sini tidak mengirim tanda "dibaca" ke lawan bicara.</li>
      </ul>
    </div>
  </div>
</section>

<style>
  .connect {
    height: 100%;
    overflow: auto;
    display: grid;
    place-items: center;
    padding: 24px 16px;
  }
  .card {
    width: min(620px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .head {
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: var(--ok-soft);
    color: var(--ok);
    flex-shrink: 0;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 19px;
  }
  .head p {
    margin: 0;
  }
  .qr-wrap {
    display: flex;
    gap: 20px;
    align-items: center;
    flex-wrap: wrap;
  }
  .qr-wrap img {
    border-radius: 8px;
    border: 1px solid var(--border);
    background: #fff;
    padding: 6px;
  }
  .qr-wrap ol {
    flex: 1;
    min-width: 200px;
    margin: 0;
    padding-left: 18px;
    line-height: 1.8;
    color: var(--text-2);
  }
  .waiting {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-2);
  }
  .spinner {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .btn {
    align-self: flex-start;
  }
  .alert {
    display: flex;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    color: var(--warn);
  }
  .notes {
    border-top: 1px solid var(--border);
    padding-top: 14px;
    font-size: 13px;
    color: var(--text-2);
  }
  .notes p {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
  }
  .notes ul {
    margin: 0;
    padding-left: 18px;
    line-height: 1.7;
  }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
  }
</style>
