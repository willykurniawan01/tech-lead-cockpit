<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import type { Issue, ValidationResult } from '../lib/tad/validator';

  let {
    result,
    open = $bindable(false),
    onjump,
  }: {
    result: ValidationResult;
    open: boolean;
    onjump: (issue: Issue) => void;
  } = $props();
</script>

<section class="issues" class:open>
  <button class="head" onclick={() => (open = !open)} aria-expanded={open}>
    <span class="title">Validasi</span>
    {#if result.errorCount}
      <span class="chip chip-err"><Icon name="error" size={12} /> {result.errorCount} error</span>
    {/if}
    {#if result.warningCount}
      <span class="chip chip-warn"><Icon name="alert" size={12} /> {result.warningCount} peringatan</span>
    {/if}
    {#if !result.errorCount && !result.warningCount}
      <span class="chip chip-ok"><Icon name="check" size={12} /> Lengkap</span>
    {/if}
    <span class="spacer"></span>
    <span class="toggle" style:transform={open ? 'rotate(180deg)' : undefined}><Icon name="chevron" /></span>
  </button>

  {#if open}
    <ul>
      {#each result.issues as issue, i (i)}
        <li>
          <button onclick={() => onjump(issue)}>
            <span class="sev sev-{issue.severity}">
              <Icon name={issue.severity === 'error' ? 'error' : 'alert'} size={14} />
            </span>
            <span class="msg">{issue.message}</span>
            <span class="line mono">L{issue.line}</span>
          </button>
        </li>
      {:else}
        <li class="empty muted">Semua section wajib ada, tidak ada placeholder, dan diagram valid.</li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .issues {
    border-top: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 38px;
    padding: 0 14px;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .title {
    font-weight: 600;
    font-size: 13px;
  }
  .spacer {
    flex: 1;
  }
  .toggle {
    display: inline-flex;
    color: var(--text-3);
    transition: transform 0.15s;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 8px 8px;
    max-height: 220px;
    overflow: auto;
  }
  li button {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
    cursor: pointer;
    font-size: 13px;
  }
  li button:hover {
    background: var(--surface-hover);
  }
  .sev {
    display: inline-flex;
    padding-top: 2px;
  }
  .sev-error {
    color: var(--err);
  }
  .sev-warning {
    color: var(--warn);
  }
  .msg {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .line {
    color: var(--text-3);
    font-size: 12px;
  }
  .empty {
    padding: 8px;
    font-size: 13px;
  }
</style>
