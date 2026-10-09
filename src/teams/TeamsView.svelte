<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { teams } from '../lib/teams/client';
  import { TEAMS_TONES, type TeamsStatus, type TeamsChat, type TeamsMessage, type TeamsTone } from '../lib/teams/types';
  import type { AiSelection } from '../lib/ai/types';
  import TeamsConnectPanel from './TeamsConnectPanel.svelte';

  const STORAGE_AI_KEY = 'tlc.ai.teams';
  function loadSavedAi(): AiSelection {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_AI_KEY) ?? 'null');
      if (saved && (saved.provider === 'inferhub' || saved.provider === 'claude' || saved.provider === 'antigravity' || saved.provider === '9router')) {
        return saved;
      }
    } catch {
      /* ignore */
    }
    return { provider: 'inferhub', model: 'ali/qwen3.8-max' };
  }

  const STORAGE_TONE_KEY = 'tlc.teams.tone';
  function loadSavedTone(): TeamsTone {
    try {
      const saved = localStorage.getItem(STORAGE_TONE_KEY) as TeamsTone;
      if (saved && TEAMS_TONES.some((t) => t.id === saved)) return saved;
    } catch {
      /* ignore */
    }
    return 'casual';
  }

  let status = $state<TeamsStatus | null>(null);
  let loadingStatus = $state(true);
  let chats = $state<TeamsChat[]>([]);
  let loadingChats = $state(false);
  let selectedChatId = $state<string | null>(null);
  let messages = $state<TeamsMessage[]>([]);
  let loadingMessages = $state(false);
  let searchQuery = $state('');
  type ChatFilterCategory = 'all' | 'oneOnOne' | 'channel' | 'group' | 'mr';
  let selectedCategory = $state<ChatFilterCategory>('all');

  let replyText = $state('');
  let aiInstruction = $state('');
  let ai = $state<AiSelection>(loadSavedAi());
  let selectedTone = $state<TeamsTone>(loadSavedTone());
  function setTone(tone: TeamsTone) {
    selectedTone = tone;
    try {
      localStorage.setItem(STORAGE_TONE_KEY, tone);
    } catch {
      /* ignore */
    }
  }
  const activeTone = $derived(TEAMS_TONES.find((t) => t.id === selectedTone) ?? TEAMS_TONES[0]);

  let drafting = $state(false);
  let sending = $state(false);

  let attachment = $state<{
    file: File;
    filename: string;
    mimetype: string;
    data: string;
    size: number;
    previewUrl?: string;
  } | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    processFile(file);
    input.value = '';
  }

  function processFile(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      toasts.show('Ukuran file maksimal 25 MB.', 'err');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] || '';
      attachment = {
        file,
        filename: file.name,
        mimetype: file.type || 'application/octet-stream',
        data: base64,
        size: file.size,
        previewUrl: file.type.startsWith('image/') ? result : undefined,
      };
    };
    reader.readAsDataURL(file);
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          processFile(file);
          break;
        }
      }
    }
  }

  function removeAttachment() {
    attachment = null;
  }

  let scroller: HTMLElement | undefined = $state();
  let mrPanelOpen = $state(false);

  const activeChat = $derived(chats.find((c) => c.id === selectedChatId));

  const countDirect = $derived(chats.filter((c) => c.chatType === 'oneOnOne').length);
  const countChannels = $derived(chats.filter((c) => c.chatType === 'channel').length);
  const countGroup = $derived(chats.filter((c) => c.chatType === 'group' || c.chatType === 'meeting').length);
  const countMR = $derived(chats.filter((c) => c.detectedMRs && c.detectedMRs.length > 0).length);

  const filteredChats = $derived(
    chats.filter((c) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        c.title.toLowerCase().includes(q) ||
        (c.lastMessage?.preview && c.lastMessage.preview.toLowerCase().includes(q)) ||
        (c.lastMessage?.sender && c.lastMessage.sender.toLowerCase().includes(q));

      let matchesCategory = true;
      if (selectedCategory === 'oneOnOne') {
        matchesCategory = c.chatType === 'oneOnOne';
      } else if (selectedCategory === 'channel') {
        matchesCategory = c.chatType === 'channel';
      } else if (selectedCategory === 'group') {
        matchesCategory = c.chatType === 'group' || c.chatType === 'meeting';
      } else if (selectedCategory === 'mr') {
        matchesCategory = Boolean(c.detectedMRs && c.detectedMRs.length > 0);
      }

      return matchesSearch && matchesCategory;
    })
  );

  const detectedMRsInActiveChat = $derived.by(() => {
    const set = new Set<string>();
    for (const m of messages) {
      if (m.detectedMRs) {
        for (const url of m.detectedMRs) set.add(url);
      }
    }
    if (activeChat?.detectedMRs) {
      for (const url of activeChat.detectedMRs) set.add(url);
    }
    return Array.from(set);
  });

  $effect(() => {
    checkStatus();
  });

  async function checkStatus() {
    loadingStatus = true;
    try {
      status = await teams.status();
      if (status.connected) {
        await loadChats();
      }
    } catch (e: any) {
      status = { connected: false, error: e.message, tenantId: '', clientId: '' };
    } finally {
      loadingStatus = false;
    }
  }

  async function loadChats() {
    loadingChats = true;
    try {
      chats = await teams.chats();
      if (!selectedChatId && chats.length > 0) {
        selectChat(chats[0].id);
      }
    } catch (e: any) {
      toasts.show(`Gagal memuat daftar chat: ${e.message}`, 'err');
    } finally {
      loadingChats = false;
    }
  }

  async function selectChat(id: string) {
    selectedChatId = id;
    loadingMessages = true;
    mrPanelOpen = false;
    replyText = '';
    aiInstruction = '';
    attachment = null;
    try {
      messages = await teams.messages(id);
      scrollToBottom();
    } catch (e: any) {
      toasts.show(`Gagal memuat pesan: ${e.message}`, 'err');
    } finally {
      loadingMessages = false;
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }

  async function handleLogout() {
    const ok = await confirmDialog({
      title: 'Putuskan Microsoft Teams',
      message: 'Putuskan koneksi Microsoft Teams dari Cockpit?',
      confirmText: 'Putuskan Koneksi',
      danger: true,
    });
    if (!ok) return;
    try {
      await teams.logout();
      status = await teams.status();
      chats = [];
      messages = [];
      selectedChatId = null;
      toasts.show('Koneksi Microsoft Teams diputuskan.', 'info');
    } catch (e: any) {
      toasts.show(`Gagal logout: ${e.message}`, 'err');
    }
  }

  async function handleSend() {
    if (!selectedChatId || (!replyText.trim() && !attachment) || sending) return;
    sending = true;
    const textToSend = replyText.trim();
    const currentAttachment = attachment;
    try {
      await teams.send({
        chatId: selectedChatId,
        content: textToSend,
        attachment: currentAttachment
          ? {
              filename: currentAttachment.filename,
              mimetype: currentAttachment.mimetype,
              data: currentAttachment.data,
              size: currentAttachment.size,
            }
          : undefined,
      });
      replyText = '';
      attachment = null;
      toasts.show('Pesan terkirim ke Microsoft Teams!', 'ok');
      // Refresh messages
      messages = await teams.messages(selectedChatId);
      scrollToBottom();
    } catch (e: any) {
      toasts.show(`Gagal mengirim pesan: ${e.message}`, 'err');
    } finally {
      sending = false;
    }
  }

  async function handleDraftAi() {
    if (!selectedChatId || drafting) return;
    drafting = true;
    try {
      const res = await teams.draft({
        chatId: selectedChatId,
        instructions: aiInstruction.trim() || undefined,
        tone: selectedTone,
        provider: ai.provider,
        model: ai.model,
      });
      replyText = res.draft;
      toasts.show('Draft balasan dibuat dengan AI!', 'ok');
    } catch (e: any) {
      toasts.show(`Gagal membuat draft AI: ${e.message}`, 'err');
    } finally {
      drafting = false;
    }
  }

  function applyQuickChip(text: string) {
    replyText = text;
  }

  function formatTime(iso: string): string {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function formatDay(iso: string): string {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
    } catch {
      return '';
    }
  }

  function formatMrLabel(url: string): { title: string; subtitle?: string } {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/([^/]+)\/-\/merge_requests\/(\d+)/i);
      if (m) {
        return { title: `${m[1]} !${m[2]}`, subtitle: u.pathname };
      }
      const gh = u.pathname.match(/\/([^/]+)\/pull\/(\d+)/i);
      if (gh) {
        return { title: `${gh[1]} #${gh[2]}`, subtitle: u.pathname };
      }
    } catch {
      /* ignore */
    }
    return { title: url };
  }

  const TYPE_LABEL: Record<string, string> = { oneOnOne: 'Direct', group: 'Grup', meeting: 'Meeting', channel: 'Channel', notes: 'Catatan' };

  function initials(name: string): string {
    const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
  }

  /** Stable per-name tint so the same person keeps the same avatar colour. */
  function hue(name: string): number {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  function dayKey(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toDateString();
  }

  function dayLabel(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    if (d.toDateString() === today.toDateString()) return 'Hari ini';
    if (d.toDateString() === yesterday.toDateString()) return 'Kemarin';
    return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  /** List-row time: clock for today, short date otherwise. */
  function listTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toDateString() === new Date().toDateString() ? formatTime(iso) : formatDay(iso);
  }

  // Consecutive messages from the same sender within 5 minutes form one visual group.
  const threadItems = $derived(
    messages.map((m, i) => {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const newDay = !prev || dayKey(prev.timestamp) !== dayKey(m.timestamp);
      const sameAsPrev = !newDay && prev.sender === m.sender && Date.parse(m.timestamp) - Date.parse(prev.timestamp) < 300_000;
      const sameAsNext =
        next && dayKey(next.timestamp) === dayKey(m.timestamp) && next.sender === m.sender && Date.parse(next.timestamp) - Date.parse(m.timestamp) < 300_000;
      return { m, newDay, first: !sameAsPrev, last: !sameAsNext };
    }),
  );

  // On narrow screens the list and the thread take turns.
  let threadOpen = $state(false);

  function autosize(node: HTMLTextAreaElement, _value: string) {
    const fit = () => {
      node.style.height = 'auto';
      node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
    };
    fit();
    return { update: fit };
  }

  /** Teams HTML turns every paragraph into a blank-line gap; one line break reads better in a bubble. */
  function tidy(text: string): string {
    return text.replace(/[ \t]+\n/g, '\n').replace(/\n\s*\n/g, '\n').trim();
  }

  function copyToClipboard(text: string) {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(text);
      toasts.show('Link MR disalin ke clipboard!', 'ok', 2000);
    }
  }
</script>

<div class="teams-container">
  {#if loadingStatus}
    <div class="loading-state">
      <Icon name="refresh" size={24} />
      <p>Memeriksa koneksi Microsoft Teams…</p>
    </div>
  {:else if !status?.connected}
    <TeamsConnectPanel {status} onconnected={checkStatus} />
  {:else}
    <div class="workspace" class:thread-open={threadOpen && activeChat}>
      <!-- Chat list -->
      <aside class="panel list-panel">
        <header class="list-head">
          <div class="list-title">
            <h2>Chat Teams</h2>
            <span class="count">{chats.length}</span>
            <span class="spacer"></span>
            <button class="icon-btn" title="Muat ulang daftar chat" onclick={loadChats} disabled={loadingChats}>
              <Icon name="refresh" size={16} />
            </button>
            <button class="icon-btn" title="Putuskan koneksi ({status.user?.email ?? ''})" onclick={handleLogout}>
              <Icon name="logout" size={16} />
            </button>
          </div>

          <label class="search-box">
            <Icon name="search" size={16} />
            <input type="search" placeholder="Cari chat, orang, atau MR" bind:value={searchQuery} />
          </label>

          <div class="segments" role="tablist" aria-label="Filter chat">
            {#each [
              { id: 'all', label: 'Semua', n: chats.length },
              { id: 'oneOnOne', label: 'Direct', n: countDirect },
              { id: 'group', label: 'Grup', n: countGroup },
              { id: 'channel', label: 'Channel', n: countChannels },
              { id: 'mr', label: 'Ada MR', n: countMR },
            ] as f (f.id)}
              <button
                role="tab"
                aria-selected={selectedCategory === f.id}
                class:active={selectedCategory === f.id}
                onclick={() => (selectedCategory = f.id as ChatFilterCategory)}
              >
                {f.label}<span class="seg-n">{f.n}</span>
              </button>
            {/each}
          </div>
        </header>

        <div class="chat-list">
          {#if loadingChats && chats.length === 0}
            <div class="empty-state muted">Memuat percakapan…</div>
          {:else if filteredChats.length === 0}
            <div class="empty-state muted">Tidak ada chat yang sesuai.</div>
          {:else}
            {#each filteredChats as c (c.id)}
              <button class="chat-item" class:selected={c.id === selectedChatId} onclick={() => ((threadOpen = true), selectChat(c.id))}>
                <span class="avatar" style:--h={hue(c.title)}>
                  {#if c.chatType === 'channel'}
                    <Icon name="hash" size={17} />
                  {:else if c.chatType === 'notes'}
                    <Icon name="doc" size={17} />
                  {:else}
                    {initials(c.title)}
                  {/if}
                  {#if c.chatType === 'group' || c.chatType === 'meeting'}
                    <span class="avatar-badge"><Icon name="teams" size={10} /></span>
                  {/if}
                </span>
                <span class="chat-body">
                  <span class="chat-row">
                    <span class="chat-title">{c.title}</span>
                    <span class="chat-time">{listTime(c.lastUpdatedDateTime)}</span>
                  </span>
                  <span class="chat-row">
                    <span class="chat-preview">
                      {#if c.lastMessage?.sender && c.chatType !== 'oneOnOne'}<span class="preview-sender">{c.lastMessage.sender.split(' ')[0]}:</span>{/if}
                      {c.lastMessage?.preview || 'Belum ada pesan'}
                    </span>
                    {#if c.detectedMRs?.length}
                      <span class="mr-badge" title="{c.detectedMRs.length} link MR terdeteksi"><Icon name="merge" size={11} />{c.detectedMRs.length}</span>
                    {/if}
                  </span>
                </span>
              </button>
            {/each}
          {/if}
        </div>
      </aside>

      <!-- Thread -->
      <section class="panel thread-panel">
        {#if !activeChat}
          <div class="empty-selection">
            <span class="empty-icon"><Icon name="chat" size={28} /></span>
            <h3>Pilih percakapan</h3>
            <p class="muted">Pesan dan link MR dari developer akan muncul di sini.</p>
          </div>
        {:else}
          <header class="chat-header">
            <button class="icon-btn back" title="Kembali ke daftar chat" onclick={() => (threadOpen = false)}>
              <Icon name="chevron" size={18} />
            </button>
            <span class="avatar avatar-lg" style:--h={hue(activeChat.title)}>
              {#if activeChat.chatType === 'channel'}<Icon name="hash" size={18} />{:else}{initials(activeChat.title)}{/if}
            </span>
            <div class="chat-header-info">
              <h2 title={activeChat.title}>{activeChat.title}</h2>
              <span class="muted small">{TYPE_LABEL[activeChat.chatType] ?? activeChat.chatType} · {messages.length} pesan</span>
            </div>
            {#if detectedMRsInActiveChat.length > 0}
              <button class="mr-toggle" class:active={mrPanelOpen} onclick={() => (mrPanelOpen = !mrPanelOpen)} aria-expanded={mrPanelOpen}>
                <Icon name="merge" size={14} />
                {detectedMRsInActiveChat.length} MR
                <span class="chev" class:up={mrPanelOpen}><Icon name="chevron" size={13} /></span>
              </button>
            {/if}
            <button class="icon-btn" onclick={() => selectChat(activeChat.id)} disabled={loadingMessages} title="Muat ulang pesan">
              <Icon name="refresh" size={16} />
            </button>
          </header>

          {#if mrPanelOpen && detectedMRsInActiveChat.length > 0}
            <div class="mr-panel">
              {#each detectedMRsInActiveChat as mrUrl (mrUrl)}
                {@const info = formatMrLabel(mrUrl)}
                <div class="mr-card" title={mrUrl}>
                  <span class="mr-icon"><Icon name="merge" size={14} /></span>
                  <span class="mr-card-info">
                    <span class="mr-card-title">{info.title}</span>
                    {#if info.subtitle}<span class="mr-card-sub">{info.subtitle}</span>{/if}
                  </span>
                  <button class="icon-btn" onclick={() => copyToClipboard(mrUrl)} title="Salin link"><Icon name="copy" size={15} /></button>
                  <a class="icon-btn" href={mrUrl} target="_blank" rel="noreferrer" title="Buka di GitLab"><Icon name="external" size={15} /></a>
                </div>
              {/each}
            </div>
          {/if}

          <div class="thread-scroll" bind:this={scroller}>
            <div class="thread">
              {#if loadingMessages && messages.length === 0}
                <div class="empty-state muted">Memuat riwayat pesan…</div>
              {:else if messages.length === 0}
                <div class="empty-state muted">Belum ada pesan dalam chat ini.</div>
              {:else}
                {#each threadItems as { m, newDay, first, last } (m.id)}
                  {#if newDay}
                    <div class="day-sep"><span>{dayLabel(m.timestamp)}</span></div>
                  {/if}
                  <div class="msg-row" class:me={m.isMe} class:first class:last>
                    {#if !m.isMe}
                      <span class="msg-avatar">
                        {#if last}<span class="avatar avatar-sm" style:--h={hue(m.sender)}>{initials(m.sender)}</span>{/if}
                      </span>
                    {/if}
                    <div class="bubble">
                      {#if !m.isMe && first && activeChat.chatType !== 'oneOnOne'}
                        <div class="sender-name" style:--h={hue(m.sender)}>{m.sender}</div>
                      {/if}
                      <div class="content">{tidy(m.content)}</div>
                      {#if m.attachments?.length}
                        <div class="bubble-attachment-list">
                          {#each m.attachments as att}
                            {#if att.contentType?.startsWith('image') || att.contentUrl?.startsWith('data:image')}
                              <div class="att-image-box">
                                <img src={att.contentUrl} alt={att.name} class="att-img" />
                              </div>
                            {:else}
                              <div class="att-doc-card">
                                <Icon name="doc" size={15} />
                                <span class="att-doc-name">{att.name}</span>
                                {#if att.contentUrl}
                                  <a href={att.contentUrl} target="_blank" rel="noreferrer" class="att-doc-link" title="Buka file">
                                    <Icon name="external" size={12} />
                                  </a>
                                {/if}
                              </div>
                            {/if}
                          {/each}
                        </div>
                      {/if}
                      {#if m.detectedMRs?.length}
                        <div class="bubble-mr-list">
                          {#each m.detectedMRs as url (url)}
                            <a href={url} target="_blank" rel="noreferrer" class="bubble-mr" title={url}>
                              <Icon name="merge" size={13} />
                              <span>{formatMrLabel(url).title}</span>
                              <Icon name="external" size={11} />
                            </a>
                          {/each}
                        </div>
                      {/if}
                      <div class="timestamp">{formatTime(m.timestamp)}</div>
                    </div>
                  </div>
                {/each}
              {/if}
            </div>
          </div>

          <!-- Composer: quick replies, the reply itself, then AI drafting + send -->
          <div class="composer-wrap">
            <div class="composer">
              <div class="quick-chips">
                {#each [
                  ['Review oke 👍', 'MR sudah saya review ya, siap diapprove 👍'],
                  ['Sedang review ⏳', 'MR sedang saya review ya mas, nanti saya kabari lagi.'],
                  ['Perlu revisi 📝', 'Ada sedikit catatan review di GitLab ya, tolong difix dulu sebelum di-merge.'],
                  ['Tanya migration ❓', 'Sudah dites di local? Apakah ada perubahan skema migration database?'],
                ] as [label, text] (label)}
                  <button class="chip-btn" onclick={() => applyQuickChip(text)}>{label}</button>
                {/each}
              </div>

              <div class="tone-section">
                <div class="tone-header">
                  <span class="tone-title"><Icon name="sparkles" size={13} /> Gaya AI:</span>
                  <div class="tone-pills" role="group" aria-label="Pilih gaya bahasa AI">
                    {#each TEAMS_TONES as t (t.id)}
                      <button
                        type="button"
                        class="tone-pill"
                        class:active={selectedTone === t.id}
                        aria-pressed={selectedTone === t.id}
                        onclick={() => setTone(t.id)}
                        title={t.description}
                      >
                        {t.label}
                      </button>
                    {/each}
                  </div>
                </div>
                <div class="tone-hint muted" title={activeTone.description}>
                  💡 {activeTone.hint}
                </div>
              </div>

              {#if attachment}
                <div class="composer-attachment-preview">
                  {#if attachment.previewUrl}
                    <img src={attachment.previewUrl} alt={attachment.filename} class="composer-att-thumb" />
                  {:else}
                    <div class="composer-att-icon"><Icon name="doc" size={18} /></div>
                  {/if}
                  <div class="composer-att-info">
                    <span class="composer-att-name" title={attachment.filename}>{attachment.filename}</span>
                    <span class="composer-att-size">{formatBytes(attachment.size)}</span>
                  </div>
                  <button type="button" class="btn-att-remove" onclick={removeAttachment} title="Hapus lampiran" aria-label="Hapus lampiran">
                    <Icon name="x" size={14} />
                  </button>
                </div>
              {/if}

              <textarea
                placeholder="Tulis balasan… (Enter kirim, Shift+Enter baris baru, Ctrl+V paste gambar)"
                bind:value={replyText}
                use:autosize={replyText}
                onpaste={handlePaste}
                rows={2}
                onkeydown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              ></textarea>

              <input
                type="file"
                bind:this={fileInput}
                onchange={handleFileChange}
                style="display: none;"
              />

              <div class="composer-bar">
                <button
                  type="button"
                  class="btn btn-ghost attach-btn"
                  onclick={() => fileInput?.click()}
                  title="Lampirkan file atau foto"
                >
                  <Icon name="paperclip" size={15} />
                  <span class="attach-label">Lampirkan</span>
                </button>
                <label class="ai-input">
                  <Icon name="sparkles" size={15} />
                  <input
                    type="text"
                    placeholder="Instruksi AI, mis. bilang sudah oke, deploy ke staging setelah lunch"
                    bind:value={aiInstruction}
                    disabled={drafting}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') handleDraftAi();
                    }}
                  />
                </label>
                <div class="picker-slot"><AiPicker value={ai} onchange={(sel) => (ai = sel)} disabled={drafting} /></div>
                <button class="btn" onclick={handleDraftAi} disabled={drafting}>
                  <Icon name={drafting ? 'refresh' : 'sparkles'} size={14} />
                  {drafting ? 'Menyusun…' : 'Draft AI'}
                </button>
                <button class="btn btn-primary send" onclick={handleSend} disabled={sending || (!replyText.trim() && !attachment)}>
                  <Icon name="send" size={14} />
                  {sending ? 'Mengirim…' : 'Kirim'}
                </button>
              </div>
            </div>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .teams-container {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--text-2);
  }
  .workspace {
    display: grid;
    grid-template-columns: 360px minmax(0, 1fr);
    gap: 16px;
    height: 100%;
    min-height: 0;
  }
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--surface);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .spacer {
    flex: 1;
  }
  .small {
    font-size: 12.5px;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--text-2);
    cursor: pointer;
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--text);
  }
  .icon-btn:disabled {
    opacity: 0.5;
  }

  /* ── List ── */
  .list-head {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 16px 12px;
  }
  .list-title {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 4px;
  }
  h2 {
    margin: 0;
    font-size: 19px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .count {
    padding: 1px 9px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 12.5px;
  }
  .search-box {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 42px;
    padding: 0 14px;
    border-radius: 12px;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .search-box:focus-within {
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .search-box input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: none;
    font-size: 14px;
  }
  .segments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .segments button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 11px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: none;
    color: var(--text-2);
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
  }
  .segments button:hover {
    background: var(--surface-2);
  }
  .segments button.active {
    background: var(--ink);
    border-color: var(--ink);
    color: var(--ink-text);
  }
  .seg-n {
    font-size: 11.5px;
    opacity: 0.65;
  }
  .chat-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 10px 12px;
  }
  .chat-item {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px;
    border: 0;
    border-radius: 14px;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .chat-item:hover {
    background: var(--surface-2);
  }
  .chat-item.selected {
    background: var(--accent-soft);
  }
  .avatar {
    position: relative;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 50%;
    background: hsl(var(--h) 70% 55% / 0.16);
    color: hsl(var(--h) 50% 45%);
    font-size: 14px;
    font-weight: 500;
  }
  .avatar-lg {
    width: 42px;
    height: 42px;
  }
  .avatar-sm {
    width: 30px;
    height: 30px;
    font-size: 11px;
  }
  .avatar-badge {
    position: absolute;
    right: -2px;
    bottom: -2px;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--surface);
    color: var(--text-2);
    box-shadow: 0 0 0 2px var(--surface);
  }
  .chat-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .chat-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .chat-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14.5px;
    font-weight: 500;
  }
  .chat-time {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-3);
  }
  .chat-preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: var(--text-3);
  }
  .preview-sender {
    color: var(--text-2);
    margin-right: 4px;
  }
  .mr-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-text);
    font-size: 11.5px;
    font-weight: 500;
  }
  .empty-state {
    padding: 32px 16px;
    text-align: center;
    font-size: 14px;
  }

  /* ── Thread ── */
  .empty-selection {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 8px;
    text-align: center;
  }
  .empty-icon {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    margin-bottom: 6px;
  }
  .empty-selection h3 {
    margin: 0;
    font-weight: 500;
  }
  .empty-selection p {
    margin: 0;
  }
  .chat-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
  }
  .back {
    display: none;
    transform: rotate(90deg);
  }
  .chat-header-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .chat-header h2 {
    font-size: 17px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mr-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 12px;
    border: 0;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 500;
    font-size: 13px;
    cursor: pointer;
  }
  .mr-toggle.active {
    background: var(--accent);
    color: var(--accent-text);
  }
  .chev {
    display: inline-flex;
    transition: transform 0.15s;
  }
  .chev.up {
    transform: rotate(180deg);
  }
  .mr-panel {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 8px;
    max-height: 200px;
    overflow-y: auto;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }
  .mr-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 6px 8px 10px;
    border-radius: 12px;
    background: var(--surface);
    min-width: 0;
  }
  .mr-icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .mr-card-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .mr-card-title,
  .mr-card-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mr-card-title {
    font-weight: 500;
    font-size: 13.5px;
  }
  .mr-card-sub {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-3);
  }

  .thread-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    background: var(--bg);
  }
  .thread {
    display: flex;
    flex-direction: column;
    max-width: 900px;
    margin: 0 auto;
    padding: 20px 24px 12px;
  }
  .day-sep {
    display: flex;
    justify-content: center;
    margin: 14px 0 10px;
  }
  .day-sep span {
    padding: 4px 12px;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
    box-shadow: var(--shadow-sm);
  }
  .msg-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin-top: 3px;
  }
  .msg-row.first {
    margin-top: 12px;
  }
  .msg-row.me {
    justify-content: flex-end;
  }
  .msg-avatar {
    width: 30px;
    flex-shrink: 0;
  }
  .bubble {
    max-width: min(640px, 78%);
    padding: 10px 14px 8px;
    border-radius: 18px;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
  }
  /* Tail corner only on the last bubble of a group. */
  .msg-row:not(.me).last .bubble {
    border-bottom-left-radius: 6px;
  }
  .msg-row.me .bubble {
    background: var(--accent);
    color: var(--accent-text);
  }
  .msg-row.me.last .bubble {
    border-bottom-right-radius: 6px;
  }
  .sender-name {
    margin-bottom: 2px;
    font-size: 12.5px;
    font-weight: 500;
    color: hsl(var(--h) 55% 48%);
  }
  .content {
    font-size: 14px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .bubble-mr-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }
  .bubble-mr {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 10px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 12.5px;
    font-weight: 500;
    text-decoration: none;
  }
  .msg-row.me .bubble-mr {
    background: rgb(255 255 255 / 0.16);
    color: inherit;
  }
  .bubble-mr span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .timestamp {
    margin-top: 2px;
    font-size: 11px;
    color: var(--text-3);
    text-align: right;
  }
  .msg-row.me .timestamp {
    color: inherit;
    opacity: 0.7;
  }

  /* ── Composer ── */
  .composer-wrap {
    padding: 0 18px 16px;
    background: var(--bg);
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 900px;
    margin: 0 auto;
    padding: 10px 12px 12px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    box-shadow: var(--shadow);
  }
  .composer:focus-within {
    border-color: var(--accent-2);
  }
  .quick-chips {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .chip-btn {
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: none;
    color: var(--text-2);
    font-size: 12.5px;
    white-space: nowrap;
    cursor: pointer;
  }
  .chip-btn:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  .tone-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 10px;
    border-radius: 12px;
    background: var(--surface-2);
  }
  .tone-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .tone-title {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    white-space: nowrap;
  }
  .tone-pills {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .tone-pill {
    height: 24px;
    padding: 0 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .tone-pill:hover {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border-strong, var(--accent-soft));
  }
  .tone-pill.active {
    background: var(--ink);
    color: var(--ink-text);
    border-color: var(--ink);
  }
  .tone-hint {
    font-size: 11px;
    color: var(--text-3);
    line-height: 1.3;
    padding-left: 2px;
  }
  textarea {
    width: 100%;
    min-height: 48px;
    padding: 6px 4px;
    border: 0;
    outline: none;
    background: none;
    font-size: 14.5px;
    line-height: 1.5;
    resize: none;
  }
  .composer-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ai-input {
    flex: 1 1 220px;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 12px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--accent);
    min-width: 0;
  }
  .ai-input input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: none;
    font-size: 13px;
  }
  .picker-slot {
    flex: 0 1 290px;
    min-width: 200px;
  }
  .send {
    margin-left: auto;
    padding: 0 18px;
  }
  .attach-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 36px;
    padding: 0 10px;
    border-radius: var(--radius-sm, 6px);
    color: var(--text-2);
    font-size: 12.5px;
  }
  .attach-btn:hover {
    color: var(--text);
    background: var(--surface-2);
  }
  .attach-label {
    display: inline;
  }
  @media (max-width: 600px) {
    .attach-label {
      display: none;
    }
  }

  /* Bubble Attachment Display */
  .bubble-attachment-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 6px 0 4px;
  }
  .att-image-box {
    max-width: 380px;
    max-height: 280px;
    overflow: hidden;
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  .att-img {
    width: 100%;
    height: auto;
    max-height: 280px;
    object-fit: contain;
    display: block;
  }
  .att-doc-card {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-size: 12.5px;
  }
  .att-doc-name {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .att-doc-link {
    color: var(--accent);
    padding: 2px;
    display: inline-flex;
    align-items: center;
  }

  /* Composer Attachment Preview */
  .composer-attachment-preview {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    margin-bottom: 6px;
    border-radius: 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .composer-att-thumb {
    width: 36px;
    height: 36px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .composer-att-icon {
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 4px;
    background: var(--surface);
    color: var(--accent);
  }
  .composer-att-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .composer-att-name {
    font-size: 12px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composer-att-size {
    font-size: 11px;
    color: var(--text-3);
  }
  .btn-att-remove {
    background: none;
    border: 0;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: grid;
    place-items: center;
  }
  .btn-att-remove:hover {
    color: var(--err);
    background: var(--surface-hover);
  }

  @media (max-width: 1100px) {
    .workspace {
      grid-template-columns: 300px minmax(0, 1fr);
    }
  }
  /* Narrow: one pane at a time, like a phone chat app. */
  @media (max-width: 820px) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
    }
    .workspace.thread-open .list-panel,
    .workspace:not(.thread-open) .thread-panel {
      display: none;
    }
    .back {
      display: grid;
    }
    .bubble {
      max-width: 88%;
    }
  }
</style>
