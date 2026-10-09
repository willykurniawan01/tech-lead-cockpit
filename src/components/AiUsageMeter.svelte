<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { aiUsage } from '../lib/ai/usage.svelte';
  import type { AiProviderId } from '../lib/ai/types';

  let { provider, compact = false }: { provider: AiProviderId; compact?: boolean } = $props();

  onMount(() => {
    aiUsage.load();
  });

  const usage = $derived(aiUsage.get(provider));

  function level(pct: number): 'ok' | 'warn' | 'err' {
    return pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'ok';
  }

  /** ISO timestamps (Antigravity) become local time; Claude already sends readable text. */
  function resetText(r?: string): string {
    if (!r) return '';
    const t = Date.parse(r);
    if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(r)) return r;
    return new Date(t).toLocaleString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  const isCredit = $derived(provider === 'inferhub' || Boolean(usage?.balance));
  const isGateway = $derived(provider === '9router' || Boolean(usage?.gateway));

  const refreshTitle = $derived(isCredit ? 'Perbarui saldo' : isGateway ? 'Perbarui status' : 'Perbarui limit');
  const loadingText = $derived(isCredit ? 'Membaca saldo…' : isGateway ? 'Mengecek gateway…' : 'Membaca limit…');
  const emptyText = $derived(isCredit ? 'Saldo belum terbaca.' : isGateway ? 'Gateway belum terhubung.' : 'Limit belum terbaca.');
</script>

<div class="usage" class:compact>
  {#if usage?.balance}
    <div class="credit-row" title={usage.balance.email ? `Akun: ${usage.balance.email}` : undefined}>
      <span class="label">Saldo:</span>
      <strong class="credit-amount">{usage.balance.amount} {usage.balance.currency ?? 'USDC'}</strong>
      {#if !compact && usage.balance.email}
        <span class="muted credit-email">({usage.balance.email})</span>
      {/if}
    </div>
  {:else if usage?.gateway}
    <div class="gateway-row" title={usage.gateway.endpoint}>
      <span class="label">Gateway:</span>
      <strong class="gateway-status">{usage.gateway.activeModels !== undefined ? `${usage.gateway.activeModels} model aktif` : usage.gateway.status || 'Terhubung'}</strong>
      {#if !compact && usage.gateway.endpoint}
        <span class="muted gateway-endpoint">({usage.gateway.endpoint})</span>
      {/if}
    </div>
  {:else if usage?.windows.length}
    {#each usage.windows as w (w.label)}
      <div class="win" title={w.resets ? `Reset ${resetText(w.resets)}` : undefined}>
        <span class="label">{w.label}</span>
        <span class="bar"><span class="fill {level(w.usedPercent)}" style:width="{Math.min(100, w.usedPercent)}%"></span></span>
        <span class="pct {level(w.usedPercent)}">{w.usedPercent}%</span>
        {#if !compact && w.resets}<span class="reset muted">reset {resetText(w.resets)}</span>{/if}
      </div>
    {/each}
  {:else if usage?.error}
    <p class="muted err-text">{usage.error}</p>
  {:else}
    <p class="muted">{aiUsage.loading ? loadingText : emptyText}</p>
  {/if}
  <button class="refresh btn btn-ghost btn-sm" onclick={() => aiUsage.load(true)} disabled={aiUsage.loading} title={refreshTitle}>
    <Icon name="refresh" size={12} />{#if !compact} Perbarui{/if}
  </button>
</div>

<style>
  .credit-row,
  .gateway-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 20px;
    font-size: 12px;
  }
  .credit-amount {
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .gateway-status {
    color: var(--accent);
  }
  .credit-email,
  .gateway-endpoint {
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .usage {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }
  .usage.compact {
    padding-right: 28px;
  }
  .win {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 90px 36px;
    align-items: center;
    gap: 8px;
  }
  .usage:not(.compact) .win {
    grid-template-columns: minmax(0, 1fr) 140px 40px minmax(0, 1fr);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-2);
  }
  .bar {
    height: 6px;
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
  }
  .fill.ok {
    background: var(--accent);
  }
  .fill.warn {
    background: var(--warn);
  }
  .fill.err {
    background: var(--err);
  }
  .pct {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .pct.ok {
    color: var(--accent);
  }
  .pct.warn {
    color: var(--warn);
  }
  .pct.err {
    color: var(--err);
  }
  .reset {
    font-size: 11.5px;
  }
  p {
    margin: 0;
  }
  .err-text {
    color: var(--warn);
  }
  .refresh {
    align-self: flex-start;
  }
  .compact .refresh {
    position: absolute;
    top: -2px;
    right: 0;
    padding: 0 4px;
  }
</style>
