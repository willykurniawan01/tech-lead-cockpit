<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import type { WaChat, WaMessage } from '../lib/whatsapp/types';
  import { waCustomNames, formatWaPhone } from '../lib/whatsapp/custom-names.svelte';
  import { formatWaText } from './format';

  let { chat, messages }: { chat: WaChat; messages: WaMessage[] } = $props();

  let scroller: HTMLElement | undefined = $state();
  let stickToBottom = true;
  let lastChat = '';

  let editingName = $state(false);
  let nameInput = $state('');

  function onscroll() {
    if (!scroller) return;
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }

  // Follow new messages unless the user scrolled up to read history; jump down on chat switch.
  $effect(() => {
    const count = messages.length;
    const jid = chat.jid;
    if (!scroller || count === 0) return;
    if (jid !== lastChat) {
      lastChat = jid;
      stickToBottom = true;
      editingName = false;
    }
    if (stickToBottom) requestAnimationFrame(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
  });

  function startEditName() {
    nameInput = waCustomNames.getName(chat.jid, chat.name);
    editingName = true;
  }

  function saveName(e?: Event) {
    e?.preventDefault();
    waCustomNames.set(chat.jid, nameInput.trim());
    editingName = false;
  }

  function resetToOriginal() {
    waCustomNames.set(chat.jid, '');
    editingName = false;
  }

  function day(ts: number): string {
    return new Date(ts * 1000).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function time(ts: number): string {
    return new Date(ts * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }
</script>

<section class="thread">
  <header>
    <div class="header-main">
      {#if editingName}
        <form class="edit-form" onsubmit={saveName}>
          <input
            class="edit-input"
            bind:value={nameInput}
            placeholder="Nama kontak / alias"
          />
          <button type="submit" class="btn btn-xs btn-accent">Simpan</button>
          {#if waCustomNames.get(chat.jid)}
            <button type="button" class="btn btn-xs btn-ghost" onclick={resetToOriginal} title="Hapus alias custom">Reset</button>
          {/if}
          <button type="button" class="btn btn-xs btn-ghost" onclick={() => (editingName = false)}>Batal</button>
        </form>
      {:else}
        <div class="title-row">
          <strong>{waCustomNames.getName(chat.jid, chat.name)}</strong>
          <button
            class="btn-icon"
            onclick={startEditName}
            title="Ubah nama kontak / alias di Cockpit"
            aria-label="Ubah nama kontak"
          >
            <Icon name="edit" size={13} />
          </button>
        </div>
      {/if}
      <span class="muted">
        {#if !chat.isGroup}
          <span class="phone">{formatWaPhone(chat.jid)}</span> ·
        {/if}
        {chat.isGroup ? 'Grup' : 'Chat pribadi'} · {messages.length} pesan terakhir
      </span>
    </div>
  </header>
  <div class="scroll" bind:this={scroller} {onscroll}>
    {#each messages as m, i (m.id)}
      {#if i === 0 || day(messages[i - 1].timestamp) !== day(m.timestamp)}
        <div class="day"><span>{m.timestamp ? day(m.timestamp) : 'Waktu tidak diketahui'}</span></div>
      {/if}
      <div class="msg" class:me={m.fromMe}>
        <div class="bubble">
          {#if chat.isGroup && !m.fromMe && (i === 0 || messages[i - 1].sender !== m.sender || messages[i - 1].fromMe)}
            <div class="sender">{m.sender}</div>
          {/if}
          {#if m.attachment}
            <div class="attachment-pill">
              {#if m.attachment.type === 'image'}
                <Icon name="image" size={13} />
                <span>Gambar</span>
              {:else if m.attachment.type === 'document'}
                <Icon name="doc" size={13} />
                <span class="att-name">{m.attachment.fileName || 'Dokumen'}</span>
              {:else}
                <Icon name="paperclip" size={13} />
                <span>Lampiran</span>
              {/if}
            </div>
          {/if}
          <div class="text">{@html formatWaText(m.text)}</div>
          <div class="meta">{m.timestamp ? time(m.timestamp) : ''}</div>
        </div>
      </div>
    {:else}
      <p class="empty muted">Belum ada pesan yang tersinkron untuk chat ini. Pesan baru akan muncul otomatis.</p>
    {/each}
  </div>
</section>

<style>
  .thread {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  header {
    display: flex;
    flex-direction: column;
    padding: 10px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .header-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .title-row strong {
    font-size: 14.5px;
    font-weight: 600;
  }
  .btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px;
    border-radius: var(--radius-sm);
    border: 0;
    background: none;
    color: var(--text-3);
    cursor: pointer;
  }
  .btn-icon:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .edit-form {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .edit-input {
    height: 28px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 13px;
    min-width: 180px;
    max-width: 260px;
  }
  .edit-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .btn-xs {
    height: 26px;
    padding: 0 8px;
    font-size: 11.5px;
  }
  .phone {
    font-family: var(--font-mono, monospace);
  }
  header span {
    font-size: 12px;
  }
  .scroll {
    flex: 1;
    overflow: auto;
    padding: 12px 16px 20px;
    background: var(--surface-2);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .day {
    text-align: center;
    margin: 10px 0 6px;
  }
  .day span {
    font-size: 11.5px;
    padding: 3px 10px;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-3);
    box-shadow: var(--shadow);
  }
  .msg {
    display: flex;
  }
  .msg.me {
    justify-content: flex-end;
  }
  .bubble {
    max-width: min(78%, 560px);
    padding: 6px 10px 4px;
    border-radius: 10px;
    background: var(--surface);
    box-shadow: var(--shadow);
    overflow-wrap: anywhere;
  }
  .me .bubble {
    background: var(--ok-soft);
  }
  .sender {
    font-size: 12px;
    font-weight: 700;
    color: var(--accent);
    margin-bottom: 2px;
  }
  .text {
    white-space: pre-wrap;
    font-size: 14px;
  }
  .text :global(code) {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--surface-2);
    padding: 0 4px;
    border-radius: 3px;
  }
  .text :global(code.block) {
    display: block;
    padding: 6px 8px;
    margin: 4px 0;
  }
  .meta {
    text-align: right;
    font-size: 11px;
    color: var(--text-3);
  }
  .empty {
    margin: auto;
    text-align: center;
    font-size: 13px;
    max-width: 320px;
  }
  .attachment-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    margin-bottom: 4px;
    border-radius: 4px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-size: 12px;
    font-weight: 500;
    color: var(--text-1);
  }
  .att-name {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
