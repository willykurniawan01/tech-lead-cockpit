<script lang="ts">
  import Icon from './Icon.svelte';
  import { toasts } from './toast.svelte';
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts.items as t (t.id)}
    <div class="toast toast-{t.kind}">
      <Icon name={t.kind === 'ok' ? 'check' : t.kind === 'err' ? 'error' : 'sparkles'} />
      <span>{t.message}</span>
      {#if t.action}<a class="btn btn-sm" href={t.action.href} onclick={() => toasts.dismiss(t.id)}>{t.action.label}</a>{/if}
      <button class="btn btn-ghost btn-sm" onclick={() => toasts.dismiss(t.id)} aria-label="Tutup"><Icon name="x" size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 100;
    max-width: min(420px, calc(100vw - 32px));
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 12px;
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
  }
  .toast span {
    flex: 1;
  }
  .toast-ok :global(svg:first-child) {
    color: var(--ok);
  }
  .toast-err :global(svg:first-child) {
    color: var(--err);
  }
  .toast-info :global(svg:first-child) {
    color: var(--accent);
  }
</style>
