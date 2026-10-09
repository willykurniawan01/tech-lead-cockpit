<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { wa } from '../lib/whatsapp/client';
  import { waCustomNames } from '../lib/whatsapp/custom-names.svelte';
  import { waDraftStore } from '../lib/whatsapp/draft-store.svelte';
  import type { WaAudience, WaChat, WaMessage, WaStatus, WaTemplate } from '../lib/whatsapp/types';
  import ChatList from './ChatList.svelte';
  import ChatThread from './ChatThread.svelte';
  import ConnectPanel from './ConnectPanel.svelte';
  import ReplyComposer from './ReplyComposer.svelte';
  import TemplateManager from './TemplateManager.svelte';

  const AUDIENCE_KEY = 'tlc.wa.audience';

  let status = $state<WaStatus | null>(null);
  let chats = $state<WaChat[]>([]);
  let messages = $state<WaMessage[]>([]);
  let templates = $state<WaTemplate[]>([]);
  let busy = $state(false);
  let managerOpen = $state(false);
  let connectorError = $state('');

  let audiences = $state<Record<string, WaAudience>>(loadAudiences());

  const selectedJid = $derived(waDraftStore.selectedJid);
  const open = $derived(status?.connection === 'open');

  $effect(() => {
    waDraftStore.consumePending();
  });

  const newChat = $derived.by<WaChat | undefined>(() => {
    if (!selectedJid) return undefined;
    if (chats.some((c) => c.jid === selectedJid)) return undefined;
    const name = waCustomNames.getName(selectedJid, selectedJid.replace('@s.whatsapp.net', ''));
    return {
      jid: selectedJid,
      name,
      isGroup: false,
      unread: 0,
      lastTimestamp: Math.floor(Date.now() / 1000),
      lastText: '',
    };
  });

  const allChats = $derived.by(() => {
    if (newChat && !chats.some((c) => c.jid === newChat.jid)) {
      return [newChat, ...chats];
    }
    return chats;
  });

  const chat = $derived(chats.find((c) => c.jid === selectedJid) ?? newChat);

  function loadAudiences(): Record<string, WaAudience> {
    try {
      return JSON.parse(localStorage.getItem(AUDIENCE_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  function setAudience(a: WaAudience) {
    if (!selectedJid) return;
    audiences = { ...audiences, [selectedJid]: a };
    try {
      localStorage.setItem(AUDIENCE_KEY, JSON.stringify(audiences));
    } catch {
      /* per-viewer convenience only */
    }
  }

  async function refreshStatus() {
    try {
      status = await wa.status();
      connectorError = '';
    } catch (e) {
      connectorError = (e as Error).message;
    }
  }

  async function refreshChats() {
    try {
      chats = await wa.chats();
    } catch {
      /* next poll retries */
    }
  }

  async function refreshMessages() {
    if (!selectedJid) return;
    const jid = selectedJid;
    try {
      const list = await wa.messages(jid);
      if (jid === selectedJid) messages = list;
    } catch {
      /* next poll retries */
    }
  }

  // Status polls fast while pairing so the QR stays fresh; chats/messages only once open.
  $effect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 2500);
    return () => clearInterval(t);
  });

  $effect(() => {
    if (!open) return;
    refreshChats();
    wa.templates().then((t) => (templates = t)).catch(() => {});
    const t = setInterval(refreshChats, 4000);
    return () => clearInterval(t);
  });

  $effect(() => {
    const jid = selectedJid;
    if (!open || !jid) return;
    messages = [];
    refreshMessages();
    const t = setInterval(refreshMessages, 3000);
    return () => clearInterval(t);
  });

  async function connect() {
    busy = true;
    try {
      status = await wa.connect();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      busy = false;
    }
  }

  async function logout() {
    const ok = await confirmDialog({
      title: 'Putuskan WhatsApp',
      message: 'Putuskan WhatsApp dari aplikasi ini? Perangkat tertaut akan dihapus dari HP kamu.',
      confirmText: 'Putuskan Perangkat',
      danger: true,
    });
    if (!ok) return;
    busy = true;
    try {
      status = await wa.logout();
      chats = [];
      messages = [];
      waDraftStore.select(null);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      busy = false;
    }
  }
</script>

{#if connectorError && !status}
  <section class="center muted">{connectorError}</section>
{:else if !open}
  <ConnectPanel {status} {busy} onconnect={connect} />
{:else}
  <div class="wa">
    <header class="bar">
      <div class="who">
        <span class="dot" aria-hidden="true"></span>
        <strong>WhatsApp tertaut</strong>
        <span class="muted">{status?.me?.name || status?.me?.id?.split(':')[0]}</span>
      </div>
      <button class="btn btn-sm" onclick={() => (managerOpen = true)}><Icon name="template" size={13} /> Template</button>
      <button class="btn btn-ghost btn-sm" onclick={logout} disabled={busy}><Icon name="logout" size={13} /> Putuskan</button>
    </header>

    <div class="cols" class:has-chat={!!chat}>
      <ChatList chats={allChats} selected={waDraftStore.selectedJid} onselect={(jid) => waDraftStore.select(jid)} />
      {#if chat}
        <ChatThread {chat} {messages} />
        <ReplyComposer
          {chat}
          {templates}
          audience={audiences[chat.jid] ?? 'team'}
          bind:draft={() => waDraftStore.getDraft(chat.jid), (v) => waDraftStore.setDraft(chat.jid, v, false)}
          onaudience={setAudience}
          onsent={() => {
            refreshMessages();
            refreshChats();
          }}
          onmanage={() => (managerOpen = true)}
        />
      {:else}
        <div class="placeholder muted">
          <Icon name="chat" size={28} />
          <p>Pilih chat untuk membaca percakapan dan menyusun balasan dengan AI atau template.</p>
        </div>
      {/if}
    </div>
  </div>
{/if}

<TemplateManager bind:open={managerOpen} {templates} onsaved={(t) => (templates = t)} />

<style>
  .center {
    display: grid;
    place-items: center;
    height: 100%;
  }
  .wa {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .who {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .who .muted {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 0 3px var(--ok-soft);
  }
  .cols {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 300px 1fr;
  }
  .cols.has-chat {
    grid-template-columns: 300px minmax(0, 1fr) 360px;
  }
  .placeholder {
    display: grid;
    place-items: center;
    align-content: center;
    gap: 8px;
    text-align: center;
    padding: 24px;
  }
  .placeholder p {
    max-width: 320px;
  }
  @media (max-width: 1150px) {
    .cols.has-chat {
      grid-template-columns: 240px minmax(0, 1fr) 320px;
    }
  }
  @media (max-width: 900px) {
    .cols,
    .cols.has-chat {
      grid-template-columns: 1fr;
      grid-auto-rows: minmax(0, auto);
      overflow: auto;
    }
  }
</style>
