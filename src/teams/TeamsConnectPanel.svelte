<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { teams } from '../lib/teams/client';
  import type { TeamsStatus, TeamsDeviceCodeAuth } from '../lib/teams/types';

  let {
    status,
    onconnected,
  }: {
    status: TeamsStatus | null;
    onconnected: () => void;
  } = $props();

  let loading = $state(false);
  let tenantId = $state('');
  let clientId = $state('');
  let authData = $state<TeamsDeviceCodeAuth | null>(null);
  let pollInterval: any = null;
  let copied = $state(false);

  $effect(() => {
    if (status?.deviceCodeAuth) {
      authData = status.deviceCodeAuth;
      startPolling();
    }
  });

  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      try {
        const s = await teams.status();
        if (s.connected) {
          clearInterval(pollInterval);
          pollInterval = null;
          authData = null;
          toasts.show('Berhasil terhubung ke Microsoft Teams!', 'ok');
          onconnected();
        } else if (!s.deviceCodeAuth && authData) {
          // expired or canceled
          clearInterval(pollInterval);
          pollInterval = null;
          authData = null;
        }
      } catch {
        // ignore polling blip
      }
    }, 4000);
  }

  async function handleStartLogin() {
    loading = true;
    try {
      const res = await teams.login(tenantId.trim() || undefined, clientId.trim() || undefined);
      authData = res;
      startPolling();
      toasts.show('Kode login didapatkan. Silakan buka browser.', 'info');
    } catch (e: any) {
      toasts.show(`Gagal memulai login: ${e.message}`, 'err');
    } finally {
      loading = false;
    }
  }

  async function handleCancel() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    authData = null;
    try {
      await teams.cancelLogin();
    } catch {
      // ignore
    }
  }

  async function copyCode() {
    if (!authData?.userCode) return;
    try {
      await navigator.clipboard.writeText(authData.userCode);
      copied = true;
      toasts.show('Kode disalin ke clipboard!', 'ok');
      setTimeout(() => (copied = false), 2500);
    } catch {
      // ignore
    }
  }
</script>

<div class="panel">
  <div class="card">
    <div class="header">
      <div class="icon-wrap">
        <Icon name="teams" size={32} />
      </div>
      <h2>Hubungkan Microsoft Teams</h2>
      <p class="muted">
        Masuk dengan akun Microsoft kantor untuk memantau chat developer, menangkap link MR otomatis, dan membalas pesan langsung dari Cockpit.
      </p>
    </div>

    {#if !authData}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          handleStartLogin();
        }}
      >
        <div class="field">
          <label for="tenantId">Tenant ID (Opsional)</label>
          <input
            id="tenantId"
            type="text"
            placeholder="organizations (default akun kerja)"
            bind:value={tenantId}
            disabled={loading}
          />
          <small class="muted">Biarkan kosong bila memakai akun kantor standar.</small>
        </div>

        <div class="field">
          <label for="clientId">Client ID Azure (Opsional)</label>
          <input
            id="clientId"
            type="text"
            placeholder="1fec8e78-bce4-4aaf-ab1b-5451cc387264 (default Microsoft Teams)"
            bind:value={clientId}
            disabled={loading}
          />
          <small class="muted">Default menggunakan client resmi Microsoft Teams yang terotorisasi di semua tenant Microsoft.</small>
        </div>

        {#if status?.error}
          <div class="alert"><Icon name="alert" size={16} /> {status.error}</div>
        {/if}

        <button type="submit" class="btn btn-primary" disabled={loading}>
          {#if loading}
            <Icon name="refresh" size={16} /> Meminta kode login…
          {:else}
            <Icon name="plug" size={16} /> Mulai Login Microsoft Teams
          {/if}
        </button>
      </form>
    {:else}
      <div class="device-auth">
        <div class="step-badge">Langkah 1 dari 2</div>
        <p>Salin kode verifikasi di bawah ini:</p>

        <div class="code-box">
          <span class="code-text">{authData.userCode}</span>
          <button class="btn btn-sm" onclick={copyCode}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Tersalin' : 'Salin'}
          </button>
        </div>

        <div class="step-badge">Langkah 2 dari 2</div>
        <p>
          Buka halaman login Microsoft berikut di browsermu, lalu masukkan kode di atas:
        </p>

        <a
          href={authData.verificationUri}
          target="_blank"
          rel="noreferrer"
          class="btn btn-primary auth-link"
        >
          <Icon name="external" size={16} />
          Buka {authData.verificationUri}
        </a>

        <div class="waiting-box">
          <div class="spinner"></div>
          <span>Menunggu persetujuan login di browser…</span>
        </div>

        <div class="actions">
          <button class="btn btn-ghost" onclick={handleCancel}>Batal</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .panel {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
    padding: 24px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    max-width: 520px;
    width: 100%;
    box-shadow: var(--shadow);
  }
  .header {
    text-align: center;
    margin-bottom: 24px;
  }
  .icon-wrap {
    width: 56px;
    height: 56px;
    border-radius: 12px;
    background: var(--surface-2);
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 16px;
    color: var(--accent);
  }
  h2 {
    margin: 0 0 8px;
    font-size: 20px;
  }
  .field {
    margin-bottom: 16px;
  }
  label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 6px;
  }
  input {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text);
    font-size: 13px;
    box-sizing: border-box;
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  small {
    display: block;
    margin-top: 4px;
    font-size: 11px;
  }
  .alert {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--warn-soft);
    color: var(--warn);
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    margin-bottom: 16px;
    font-size: 13px;
  }
  .btn-primary {
    width: 100%;
    justify-content: center;
    padding: 10px 16px;
  }
  .device-auth {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .step-badge {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 2px 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    margin-bottom: 8px;
  }
  .code-box {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--surface-2);
    border: 2px dashed var(--accent);
    border-radius: 8px;
    padding: 12px 20px;
    margin: 8px 0 20px;
  }
  .code-text {
    font-family: var(--font-mono);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--accent);
  }
  .auth-link {
    margin: 8px 0 20px;
    text-decoration: none;
  }
  .waiting-box {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--text-2);
    margin-bottom: 16px;
  }
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .actions {
    margin-top: 8px;
  }
</style>
