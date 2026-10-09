<script lang="ts">
  import Icon from './Icon.svelte';
  import { confirmState } from './confirm.svelte';

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (confirmState.open && !dialog.open) {
      dialog.showModal();
    } else if (!confirmState.open && dialog.open) {
      dialog.close();
    }
  });

  function handleCancel() {
    confirmState.cancel();
  }

  function handleConfirm() {
    confirmState.confirm();
  }
</script>

<dialog
  bind:this={dialog}
  onclose={handleCancel}
  onclick={(e) => {
    if (e.target === dialog) handleCancel();
  }}
  class="confirm-modal"
  aria-labelledby="confirm-title"
>
  {#if confirmState.open}
    <div class="confirm-content">
      <div class="confirm-top">
        <div class="confirm-icon-wrap" class:is-danger={confirmState.danger}>
          <Icon name={confirmState.danger ? 'trash' : 'alert'} size={20} />
        </div>
        <div class="confirm-text">
          <h3 id="confirm-title">{confirmState.title}</h3>
          <p>{confirmState.message}</p>
        </div>
      </div>
      <div class="confirm-actions">
        <button class="btn btn-sm" onclick={handleCancel}>
          {confirmState.cancelText}
        </button>
        <button
          class="btn btn-sm"
          class:btn-danger={confirmState.danger}
          class:btn-primary={!confirmState.danger}
          onclick={handleConfirm}
        >
          {confirmState.confirmText}
        </button>
      </div>
    </div>
  {/if}
</dialog>

<style>
  dialog.confirm-modal {
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
  dialog.confirm-modal::backdrop {
    background: rgb(10 14 22 / 0.5);
    backdrop-filter: blur(2px);
  }
  .confirm-content {
    display: flex;
    flex-direction: column;
    padding: 22px 24px 20px;
  }
  .confirm-top {
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }
  .confirm-icon-wrap {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent);
    flex-shrink: 0;
  }
  .confirm-icon-wrap.is-danger {
    background: var(--err-soft);
    color: var(--err);
  }
  .confirm-text {
    flex: 1;
    min-width: 0;
  }
  .confirm-text h3 {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }
  .confirm-text p {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text-2);
    word-break: break-word;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
    margin-top: 24px;
  }
  .btn-danger {
    background: var(--err);
    color: #fff;
    border: 1px solid var(--err);
  }
  .btn-danger:hover {
    filter: brightness(0.92);
  }
</style>
