<script lang="ts">
  import Icon from './Icon.svelte';
  import { passwordPromptState } from './password-prompt.svelte';

  let dialog: HTMLDialogElement | undefined = $state();
  let password = $state('');
  let reveal = $state(false);

  $effect(() => {
    if (!dialog) return;
    if (passwordPromptState.open && !dialog.open) {
      password = '';
      reveal = false;
      dialog.showModal();
    } else if (!passwordPromptState.open && dialog.open) {
      dialog.close();
    }
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!password) return;
    const value = password;
    password = '';
    passwordPromptState.submit(value);
  }

  function cancel() {
    password = '';
    passwordPromptState.cancel();
  }
</script>

<dialog
  bind:this={dialog}
  onclose={() => {
    if (passwordPromptState.open) cancel();
  }}
  onclick={(e) => {
    if (e.target === dialog) cancel();
  }}
  class="pw-modal"
  aria-labelledby="pw-title"
>
  {#if passwordPromptState.open}
    <form class="pw-content" onsubmit={submit}>
      <div class="pw-top">
        <div class="pw-icon"><Icon name="lock" size={20} /></div>
        <div class="pw-text">
          <h3 id="pw-title">PDF Diproteksi Password</h3>
          <p><span class="mono">{passwordPromptState.fileName}</span> perlu password agar bisa dibaca AI. Cockpit menyimpan salinan tanpa password di folder kerja draft; password-nya sendiri tidak disimpan.</p>
        </div>
      </div>
      <div class="pw-field">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="input"
          type={reveal ? 'text' : 'password'}
          bind:value={password}
          placeholder="Password PDF"
          autocomplete="off"
          autofocus
          aria-invalid={passwordPromptState.invalid}
        />
        <button type="button" class="btn btn-ghost btn-sm" onclick={() => (reveal = !reveal)} aria-pressed={reveal} aria-label="Tampilkan password" title={reveal ? 'Sembunyikan password' : 'Tampilkan password'}>
          <Icon name="eye" size={14} />
        </button>
      </div>
      {#if passwordPromptState.invalid}
        <p class="err small">Password salah. Coba lagi.</p>
      {/if}
      <div class="pw-actions">
        <button type="button" class="btn btn-sm" onclick={cancel}>Lewati file ini</button>
        <button type="submit" class="btn btn-sm btn-primary" disabled={!password}>Buka PDF</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  dialog.pw-modal {
    width: min(460px, calc(100vw - 32px));
    margin: auto;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  dialog.pw-modal::backdrop {
    background: rgb(10 14 22 / 0.5);
    backdrop-filter: blur(2px);
  }
  .pw-content {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 22px 24px 20px;
  }
  .pw-top {
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }
  .pw-icon {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent);
    flex-shrink: 0;
  }
  .pw-text {
    flex: 1;
    min-width: 0;
  }
  .pw-text h3 {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 600;
  }
  .pw-text p {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text-2);
    word-break: break-word;
  }
  .pw-field {
    display: flex;
    gap: 6px;
  }
  .pw-field .input {
    flex: 1;
  }
  .pw-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 6px;
  }
  .err {
    margin: -6px 0 0;
    font-size: 12.5px;
    color: var(--err);
  }
</style>
