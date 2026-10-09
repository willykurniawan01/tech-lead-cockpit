<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let {
    open = $bindable(false),
    title,
    subtitle,
    width = 720,
    height,
    children,
    footer,
    onclose,
  }: {
    open: boolean;
    title: string;
    subtitle?: string;
    width?: number;
    height?: number | string;
    children: Snippet;
    footer?: Snippet;
    onclose?: () => void;
  } = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  function handleClose() {
    open = false;
    onclose?.();
  }

  const heightStyle = $derived(height ? (typeof height === 'number' ? `${height}px` : height) : undefined);
</script>

<dialog
  bind:this={dialog}
  onclose={handleClose}
  onclick={(e) => {
    if (e.target === dialog) handleClose();
  }}
  style="--w: {width}px; {heightStyle ? `--h: ${heightStyle};` : ''}"
  aria-labelledby="modal-title"
>
  {#if open}
    <header>
      <div>
        <h2 id="modal-title">{title}</h2>
        {#if subtitle}<p>{subtitle}</p>{/if}
      </div>
      <button class="btn btn-ghost btn-sm" onclick={() => (open = false)} aria-label="Tutup"><Icon name="x" /></button>
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  {/if}
</dialog>

<style>
  dialog {
    width: min(var(--w), calc(100vw - 32px));
    height: var(--h, auto);
    max-height: calc(100vh - 48px);
    min-height: min(200px, calc(100vh - 64px));
    margin: auto;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  dialog[open] {
    display: flex;
    flex-direction: column;
  }
  dialog::backdrop {
    background: rgb(10 14 22 / 0.45);
    backdrop-filter: blur(2px);
  }
  header {
    flex-shrink: 0;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  header p {
    margin: 2px 0 0;
    color: var(--text-3);
    font-size: 13px;
  }
  .body {
    padding: 18px 20px;
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }
  footer {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
  }
</style>
