<script lang="ts">
  import { aiProviders } from '../lib/ai/providers.svelte';
  import type { AiProviderId, AiSelection } from '../lib/ai/types';

  let {
    value,
    onchange,
    disabled = false,
  }: {
    value: AiSelection;
    onchange: (sel: AiSelection) => void;
    disabled?: boolean;
  } = $props();

  $effect(() => {
    aiProviders.load();
  });

  const provider = $derived(aiProviders.get(value.provider));
  const isModelInList = $derived(!provider || provider.models.some((m) => m.id === value.model));
  let isCustom = $state(false);

  $effect(() => {
    if (value.model && !isModelInList) {
      isCustom = true;
    }
  });

  function setProvider(id: AiProviderId) {
    isCustom = false;
    onchange({ provider: id, model: '' });
  }

  function handleModelSelect(m: string) {
    if (m === '__custom__') {
      isCustom = true;
    } else {
      isCustom = false;
      onchange({ ...value, model: m });
    }
  }
</script>

<div class="picker">
  <select class="input" value={value.provider} onchange={(e) => setProvider(e.currentTarget.value as AiProviderId)} {disabled} aria-label="Provider AI">
    {#each aiProviders.list.length ? aiProviders.list : [{ id: 'claude', label: 'Claude CLI', available: true }, { id: 'antigravity', label: 'Antigravity CLI', available: true }, { id: 'inferhub', label: 'InferHub', available: true }, { id: '9router', label: '9Router', available: true }] as p (p.id)}
      <option value={p.id}>{p.label}{p.available ? '' : ' (belum siap)'}</option>
    {/each}
  </select>

  {#if isCustom}
    <div class="custom-wrap">
      <input
        type="text"
        class="input mono"
        placeholder="slug model (e.g. cb/gpt-5.4)"
        value={value.model}
        oninput={(e) => onchange({ ...value, model: e.currentTarget.value.trim() })}
        {disabled}
        aria-label="Custom Model ID"
      />
      <button
        type="button"
        class="custom-cancel"
        onclick={() => {
          isCustom = false;
          onchange({ ...value, model: '' });
        }}
        title="Kembali ke daftar model"
      >
        ✕
      </button>
    </div>
  {:else}
    <select class="input" value={isModelInList ? value.model : ''} onchange={(e) => handleModelSelect(e.currentTarget.value)} disabled={disabled || !provider?.available} aria-label="Model AI">
      {#each provider?.models ?? [{ id: '', label: 'Default' }] as m (m.id)}
        <option value={m.id}>{m.label}</option>
      {/each}
      {#if value.provider === 'inferhub' || value.provider === '9router'}
        <option value="__custom__">+ Model lain (ketik slug)…</option>
      {/if}
    </select>
  {/if}
</div>

{#if provider && !provider.available && provider.note}
  <p class="note">{provider.note}</p>
{:else if provider?.warning}
  <p class="note">{provider.warning}</p>
{/if}

<style>
  .picker {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
    gap: 6px;
  }
  .picker .input {
    min-height: 30px;
    padding: 3px 8px;
    font-size: 12.5px;
  }
  .custom-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .custom-wrap .input {
    width: 100%;
    padding-right: 24px;
    font-family: var(--font-mono);
  }
  .custom-cancel {
    position: absolute;
    right: 4px;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-3);
    padding: 2px 4px;
    border-radius: 4px;
  }
  .custom-cancel:hover {
    color: var(--text-1);
  }
  .note {
    margin: 6px 0 0;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
</style>
