<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import type { WaChat } from '../lib/whatsapp/types';
  import {
    waCustomNames,
    matchesWaSearch,
    normalizeWaPhone,
    phoneToJid,
    formatWaPhone,
  } from '../lib/whatsapp/custom-names.svelte';

  let {
    chats,
    selected,
    onselect,
  }: {
    chats: WaChat[];
    selected: string | null;
    onselect: (jid: string) => void;
  } = $props();

  let query = $state('');
  let onlyUnread = $state(false);

  // New Chat Modal state
  let modalOpen = $state(false);
  let newPhone = $state('');
  let newName = $state('');
  let modalError = $state('');

  const filtered = $derived.by(() => {
    return chats.filter((c) => {
      if (onlyUnread && c.unread === 0) return false;
      return matchesWaSearch(c.jid, c.name, c.lastText, query);
    });
  });

  function when(ts: number): string {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  }

  function initials(name: string): string {
    return name.replace(/^\+/, '').split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '#';
  }

  function openNewChat(prefilledQuery = '') {
    modalError = '';
    const digits = prefilledQuery.replace(/[^\d+]/g, '');
    if (digits.length >= 3) {
      newPhone = prefilledQuery;
      newName = '';
    } else {
      newPhone = '';
      newName = prefilledQuery;
    }
    modalOpen = true;
  }

  function submitNewChat(e?: Event) {
    e?.preventDefault();
    modalError = '';
    const digits = normalizeWaPhone(newPhone);
    if (!digits || digits.length < 8) {
      modalError = 'Nomor WhatsApp tidak valid (minimal 8 digit angka).';
      return;
    }

    const jid = phoneToJid(newPhone);
    const trimmedName = newName.trim();
    if (trimmedName) {
      waCustomNames.set(jid, trimmedName);
    }

    modalOpen = false;
    newPhone = '';
    newName = '';
    onselect(jid);
  }
</script>

<aside class="list">
  <div class="tools">
    <label class="search">
      <Icon name="search" size={14} />
      <input placeholder="Cari nama atau 08xx..." bind:value={query} aria-label="Cari chat" />
    </label>
    <button
      class="chip"
      class:chip-accent={onlyUnread}
      onclick={() => (onlyUnread = !onlyUnread)}
      aria-pressed={onlyUnread}
    >
      Unread
    </button>
    <button
      class="btn btn-sm btn-accent new-btn"
      onclick={() => openNewChat()}
      title="Mulai chat ke nomor baru"
    >
      <Icon name="plus" size={13} /> Chat Baru
    </button>
  </div>
  <ul>
    {#each filtered as c (c.jid)}
      {@const displayName = waCustomNames.getName(c.jid, c.name)}
      <li>
        <button class="row" class:active={c.jid === selected} onclick={() => onselect(c.jid)}>
          <span class="avatar" class:group={c.isGroup}>{initials(displayName)}</span>
          <span class="body">
            <span class="line1">
              <span class="name">{displayName}</span>
              <span class="time" class:unread={c.unread > 0}>{when(c.lastTimestamp)}</span>
            </span>
            <span class="line2">
              <span class="preview">
                {c.lastText || (formatWaPhone(c.jid) !== displayName ? formatWaPhone(c.jid) : 'Belum ada pesan')}
              </span>
              {#if c.unread > 0}<span class="badge">{c.unread > 99 ? '99+' : c.unread}</span>{/if}
            </span>
          </span>
        </button>
      </li>
    {:else}
      <li class="empty muted">
        {#if query.trim()}
          <p>Tidak ada chat yang cocok untuk "<strong>{query}</strong>".</p>
          <button class="btn btn-sm btn-accent mt-2" onclick={() => openNewChat(query)}>
            <Icon name="plus" size={13} /> Chat ke {query}
          </button>
        {:else if chats.length}
          <p>Tidak ada chat yang cocok.</p>
        {:else}
          <p>Menunggu sinkronisasi chat dari HP…</p>
          <button class="btn btn-sm btn-ghost mt-2" onclick={() => openNewChat()}>
            <Icon name="plus" size={13} /> Mulai Chat Baru
          </button>
        {/if}
      </li>
    {/each}
  </ul>
</aside>

<Modal
  bind:open={modalOpen}
  title="Mulai Chat Baru"
  subtitle="Kirim pesan ke nomor WhatsApp baru atau kontak yang belum ada di daftar."
  width={460}
>
  <form class="modal-form" onsubmit={submitNewChat}>
    <div class="form-group">
      <label for="wa-new-phone">Nomor WhatsApp <span class="req">*</span></label>
      <input
        id="wa-new-phone"
        type="tel"
        bind:value={newPhone}
        placeholder="mis. 08123456789 atau +62812..."
        required
      />
      <small class="muted">Format bebas: 08xx, +628xx, spasi, atau tanda hubung.</small>
    </div>

    <div class="form-group">
      <label for="wa-new-name">Nama Kontak / Alias <span class="muted">(opsional)</span></label>
      <input
        id="wa-new-name"
        type="text"
        bind:value={newName}
        placeholder="mis. Budi PM Payment"
      />
      <small class="muted">Nama disimpan di Cockpit agar mudah dicari.</small>
    </div>

    {#if modalError}
      <p class="form-error">{modalError}</p>
    {/if}

    <div class="modal-footer">
      <button type="button" class="btn btn-ghost" onclick={() => (modalOpen = false)}>Batal</button>
      <button type="submit" class="btn btn-accent"><Icon name="send" size={14} /> Buka Chat</button>
    </div>
  </form>
</Modal>

<style>
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface);
    border-right: 1px solid var(--border);
  }
  .tools {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 10px;
    border-bottom: 1px solid var(--border);
  }
  .search {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: none;
    color: var(--text);
    font-size: 13px;
  }
  .tools .chip {
    flex-shrink: 0;
    border: 0;
    cursor: pointer;
  }
  .new-btn {
    flex-shrink: 0;
    white-space: nowrap;
    padding: 0 10px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px;
    overflow: auto;
    flex: 1;
  }
  .row {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 9px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--surface-hover);
  }
  .row.active {
    background: var(--accent-soft);
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--ok-soft);
    color: var(--ok);
    font-size: 13px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .avatar.group {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .line1,
  .line2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    font-size: 11.5px;
    color: var(--text-3);
  }
  .time.unread {
    color: var(--ok);
    font-weight: 600;
  }
  .preview {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--ok);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: grid;
    place-items: center;
  }
  .empty {
    padding: 24px 12px;
    text-align: center;
    font-size: 13px;
  }
  .mt-2 {
    margin-top: 10px;
  }

  /* Modal Form */
  .modal-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 6px 0;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .form-group label {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-2);
  }
  .form-group input {
    height: 38px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 13.5px;
  }
  .form-group input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .form-group small {
    font-size: 11.5px;
  }
  .req {
    color: var(--err);
  }
  .form-error {
    font-size: 12px;
    color: var(--err);
    margin: 0;
  }
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
</style>
