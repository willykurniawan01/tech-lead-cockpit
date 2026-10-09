<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { confirmDialog } from './confirm.svelte';
  import { PIN_MAX, PIN_MIN, security } from '../lib/auth/security.svelte';

  let pin = $state('');
  let confirmPin = $state('');
  let enableTouchId = $state(true);
  let errorMsg = $state('');
  let isShaking = $state(false);
  let isVerifying = $state(false);
  let showPin = $state(false);
  let isResetting = $state(false);

  let secondsRemaining = $state(0);
  let cooldownInterval: any = null;

  function triggerShake() {
    isShaking = true;
    setTimeout(() => {
      isShaking = false;
    }, 500);
  }

  function updateCooldown() {
    secondsRemaining = security.lockoutSecondsRemaining();
    if (secondsRemaining <= 0 && cooldownInterval) {
      clearInterval(cooldownInterval);
      cooldownInterval = null;
    }
  }

  async function handleTouchId() {
    if (!security.biometricsEnabled || security.isLockedOut() || isVerifying) return;
    isVerifying = true;
    errorMsg = '';
    try {
      const ok = await security.verifyBiometrics();
      if (!ok) {
        errorMsg = 'Touch ID tidak cocok atau dibatalkan. Silakan gunakan PIN.';
      }
    } catch {
      errorMsg = 'Gagal memverifikasi Touch ID. Gunakan PIN.';
    } finally {
      isVerifying = false;
    }
  }

  async function handlePinSubmit() {
    if (security.isLockedOut()) {
      errorMsg = `Terlalu banyak percobaan salah. Tunggu ${secondsRemaining} detik.`;
      triggerShake();
      return;
    }

    if (!pin) {
      errorMsg = 'Masukkan PIN Anda.';
      triggerShake();
      return;
    }

    if (!security.isConfigured) {
      // Setup mode
      if (pin.length < 4) {
        errorMsg = 'PIN minimal 4 digit.';
        triggerShake();
        return;
      }
      if (pin !== confirmPin) {
        errorMsg = 'Konfirmasi PIN tidak cocok.';
        triggerShake();
        return;
      }

      isVerifying = true;
      errorMsg = '';
      const res = await security.setupPin(pin, enableTouchId);
      isVerifying = false;
      if (!res.success) {
        errorMsg = res.error || 'Gagal menyimpan PIN.';
        triggerShake();
      }
      return;
    }

    // Unlock mode
    if (isVerifying) return;
    isVerifying = true;
    errorMsg = '';
    const ok = await security.verifyPin(pin);
    isVerifying = false;

    if (!ok) {
      pin = '';
      if (security.isLockedOut()) {
        updateCooldown();
        cooldownInterval = setInterval(updateCooldown, 1000);
        errorMsg = `PIN salah 5 kali. Terkunci selama 30 detik.`;
      } else {
        const remaining = 5 - security.failedAttempts;
        errorMsg = `PIN salah. Sisa ${remaining} percobaan lagi.`;
      }
      triggerShake();
    }
  }

  // Dots match the saved PIN's length; older PINs (length unknown) show at least 6 and grow as typed.
  const dotCount = $derived(security.pinLength || Math.max(6, pin.length));

  function handleKeypadPress(num: string) {
    if (security.isLockedOut() || isVerifying) return;
    if (errorMsg) errorMsg = '';
    if (pin.length < PIN_MAX) {
      pin += num;
      // Submit on the last digit only when the PIN's length is known; otherwise wait for Enter / Buka.
      if (security.pinLength && pin.length === security.pinLength) setTimeout(handlePinSubmit, 60);
    }
  }

  /** Setup fields accept digits only, the same characters the unlock keypad can enter. */
  function digitsOnly(value: string): string {
    return value.replace(/\D/g, '').slice(0, PIN_MAX);
  }

  function handleBackspace() {
    pin = pin.slice(0, -1);
    errorMsg = '';
  }

  function handleClear() {
    pin = '';
    confirmPin = '';
    errorMsg = '';
  }

  async function handleResetConfirm() {
    const ok = await confirmDialog({
      title: 'Reset Keamanan & PIN',
      message: 'Apakah Anda yakin ingin mereset PIN dan keamanan? Semua pengaturan keamanan akan dikosongkan.',
      confirmText: 'Reset Keamanan',
      danger: true,
    });
    if (ok) {
      security.resetAll();
      pin = '';
      confirmPin = '';
      errorMsg = '';
      isResetting = false;
    }
  }

  // Keyboard navigation
  function handleKeyDown(e: KeyboardEvent) {
    // If typing inside an input or textarea (e.g. Setup mode), let the native input handle it completely!
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      if (e.key === 'Enter') {
        e.preventDefault();
        handlePinSubmit();
      }
      return;
    }

    // Only intercept global keystrokes in Unlock mode (where there are no text inputs)
    if (!security.isConfigured) return;

    if (e.target instanceof HTMLButtonElement && e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLButtonElement).blur();
      handlePinSubmit();
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Any printable key, so PINs created earlier with letters can still be typed on the keyboard.
    if (e.key.length === 1 && e.key !== ' ') {
      e.preventDefault();
      handleKeypadPress(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      handleBackspace();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handlePinSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleClear();
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeyDown);

    // Auto-prompt Touch ID on mount if enabled
    if (security.isConfigured && security.biometricsEnabled && !security.isLockedOut()) {
      setTimeout(() => {
        handleTouchId();
      }, 300);
    }

    if (security.isLockedOut()) {
      updateCooldown();
      cooldownInterval = setInterval(updateCooldown, 1000);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (cooldownInterval) clearInterval(cooldownInterval);
    };
  });
</script>

<div class="lock-overlay" role="dialog" aria-modal="true" aria-label="Keamanan Cockpit">
  <div class="lock-backdrop"></div>

  <div class="lock-card" class:shake={isShaking}>
    <!-- Brand / Header Badge -->
    <div class="lock-header">
      <div class="lock-avatar">
        {#if security.isConfigured}
          <Icon name="lock" size={32} />
        {:else}
          <Icon name="shield" size={32} />
        {/if}
      </div>

      <h2>{security.isConfigured ? 'Tech Lead Cockpit' : 'Amankan Cockpit'}</h2>
      <p class="subtitle">
        {#if !security.isConfigured}
          Buat PIN untuk melindungi dokumen TAD, PRD, dan data lokal Anda.
        {:else if security.biometricsEnabled}
          Gunakan Touch ID atau masukkan PIN untuk membuka.
        {:else}
          Masukkan PIN keamanan Anda untuk membuka.
        {/if}
      </p>
    </div>

    <!-- Error message / Lockout warning -->
    {#if errorMsg || security.isLockedOut()}
      <div class="error-banner" role="alert">
        <Icon name="alert" size={16} />
        <span>
          {security.isLockedOut()
            ? `Terkunci sementara (${secondsRemaining} detik)`
            : errorMsg}
        </span>
      </div>
    {/if}

    <!-- Setup Mode: 2-step PIN creation -->
    {#if !security.isConfigured}
      <div class="setup-form">
        <div class="input-group">
          <label for="setup-pin">Buat PIN Baru ({PIN_MIN}–{PIN_MAX} angka)</label>
          <div class="pin-input-wrap">
            <input
              id="setup-pin"
              type={showPin ? 'text' : 'password'}
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength={PIN_MAX}
              placeholder="Contoh: 123456"
              bind:value={() => pin, (v) => (pin = digitsOnly(v))}
              disabled={isVerifying}
              autocomplete="off"
            />
            <button
              type="button"
              class="btn-icon"
              onclick={() => (showPin = !showPin)}
              title={showPin ? 'Sembunyikan PIN' : 'Lihat PIN'}
            >
              <Icon name="eye" size={16} />
            </button>
          </div>
        </div>

        <div class="input-group">
          <label for="confirm-pin">Konfirmasi PIN</label>
          <div class="pin-input-wrap">
            <input
              id="confirm-pin"
              type={showPin ? 'text' : 'password'}
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength={PIN_MAX}
              placeholder="Ulangi PIN di atas"
              bind:value={() => confirmPin, (v) => (confirmPin = digitsOnly(v))}
              disabled={isVerifying}
              autocomplete="off"
            />
          </div>
        </div>

        {#if security.biometricsSupported}
          <label class="toggle-option">
            <input type="checkbox" bind:checked={enableTouchId} />
            <div class="toggle-text">
              <span class="toggle-title">
                <Icon name="fingerprint" size={16} /> Aktifkan Touch ID di Mac ini
              </span>
              <small>Buka cepat dengan sensor sidik jari Touch ID</small>
            </div>
          </label>
        {/if}

        <button
          type="button"
          class="btn-primary"
          onclick={handlePinSubmit}
          disabled={isVerifying || pin.length < 4 || pin !== confirmPin}
        >
          {isVerifying ? 'Menyimpan...' : 'Simpan & Buka Cockpit'}
        </button>
      </div>

    <!-- Unlock Mode: Biometrics + PIN -->
    {:else}
      <!-- Quick Touch ID Button (if enabled) -->
      {#if security.biometricsEnabled && !security.isLockedOut()}
        <button
          type="button"
          class="touchid-btn"
          onclick={handleTouchId}
          disabled={isVerifying}
          title="Klik untuk scan sidik jari Touch ID"
        >
          <div class="touchid-icon">
            <Icon name="fingerprint" size={32} />
          </div>
          <span>Buka dengan Touch ID</span>
        </button>

        <div class="divider">
          <span>atau masukkan PIN</span>
        </div>
      {/if}

      <!-- Dots display for entered PIN -->
      <div class="pin-dots" aria-label="Status PIN">
        {#each Array(dotCount) as _, i}
          <span class="dot" class:filled={i < pin.length}></span>
        {/each}
      </div>

      <!-- Numeric Keypad -->
      <div class="keypad" role="group" aria-label="Tombol angka">
        {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as digit}
          <button
            type="button"
            class="key-btn"
            disabled={security.isLockedOut() || isVerifying}
            onclick={() => handleKeypadPress(digit)}
          >
            {digit}
          </button>
        {/each}

        <!-- Bottom row: Clear, 0, Backspace -->
        <button
          type="button"
          class="key-btn key-action"
          disabled={security.isLockedOut() || isVerifying || pin.length === 0}
          onclick={handleClear}
          title="Hapus semua (Escape)"
        >
          C
        </button>

        <button
          type="button"
          class="key-btn"
          disabled={security.isLockedOut() || isVerifying}
          onclick={() => handleKeypadPress('0')}
        >
          0
        </button>

        <button
          type="button"
          class="key-btn key-action"
          disabled={security.isLockedOut() || isVerifying || pin.length === 0}
          onclick={handleBackspace}
          title="Hapus 1 angka (Backspace)"
        >
          ⌫
        </button>
      </div>

      <!-- Unlock Action Button -->
      <div class="actions">
        <button
          type="button"
          class="btn-primary"
          disabled={security.isLockedOut() || isVerifying || pin.length < 4}
          onclick={handlePinSubmit}
        >
          {isVerifying ? 'Memverifikasi...' : 'Buka'}
        </button>
      </div>

      <!-- Footer Reset Option -->
      <div class="lock-footer">
        <button
          type="button"
          class="link-muted"
          onclick={() => (isResetting = !isResetting)}
        >
          Lupa PIN?
        </button>

        {#if isResetting}
          <div class="reset-prompt">
            <p>Jika lupa PIN, Anda dapat mereset keamanan dan membuat PIN baru.</p>
            <button type="button" class="btn-danger-sm" onclick={handleResetConfirm}>
              Reset PIN & Keamanan
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .lock-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: rgba(15, 17, 23, 0.7);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    animation: fadeIn 0.25s ease-out;
  }

  .lock-backdrop {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(circle at 50% 30%, rgba(99, 102, 241, 0.15) 0%, transparent 70%);
  }

  .lock-card {
    position: relative;
    width: 100%;
    max-width: 380px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 28px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
    padding: 32px 28px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    user-select: none;
    transition: transform 0.15s ease;
  }

  .lock-card.shake {
    animation: shake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
  }

  .lock-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-bottom: 20px;
  }

  .lock-avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: var(--accent-grad);
    color: #fff;
    display: grid;
    place-items: center;
    box-shadow: 0 8px 20px rgba(79, 70, 229, 0.3);
    margin-bottom: 16px;
  }

  h2 {
    font-size: 20px;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 6px;
    letter-spacing: -0.02em;
  }

  .subtitle {
    font-size: 13px;
    color: var(--text-2);
    margin: 0;
    line-height: 1.45;
  }

  .error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: var(--err-soft);
    color: var(--err);
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
    margin-bottom: 18px;
    width: 100%;
    box-sizing: border-box;
    animation: fadeIn 0.2s ease;
  }

  /* Touch ID Button */
  .touchid-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 12px 18px;
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    margin-bottom: 16px;
  }

  .touchid-btn:hover:not(:disabled) {
    background: var(--surface-hover);
    border-color: var(--accent);
    color: var(--accent);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(79, 70, 229, 0.15);
  }

  .touchid-btn:active:not(:disabled) {
    transform: translateY(0);
  }

  .touchid-icon {
    display: grid;
    place-items: center;
    color: var(--accent);
  }

  .divider {
    display: flex;
    align-items: center;
    width: 100%;
    margin-bottom: 20px;
    color: var(--text-3);
    font-size: 12px;
  }

  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .divider span {
    padding: 0 10px;
  }

  /* PIN Dots */
  .pin-dots {
    display: flex;
    gap: 14px;
    justify-content: center;
    margin-bottom: 24px;
  }

  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--border-strong);
    background: transparent;
    transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .dot.filled {
    background: var(--accent);
    border-color: var(--accent);
    transform: scale(1.15);
    box-shadow: 0 0 8px rgba(79, 70, 229, 0.4);
  }

  /* Numeric Keypad */
  .keypad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    width: 100%;
    max-width: 280px;
    margin-bottom: 20px;
  }

  .key-btn {
    height: 56px;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 20px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.1s ease;
    display: grid;
    place-items: center;
    font-family: inherit;
  }

  .key-btn:hover:not(:disabled) {
    background: var(--surface-hover);
    border-color: var(--border-strong);
    transform: scale(1.04);
  }

  .key-btn:active:not(:disabled) {
    background: var(--border);
    transform: scale(0.96);
  }

  .key-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .key-btn.key-action {
    font-size: 15px;
    font-weight: 600;
    background: transparent;
    border-color: transparent;
    color: var(--text-2);
  }

  .key-btn.key-action:hover:not(:disabled) {
    background: var(--surface-2);
    border-color: var(--border);
  }

  .actions {
    width: 100%;
  }

  .btn-primary {
    width: 100%;
    padding: 12px;
    border-radius: 14px;
    border: none;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
    box-shadow: 0 4px 14px rgba(79, 70, 229, 0.35);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Setup Form */
  .setup-form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 16px;
    text-align: left;
  }

  .input-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .input-group label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }

  .pin-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .pin-input-wrap input {
    width: 100%;
    padding: 10px 14px;
    padding-right: 40px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 16px;
    letter-spacing: 0.2em;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s ease;
  }

  .pin-input-wrap input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
  }

  .btn-icon {
    position: absolute;
    right: 8px;
    border: none;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    padding: 6px;
    display: grid;
    place-items: center;
    border-radius: 8px;
  }

  .btn-icon:hover {
    color: var(--text);
  }

  .toggle-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    cursor: pointer;
  }

  .toggle-option input[type='checkbox'] {
    margin-top: 3px;
    accent-color: var(--accent);
  }

  .toggle-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .toggle-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toggle-text small {
    font-size: 11px;
    color: var(--text-3);
  }

  /* Lock Footer */
  .lock-footer {
    margin-top: 18px;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }

  .link-muted {
    border: none;
    background: transparent;
    color: var(--text-3);
    font-size: 12px;
    cursor: pointer;
    text-decoration: underline;
    font-family: inherit;
  }

  .link-muted:hover {
    color: var(--text);
  }

  .reset-prompt {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 10px 14px;
    font-size: 12px;
    color: var(--text-2);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .btn-danger-sm {
    border: none;
    background: var(--err);
    color: #fff;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @keyframes shake {
    10%, 90% { transform: translate3d(-2px, 0, 0); }
    20%, 80% { transform: translate3d(3px, 0, 0); }
    30%, 50%, 70% { transform: translate3d(-5px, 0, 0); }
    40%, 60% { transform: translate3d(5px, 0, 0); }
  }
</style>
