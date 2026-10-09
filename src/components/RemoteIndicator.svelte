<script lang="ts">
  import Icon from './Icon.svelte';
  import RemoteAccessModal from './RemoteAccessModal.svelte';
  import { remainingLabel } from '../lib/remote/client';
  import { remoteStatus } from '../lib/remote/remote-status.svelte';

  /** Topbar pill: "Remote aktif · sisa … · N perangkat" while on; opens the Remote settings. */
  let open = $state(false);
  const s = $derived(remoteStatus.status);
  const connected = $derived(s?.devices.filter((d) => d.connected).length ?? 0);

  $effect(() => remoteStatus.watch());
  $effect(() => {
    const t = setInterval(() => (remoteStatus.now = Date.now()), 30_000);
    return () => clearInterval(t);
  });
</script>

<button class="remote-btn pill" class:on={s?.active} onclick={() => (open = true)} title={s?.active ? `Remote aktif sampai ${new Date(s.expiresAt ?? '').toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : 'Remote Cockpit nonaktif'}>
  {#if s?.active}
    <span class="dot" aria-hidden="true"></span>
    <span class="label long">Remote aktif · sisa {remainingLabel(remoteStatus.remainingMs)} · {connected} perangkat</span>
    <span class="label short">Remote · {remainingLabel(remoteStatus.remainingMs)} · {connected}</span>
  {:else}
    <Icon name="link" size={15} />
    <span class="label">Remote</span>
  {/if}
</button>

<RemoteAccessModal bind:open />

<style>
  .remote-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    padding: 0 16px;
    border: none;
    color: var(--text-2);
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    background: var(--surface);
    border-radius: 999px;
    box-shadow: var(--shadow-sm);
  }
  .remote-btn:hover {
    color: var(--text);
  }
  .remote-btn.on {
    color: var(--ok);
    background: var(--ok-soft);
  }
  .short {
    display: none;
  }
  @media (max-width: 1400px) {
    .long {
      display: none;
    }
    .short {
      display: inline;
    }
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent);
  }
</style>
