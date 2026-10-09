<script lang="ts">
  import { jira } from '../lib/jira/client';
  import { connector } from '../lib/confluence/client';
  import type { JiraUser } from '../lib/jira/types';

  interface UserOption {
    accountId: string;
    displayName: string;
    emailAddress?: string;
    avatarUrl?: string;
  }

  let {
    visible = false,
    x = 0,
    y = 0,
    query = '',
    knownUsers = {},
    onselect,
    onclose,
  }: {
    visible: boolean;
    x: number;
    y: number;
    query: string;
    knownUsers?: Record<string, string>;
    onselect: (user: UserOption) => void;
    onclose: () => void;
  } = $props();

  let users = $state<UserOption[]>([]);
  let loading = $state(false);
  let selectedIndex = $state(0);
  let debounceTimer: any = null;

  // Convert knownUsers (name -> accountId) into local candidates
  const localCandidates = $derived.by(() => {
    const list: UserOption[] = [];
    for (const [name, id] of Object.entries(knownUsers)) {
      if (name.trim() && id.trim()) {
        list.push({ accountId: id, displayName: name });
      }
    }
    return list;
  });

  $effect(() => {
    if (!visible) {
      users = [];
      selectedIndex = 0;
      loading = false;
      clearTimeout(debounceTimer);
      return;
    }

    const q = query.trim().toLowerCase();

    // 1. Immediately show local candidates from the document with zero latency
    const matchingLocal = localCandidates.filter(
      (u) => !q || u.displayName.toLowerCase().includes(q)
    );
    users = matchingLocal.slice(0, 10);
    selectedIndex = 0;

    // 2. Only query remote directory if user typed at least 2 characters
    clearTimeout(debounceTimer);
    if (q.length < 2) {
      loading = false;
      return;
    }

    loading = true;
    debounceTimer = setTimeout(async () => {
      let remoteUsers: UserOption[] = [];
      try {
        const jiraRes = await jira.users(q).catch(() => []);
        if (jiraRes && jiraRes.length) {
          remoteUsers = jiraRes;
        } else {
          const confRes = await connector.searchUsers(q).catch(() => []);
          remoteUsers = (confRes || []).map((u) => ({
            accountId: u.accountId,
            displayName: u.displayName,
            emailAddress: u.email,
          }));
        }
      } catch {
        /* fallback to local only */
      }

      if (!visible) return;

      // Merge and deduplicate by accountId
      const seen = new Set<string>();
      const combined: UserOption[] = [];

      for (const u of [...matchingLocal, ...remoteUsers]) {
        if (!seen.has(u.accountId)) {
          seen.add(u.accountId);
          combined.push(u);
        }
      }

      users = combined.slice(0, 10);
      loading = false;
    }, 250);

    return () => clearTimeout(debounceTimer);
  });

  export function handleKeydown(e: KeyboardEvent): boolean {
    if (!visible) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (users.length > 0) {
        selectedIndex = (selectedIndex + 1) % users.length;
      }
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (users.length > 0) {
        selectedIndex = (selectedIndex - 1 + users.length) % users.length;
      }
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (users.length > 0 && users[selectedIndex]) {
        e.preventDefault();
        onselect(users[selectedIndex]);
        return true;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
      return true;
    }

    return false;
  }

  function getInitials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  }

  const clampedX = $derived(typeof window !== 'undefined' ? Math.max(8, Math.min(x, window.innerWidth - 300)) : x);
  const clampedY = $derived(typeof window !== 'undefined' ? (y + 300 > window.innerHeight ? Math.max(8, y - 310) : y) : y);

  $effect(() => {
    if (!visible) return;
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('.mention-popover')) {
        onclose();
      }
    }
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  });
</script>

{#if visible}
  <div
    class="mention-popover"
    style="top: {clampedY}px; left: {clampedX}px;"
    role="listbox"
    aria-label="Saran pengguna"
    tabindex="-1"
  >
    <div class="mention-header">
      <span class="mention-icon">@</span>
      <span class="mention-title">Saran Pengguna {query ? `("${query}")` : ''}</span>
    </div>

    {#if loading && users.length === 0}
      <div class="mention-empty">Mencari pengguna...</div>
    {:else if users.length === 0}
      <div class="mention-empty">Tidak ada pengguna ditemukan</div>
    {:else}
      <div class="mention-list">
        {#each users as user, i (user.accountId)}
          <button
            type="button"
            class="mention-item"
            class:active={i === selectedIndex}
            onclick={() => onselect(user)}
            onmouseenter={() => (selectedIndex = i)}
            role="option"
            aria-selected={i === selectedIndex}
          >
            <span class="user-avatar" aria-hidden="true">
              {getInitials(user.displayName || 'User')}
            </span>
            <div class="user-meta">
              <span class="user-name">{user.displayName}</span>
              {#if user.emailAddress}
                <span class="user-email">{user.emailAddress}</span>
              {/if}
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .mention-popover {
    position: fixed;
    z-index: 9999;
    width: 290px;
    max-height: 320px;
    background: var(--surface, #ffffff);
    border: 1px solid var(--border-strong, #d4d5de);
    border-radius: var(--radius-sm, 10px);
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-size: 0.85rem;
    animation: popIn 0.1s ease-out;
  }

  @keyframes popIn {
    from {
      opacity: 0;
      transform: translateY(-4px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .mention-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    background: var(--surface-2, #f4f4f7);
    border-bottom: 1px solid var(--border, #e6e6ec);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-2, #4b4c57);
  }

  .mention-icon {
    color: var(--accent, #4f46e5);
    font-weight: 700;
  }

  .mention-title {
    color: var(--text-2, #4b4c57);
    font-weight: 600;
  }

  .mention-list {
    overflow-y: auto;
    max-height: 260px;
    padding: 4px;
    background: var(--surface, #ffffff);
  }

  .mention-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    background: transparent;
    border-radius: 6px;
    text-align: left;
    cursor: pointer;
    color: var(--text, #17171c);
    transition: background 0.08s ease;
  }

  .mention-item:hover,
  .mention-item.active {
    background: var(--surface-hover, #ececf1);
  }

  .user-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent, #4f46e5);
    color: #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 600;
    flex-shrink: 0;
  }

  .user-meta {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .user-name {
    font-weight: 500;
    color: var(--text, #17171c);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .user-email {
    font-size: 0.72rem;
    color: var(--text-3, #858795);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mention-empty {
    padding: 16px 12px;
    text-align: center;
    color: var(--text-3, #858795);
    font-size: 0.8rem;
  }
</style>
