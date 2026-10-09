<script lang="ts">
  import Icon from './Icon.svelte';
  import { security } from '../lib/auth/security.svelte';

  let { open = $bindable(false) }: { open: boolean } = $props();

  let oldPin = $state('');
  let newPin = $state('');
  let confirmNewPin = $state('');
  let statusMsg = $state('');
  let isError = $state(false);
  let isSubmitting = $state(false);

  async function handlePinChange() {
    statusMsg = '';
    isError = false;

    if (!oldPin) {
      isError = true;
      statusMsg = 'Masukkan PIN lama Anda.';
      return;
    }
    if (newPin.length < 4) {
      isError = true;
      statusMsg = 'PIN baru minimal 4 digit.';
      return;
    }
    if (newPin !== confirmNewPin) {
      isError = true;
      statusMsg = 'Konfirmasi PIN baru tidak cocok.';
      return;
    }

    isSubmitting = true;
    const res = await security.changePin(oldPin, newPin);
    isSubmitting = false;

    if (res.success) {
      isError = false;
      statusMsg = 'PIN berhasil diubah!';
      oldPin = '';
      newPin = '';
      confirmNewPin = '';
      setTimeout(() => {
        statusMsg = '';
      }, 3000);
    } else {
      isError = true;
      statusMsg = res.error || 'Gagal mengubah PIN.';
    }
  }

  async function handleToggleBiometrics(checked: boolean) {
    if (checked) {
      const ok = await security.registerBiometrics();
      if (!ok) {
        statusMsg = 'Gagal mengaktifkan Touch ID / dibatalkan.';
        isError = true;
      } else {
        statusMsg = 'Touch ID berhasil diaktifkan!';
        isError = false;
      }
    } else {
      security.disableBiometrics();
      statusMsg = 'Touch ID dinonaktifkan.';
      isError = false;
    }
  }

  function handleAutoLockChange(e: Event) {
    const val = Number((e.target as HTMLSelectElement).value);
    security.setAutoLock(val);
  }

  function handleLockNow() {
    open = false;
    security.lock();
  }
</script>

{#if open}
  <div
    class="modal-backdrop"
    onclick={() => (open = false)}
    onkeydown={(e) => { if (e.key === 'Escape') open = false; }}
    role="presentation"
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="modal-panel" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Pengaturan Keamanan" tabindex="-1">
      <div class="modal-header">
        <div class="modal-title">
          <Icon name="shield" size={20} />
          <h3>Keamanan & Kunci Cockpit</h3>
        </div>
        <button class="btn-close" onclick={() => (open = false)} title="Tutup">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        {#if statusMsg}
          <div class="status-alert" class:is-err={isError}>
            <Icon name={isError ? 'alert' : 'check'} size={16} />
            <span>{statusMsg}</span>
          </div>
        {/if}

        <!-- Quick Lock Action -->
        <div class="card-action">
          <div class="card-info">
            <strong>Kunci Cockpit Sekarang</strong>
            <small>Segera kunci layar saat meninggalkan laptop</small>
          </div>
          <button type="button" class="btn-lock" onclick={handleLockNow}>
            <Icon name="lock" size={15} /> Kunci Sekarang
          </button>
        </div>

        <!-- Biometrics Toggle -->
        {#if security.biometricsSupported}
          <div class="card-action">
            <div class="card-info">
              <strong>Touch ID / Fingerprint</strong>
              <small>Buka cepat menggunakan sidik jari di Mac ini</small>
            </div>
            <label class="switch">
              <input
                type="checkbox"
                checked={security.biometricsEnabled}
                onchange={(e) => handleToggleBiometrics((e.target as HTMLInputElement).checked)}
              />
              <span class="slider"></span>
            </label>
          </div>
        {/if}

        <!-- Auto-Lock Timeout -->
        <div class="card-action">
          <div class="card-info">
            <strong>Kunci Otomatis (Auto-Lock)</strong>
            <small>Waktu sebelum aplikasi otomatis terkunci</small>
          </div>
          <select value={security.autoLockSeconds} onchange={handleAutoLockChange} class="select-autolock">
            <option value={0}>Saat tab ditutup / refresh</option>
            <option value={300}>5 menit tidak aktif</option>
            <option value={900}>15 menit tidak aktif</option>
            <option value={1800}>30 menit tidak aktif</option>
            <option value={-1}>Tidak pernah (Hanya manual)</option>
          </select>
        </div>

        <!-- Change PIN Form -->
        <div class="change-pin-section">
          <h4>Ubah PIN Keamanan</h4>
          <div class="form-grid">
            <div class="field">
              <label for="old-pin">PIN Lama</label>
              <input
                id="old-pin"
                type="password"
                inputmode="numeric"
                maxlength="8"
                bind:value={oldPin}
                placeholder="PIN saat ini"
              />
            </div>
            <div class="field">
              <label for="new-pin">PIN Baru</label>
              <input
                id="new-pin"
                type="password"
                inputmode="numeric"
                maxlength="8"
                bind:value={newPin}
                placeholder="PIN baru (min 4 digit)"
              />
            </div>
            <div class="field">
              <label for="confirm-new-pin">Konfirmasi PIN Baru</label>
              <input
                id="confirm-new-pin"
                type="password"
                inputmode="numeric"
                maxlength="8"
                bind:value={confirmNewPin}
                placeholder="Ulangi PIN baru"
              />
            </div>
          </div>
          <button
            type="button"
            class="btn-save-pin"
            disabled={isSubmitting || !oldPin || !newPin || newPin !== confirmNewPin}
            onclick={handlePinChange}
          >
            {isSubmitting ? 'Menyimpan...' : 'Perbarui PIN'}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9998;
    background: rgba(15, 17, 23, 0.6);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    animation: fadeIn 0.15s ease-out;
  }

  .modal-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    width: 100%;
    max-width: 460px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }

  .modal-title {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--accent);
  }

  .modal-title h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }

  .btn-close {
    border: none;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
    border-radius: 8px;
    display: grid;
    place-items: center;
  }

  .btn-close:hover {
    color: var(--text);
    background: var(--surface-2);
  }

  .modal-body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .status-alert {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 13px;
    background: var(--ok-soft);
    color: var(--ok);
  }

  .status-alert.is-err {
    background: var(--err-soft);
    color: var(--err);
  }

  .card-action {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 14px;
  }

  .card-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .card-info strong {
    font-size: 13px;
    color: var(--text);
  }

  .card-info small {
    font-size: 11px;
    color: var(--text-3);
  }

  .btn-lock {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: 10px;
    border: 1px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s ease;
  }

  .btn-lock:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }

  .select-autolock {
    padding: 6px 10px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
    font-family: inherit;
    outline: none;
    cursor: pointer;
  }

  /* Switch */
  .switch {
    position: relative;
    display: inline-block;
    width: 40px;
    height: 22px;
  }

  .switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background-color: var(--border-strong);
    transition: 0.2s;
    border-radius: 22px;
  }

  .slider:before {
    position: absolute;
    content: '';
    height: 16px;
    width: 16px;
    left: 3px;
    bottom: 3px;
    background-color: white;
    transition: 0.2s;
    border-radius: 50%;
  }

  input:checked + .slider {
    background-color: var(--accent);
  }

  input:checked + .slider:before {
    transform: translateX(18px);
  }

  /* Change PIN */
  .change-pin-section {
    padding-top: 14px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .change-pin-section h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .form-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field label {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-2);
  }

  .field input {
    padding: 8px 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
  }

  .field input:focus {
    border-color: var(--accent);
  }

  .btn-save-pin {
    padding: 9px;
    border-radius: 10px;
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s ease;
  }

  .btn-save-pin:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-save-pin:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
