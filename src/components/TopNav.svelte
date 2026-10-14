<script lang="ts">
  import Icon from './Icon.svelte';
  import { GROUPS, type View } from '../lib/nav';

  /** The top bar: one link or one dropdown per group, the current view's group highlighted. */
  let { view }: { view: View } = $props();

  /** The group whose dropdown is open (one at a time). */
  let openGroup = $state<string | null>(null);
  const activeGroup = $derived(GROUPS.find((g) => g.items.some((i) => i.id === view)));

  // Choosing a view (a hash change) closes the dropdown.
  $effect(() => {
    void view;
    openGroup = null;
  });

  // A click elsewhere or Escape closes the dropdown.
  $effect(() => {
    if (!openGroup) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.nav-group')) openGroup = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') openGroup = null;
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  });
</script>

<nav class="tabs" aria-label="Navigasi utama">
  {#each GROUPS as group (group.id)}
    {@const current = group.items.find((i) => i.id === view)}
    {#if group.items.length === 1}
      {@const item = group.items[0]}
      <a href="#/{item.id}" class:active={view === item.id} aria-current={view === item.id ? 'page' : undefined} title={item.label}>
        <span class="tab-icon"><Icon name={item.icon} size={16} /></span>
        <span class="tab-label">{item.label}</span>
      </a>
    {:else}
      <div class="nav-group">
        <button
          class="group-btn"
          class:active={activeGroup?.id === group.id}
          aria-expanded={openGroup === group.id}
          aria-haspopup="true"
          title={group.items.map((i) => i.label).join(' · ')}
          onclick={() => (openGroup = openGroup === group.id ? null : group.id)}
        >
          <span class="tab-icon"><Icon name={current?.icon ?? group.icon} size={16} /></span>
          <span class="tab-label">{current ? current.label : group.label}</span>
          <span class="caret" aria-hidden="true"><Icon name="chevron" size={12} /></span>
        </button>
        {#if openGroup === group.id}
          <div class="menu" role="menu" aria-label={group.label}>
            <p class="menu-title">{group.label}</p>
            {#each group.items as item (item.id)}
              <a role="menuitem" href="#/{item.id}" class:current={view === item.id} aria-current={view === item.id ? 'page' : undefined} onclick={() => (openGroup = null)}>
                <span class="menu-icon"><Icon name={item.icon} size={16} /></span>
                <span class="menu-text">
                  <strong>{item.label}</strong>
                  {#if item.hint}<small>{item.hint}</small>{/if}
                </span>
              </a>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</nav>

<style>
  .tabs {
    display: flex;
    align-items: center;
    background: var(--surface);
    border-radius: 999px;
    box-shadow: var(--shadow-sm);
    gap: 2px;
    margin: 0 auto;
    padding: 5px;
    min-width: 0;
  }
  .tabs a,
  .group-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 38px;
    padding: 0 16px;
    border-radius: 999px;
    color: var(--text-2);
    text-decoration: none;
    font-size: 15px;
    font-weight: 400;
    white-space: nowrap;
    transition: background 0.12s, color 0.12s;
  }
  .group-btn {
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
  }
  .tabs a:hover,
  .group-btn:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .tabs a.active,
  .group-btn.active {
    background: var(--ink);
    color: var(--ink-text);
  }
  .caret {
    display: inline-flex;
    opacity: 0.6;
    transform: rotate(90deg);
    transition: transform 0.12s;
  }
  .group-btn[aria-expanded='true'] .caret {
    transform: rotate(-90deg);
  }
  .nav-group {
    position: relative;
  }
  .menu {
    position: absolute;
    top: calc(100% + 10px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 300px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }
  .menu-title {
    margin: 2px 10px 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .tabs .menu a {
    display: flex;
    align-items: center;
    gap: 12px;
    height: auto;
    padding: 9px 10px;
    border-radius: 12px;
    font-size: 14px;
    white-space: normal;
  }
  .tabs .menu a.current {
    background: var(--surface-2);
    color: var(--text);
  }
  .menu-icon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--text-2);
    flex-shrink: 0;
  }
  .menu a.current .menu-icon {
    background: var(--ink);
    color: var(--ink-text);
  }
  .menu-text {
    display: flex;
    flex-direction: column;
    line-height: 1.3;
    min-width: 0;
  }
  .menu-text strong {
    font-weight: 500;
    color: var(--text);
  }
  .menu-text small {
    font-size: 12px;
    color: var(--text-3);
  }
  .tab-icon {
    display: none;
  }

  @media (max-width: 1180px) {
    .tab-icon {
      display: inline-flex;
    }
    .tabs > a:not(.active) .tab-label,
    .group-btn:not(.active) .tab-label {
      display: none;
    }
    .tabs > a:not(.active),
    .group-btn:not(.active) {
      padding: 0 12px;
    }
  }
  @media (max-width: 860px) {
    .tabs {
      margin: 0;
      flex: 1;
    }
  }
</style>
