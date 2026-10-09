<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import AiPicker from '../components/AiPicker.svelte';
  import { toasts } from '../components/toast.svelte';
  import { renderPreview } from '../lib/markdown/preview';
  import type { AiSelection } from '../lib/ai/types';
  import { fetchServicesInfo, loadServicesRoot, type ServicesInfo } from '../tad/generator-client';
  import { api } from '../lib/api-base';
  import { drafts } from '../tad/drafts.svelte';
  import { conversations } from '../lib/assistant/conversations';
  import type { AssistantConversationSummary, AssistantMessage } from '../lib/assistant/types';
  import { claudeCloud } from '../lib/claude-cloud/client';

  const STORAGE_AI_KEY = 'tlc.ai.assistant';
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

  let ai = $state<AiSelection>(loadSavedAi());

  function updateAi(newAi: AiSelection) {
    ai = newAi;
    try {
      localStorage.setItem(STORAGE_AI_KEY, JSON.stringify(newAi));
    } catch {
      /* ignore */
    }
  }

  // Repo a Claude Cloud task runs in: a service from the Services folder, or this workspace.
  let services = $state<ServicesInfo | null>(null);
  let selectedRepo = $state('tech-lead-cockpit');
  $effect(() => {
    fetchServicesInfo(loadServicesRoot())
      .then((info) => (services = info))
      .catch(() => {});
  });

  async function startCloudChatTask() {
    const text = chatInput.trim();
    if (!text || chatting) return;
    chatInput = '';
    const now = new Date().toISOString();
    chatMessages = [
      ...chatMessages,
      { id: `local-${Date.now()}`, role: 'user', text: `[Claude Cloud Task] ${text}`, at: now },
      { id: `local-${Date.now() + 1}`, role: 'assistant', text: '☁️ Sedang menginisialisasi sesi Claude Cloud di background…', at: now, provider: 'claude', model: 'cloud' },
    ];
    chatting = true;
    try {
      const res = await claudeCloud.start({ repo: selectedRepo, prompt: text });
      const last = chatMessages[chatMessages.length - 1];
      if (res.ok) {
        last.text = `☁️ **Sesi Claude Cloud Berhasil Dimulai!**\n\n- **Repository:** \`${selectedRepo}\`\n- **Session ID:** \`${res.sessionId}\`\n- **Link Sesi:** [Buka di claude.ai/code](${res.url})\n\nTask ini sedang berjalan di VM Anthropic. Kamu bisa memantaunya di web/HP atau menarik hasilnya dengan:\n\`\`\`bash\nclaude --teleport ${res.sessionId}\n\`\`\``;
        toasts.show('Sesi Claude Cloud dimulai!', 'ok');
      } else {
        last.text = `⚠️ Gagal memulai sesi Claude Cloud: ${res.error}`;
        last.error = true;
        toasts.show(res.error || 'Gagal memulai sesi cloud', 'err');
      }
    } catch (e: any) {
      const last = chatMessages[chatMessages.length - 1];
      last.text = `⚠️ Error: ${e.message}`;
      last.error = true;
      toasts.show(e.message, 'err');
    } finally {
      chatting = false;
    }
  }

  // --- General Chat State ---
  // Conversations are saved by the connector (~/.tech-lead-cockpit/assistant/conversations);
  // this view only lists, opens and streams them.
  const CURRENT_CONV_KEY = 'tlc.assistant.conversation';
  let convList = $state<AssistantConversationSummary[]>([]);
  let convId = $state<string | null>(readCurrentConv());
  let chatMessages = $state<AssistantMessage[]>([]);
  let chatInput = $state('');
  let chatting = $state(false);
  let loadingConv = $state(false);
  let convQuery = $state('');
  let historyOpen = $state(true);

  const visibleConvs = $derived(
    convList.filter((c) => !convQuery.trim() || `${c.title} ${c.preview}`.toLowerCase().includes(convQuery.trim().toLowerCase())),
  );

  function readCurrentConv(): string | null {
    try {
      return localStorage.getItem(CURRENT_CONV_KEY);
    } catch {
      return null;
    }
  }

  function rememberConv(id: string | null) {
    try {
      if (id) localStorage.setItem(CURRENT_CONV_KEY, id);
      else localStorage.removeItem(CURRENT_CONV_KEY);
    } catch {
      /* only a convenience */
    }
  }

  async function refreshConversations() {
    try {
      convList = await conversations.list();
    } catch (e: any) {
      toasts.show(`Riwayat chat tidak terbaca: ${e.message}`, 'err');
    }
  }

  async function openConversation(id: string) {
    if (chatting) return;
    loadingConv = true;
    try {
      const c = await conversations.get(id);
      convId = c.id;
      stickToBottom = true;
      chatMessages = c.messages;
      rememberConv(c.id);
      if (c.ai) updateAi(c.ai);
    } catch {
      // Deleted elsewhere: fall back to a fresh chat.
      newConversation();
    } finally {
      loadingConv = false;
    }
  }

  function newConversation() {
    if (chatting) return;
    convId = null;
    chatMessages = [];
    rememberConv(null);
  }

  async function removeConversation(c: AssistantConversationSummary) {
    if (!confirm(`Hapus percakapan "${c.title}"? File-nya dipindah ke folder .trash.`)) return;
    try {
      await conversations.remove(c.id);
      if (c.id === convId) newConversation();
      await refreshConversations();
    } catch (e: any) {
      toasts.show(e.message, 'err');
    }
  }

  async function togglePin(c: AssistantConversationSummary) {
    try {
      await conversations.update(c.id, { pinned: !c.pinned });
      await refreshConversations();
    } catch (e: any) {
      toasts.show(e.message, 'err');
    }
  }

  async function renameConversation(c: AssistantConversationSummary) {
    const title = prompt('Judul percakapan', c.title)?.trim();
    if (!title || title === c.title) return;
    try {
      await conversations.update(c.id, { title });
      await refreshConversations();
    } catch (e: any) {
      toasts.show(e.message, 'err');
    }
  }

  $effect(() => {
    untrack(() => {
      void refreshConversations();
      if (convId && !chatMessages.length) void openConversation(convId);
    });
  });

  // Follow the streaming reply, unless the user scrolled up to read earlier messages.
  let chatScroller = $state<HTMLDivElement>();
  let stickToBottom = true;
  function onChatScroll() {
    if (!chatScroller) return;
    stickToBottom = chatScroller.scrollHeight - chatScroller.scrollTop - chatScroller.clientHeight < 80;
  }
  $effect(() => {
    void chatMessages.length;
    void chatMessages[chatMessages.length - 1]?.text;
    if (chatScroller && stickToBottom) requestAnimationFrame(() => chatScroller && (chatScroller.scrollTop = chatScroller.scrollHeight));
  });

  function msgTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toDateString() === new Date().toDateString()
        ? d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function relTime(iso: string): string {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (mins < 1) return 'baru saja';
    if (mins < 60) return `${mins} mnt`;
    if (mins < 1440) return `${Math.round(mins / 60)} jam`;
    return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  }

  async function sendChatMessage(promptToSend?: string) {
    const text = (promptToSend || chatInput).trim();
    if (!text || chatting) return;
    chatInput = '';
    stickToBottom = true;
    const now = new Date().toISOString();
    chatMessages = [
      ...chatMessages,
      { id: `local-${Date.now()}`, role: 'user', text, at: now },
      { id: `local-${Date.now() + 1}`, role: 'assistant', text: '', at: now, provider: ai.provider, model: ai.model },
    ];
    chatting = true;
    const reply = chatMessages[chatMessages.length - 1];

    try {
      const res = await fetch(api('/api/connector/ai/assistant/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1' },
        body: JSON.stringify({ prompt: text, mode: 'general', ai, conversationId: convId ?? undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('Response stream tidak tersedia');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let failure: string | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          let data: any;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          const last = chatMessages[chatMessages.length - 1];
          if (data.kind === 'conversation' && data.id) {
            convId = data.id;
            rememberConv(data.id);
            void refreshConversations();
          } else if (data.kind === 'text' && data.text) {
            last.text += (last.text ? '\n' : '') + data.text;
          } else if (data.kind === 'done') {
            last.text = data.reply ?? last.text;
          } else if (data.kind === 'error') {
            failure = data.error;
          }
        }
      }
      if (failure) throw new Error(failure);
    } catch (e: any) {
      const last = chatMessages[chatMessages.length - 1];
      if (last === reply || last.id === reply.id) {
        last.text = `⚠️ Gagal merespons: ${e.message}`;
        last.error = true;
      }
      toasts.show(e.message, 'err');
    } finally {
      chatting = false;
      void refreshConversations();
    }
  }

  const QUICK_PROMPTS = [
    'Buat Architecture Decision Record (ADR) untuk migrasi database PostgreSQL ke sharding.',
    'Rancang skema tabel dan API payload untuk sistem idempotent payment gateway.',
    'Bandingkan kelebihan dan kekurangan gRPC vs REST API untuk komunikasi antar-microservices.',
    'Bantu saya menyusun panduan Code Review Checklist standar untuk tim engineering.',
  ];

  /** Links the assistant writes to Cockpit itself: `#/<view>` or `#/tad/<draftId>`. */
  function openCockpitLink(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href') ?? '';
    if (!href.startsWith('#/')) return;
    e.preventDefault();
    const [view, draftId] = href.slice(2).split('/');
    if (view === 'tad' && draftId) {
      if (!drafts.drafts.some((d) => d.id === draftId)) return toasts.show('Draft itu tidak ditemukan.', 'err');
      drafts.select(draftId);
    }
    location.hash = `#/${view}`;
  }
</script>

<div class="assistant-page">
  <header class="assistant-head">
    <div class="head-info">
      <div class="title-row">
        <Icon name="sparkles" size={24} />
        <h1>AI Assistant</h1>
      </div>
      <p class="subtitle">Tanya apa saja soal TAD, proyek, arsitektur, atau cara pakai Cockpit.</p>
    </div>

    <div class="head-controls">
      <div class="picker-box">
        <span class="label-sub">Model AI:</span>
        <AiPicker value={ai} onchange={updateAi} disabled={chatting} />
      </div>
    </div>
  </header>

  <div class="tab-content">
      <div class="chat-shell" class:history-closed={!historyOpen}>
        {#if historyOpen}
          <aside class="conv-panel card" aria-label="Riwayat percakapan">
            <div class="conv-head">
              <strong>Riwayat</strong>
              <span class="conv-count">{convList.length}</span>
              <span class="spacer"></span>
              <button class="btn btn-primary btn-sm" onclick={newConversation} disabled={chatting}><Icon name="plus" size={13} /> Baru</button>
            </div>
            <label class="conv-search">
              <Icon name="search" size={14} />
              <input type="search" placeholder="Cari percakapan" bind:value={convQuery} />
            </label>
            <div class="conv-list">
              {#each visibleConvs as c (c.id)}
                <div class="conv-item" class:active={c.id === convId}>
                  <button class="conv-open" onclick={() => openConversation(c.id)} disabled={chatting} title={c.title}>
                    <span class="conv-title">{#if c.pinned}<span class="pin">●</span>{/if}{c.title}</span>
                    <span class="conv-meta">{relTime(c.updatedAt)} · {c.messageCount} pesan</span>
                  </button>
                  <span class="conv-actions">
                    <button class="icon-btn" title={c.pinned ? 'Lepas pin' : 'Pin di atas'} onclick={() => togglePin(c)}><Icon name="check" size={13} /></button>
                    <button class="icon-btn" title="Ganti judul" onclick={() => renameConversation(c)}><Icon name="edit" size={13} /></button>
                    <button class="icon-btn" title="Hapus" onclick={() => removeConversation(c)}><Icon name="trash" size={13} /></button>
                  </span>
                </div>
              {:else}
                <p class="muted conv-empty">{convList.length ? 'Tidak ada yang cocok.' : 'Belum ada percakapan tersimpan.'}</p>
              {/each}
            </div>
            <p class="conv-foot muted">Tersimpan di ~/.tech-lead-cockpit/assistant</p>
          </aside>
        {/if}

        <div class="chat-layout card">
          <div class="chat-top">
            <button class="icon-btn" onclick={() => (historyOpen = !historyOpen)} title={historyOpen ? 'Sembunyikan riwayat' : 'Tampilkan riwayat'}>
              <Icon name="sidebar" size={16} />
            </button>
            <strong class="chat-title">{convList.find((c) => c.id === convId)?.title ?? 'Percakapan baru'}</strong>
          </div>

          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="chat-messages" bind:this={chatScroller} onclick={openCockpitLink} onscroll={onChatScroll}>
            {#if loadingConv}
              <p class="muted">Memuat percakapan…</p>
            {:else if !chatMessages.length}
              <div class="chat-msg assistant">
                <div class="msg-header">
                  <span class="role-badge"><Icon name="sparkles" size={12} /> AI Assistant</span>
                </div>
                <div class="msg-content">
                  <p>Halo! Saya asisten Tech Lead yang paham Cockpit: draft TAD, koneksi, WhatsApp/Teams, sampai cara pakainya. Saya juga bisa bantu code review, arsitektur, desain API, ADR, dan debugging.</p>
                  <p>Percakapan ini otomatis tersimpan, jadi bisa dilanjutkan kapan saja dari daftar Riwayat.</p>
                </div>
              </div>
            {/if}
            {#each chatMessages as msg (msg.id)}
              <div class="chat-msg {msg.role}" class:error={msg.error}>
                <div class="msg-header">
                  <span class="role-badge">
                    {#if msg.role === 'user'}
                      <Icon name="user" size={12} /> Tech Lead
                    {:else}
                      <Icon name="sparkles" size={12} /> AI Assistant{msg.provider ? ` (${msg.provider}${msg.model ? ` · ${msg.model}` : ''})` : ''}
                    {/if}
                  </span>
                  <span class="msg-time">{msgTime(msg.at)}</span>
                </div>
                {#if msg.text}
                  <div class="msg-content">
                    {@html renderPreview(msg.text).html}
                  </div>
                {:else if chatting}
                  <div class="typing-indicator">Menulis respons…</div>
                {/if}
              </div>
            {/each}
          </div>

          {#if !chatMessages.length}
            <div class="quick-prompts">
              <span class="quick-title">Contoh:</span>
              {#each QUICK_PROMPTS as qp}
                <button type="button" class="quick-chip" onclick={() => sendChatMessage(qp)}>
                  {qp}
                </button>
              {/each}
            </div>
          {/if}

          <form
            class="chat-input-bar"
            onsubmit={(e) => {
              e.preventDefault();
              sendChatMessage();
            }}
          >
            <input
              type="text"
              class="input"
              placeholder="Tanya apa saja: status TAD, cara pakai Cockpit, arsitektur, ADR…"
              bind:value={chatInput}
              disabled={chatting}
            />
            <select class="input cloud-repo" bind:value={selectedRepo} disabled={chatting} aria-label="Repo untuk tugas Claude Cloud" title="Repo tempat tugas Claude Cloud dijalankan">
              {#each services?.services ?? [] as repo (repo)}<option value={repo}>{repo}</option>{/each}
              <option value="tech-lead-cockpit">tech-lead-cockpit</option>
            </select>
            <button
              type="button"
              class="btn btn-ghost btn-cloud-chat"
              onclick={startCloudChatTask}
              disabled={chatting || !chatInput.trim()}
              title="Kirim tugas riset ini ke Claude Cloud VM (claude --cloud)"
            >
              <Icon name="upload" size={14} /> Cloud
            </button>
            <button type="submit" class="btn btn-primary" disabled={chatting || !chatInput.trim()}>
              <Icon name="send" size={16} /> Kirim
            </button>
          </form>
        </div>
      </div>
  </div>
</div>

<style>
  .assistant-page {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 20px 24px;
    gap: 16px;
    overflow: hidden;
    background: var(--bg);
  }

  .assistant-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--primary);
  }
  .title-row h1 {
    font-size: 20px;
    margin: 0;
    color: var(--text-1);
  }
  .subtitle {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--text-3);
  }
  .head-controls {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .picker-box {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .label-sub {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-3);
  }

  .tab-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow);
    min-height: 0;
  }

  /* Chat Layout */
  .chat-layout {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .chat-messages {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 10px 4px 10px 0;
  }
  .chat-msg {
    display: flex;
    flex-direction: column;
    max-width: 85%;
    border-radius: 10px;
    padding: 12px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .chat-msg.user {
    align-self: flex-end;
    background: var(--primary-soft);
    border-color: rgba(var(--primary-rgb), 0.2);
  }
  .chat-msg.assistant {
    align-self: flex-start;
  }
  .msg-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
    font-size: 11px;
    color: var(--text-3);
  }
  .role-badge {
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .quick-prompts {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow-x: auto;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .quick-title {
    font-size: 11px;
    color: var(--text-3);
    white-space: nowrap;
  }
  .quick-chip {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 3px 10px;
    font-size: 11.5px;
    color: var(--text-2);
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .quick-chip:hover {
    color: var(--primary);
    border-color: var(--primary);
    background: var(--primary-soft);
  }

  .chat-input-bar {
    display: flex;
    gap: 8px;
    padding-top: 8px;
    flex-shrink: 0;
  }
  .chat-input-bar input {
    flex: 1;
    min-height: 38px;
  }
  .cloud-repo {
    width: auto;
    max-width: 180px;
    font-size: 12.5px;
  }
  .btn-cloud-chat {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 12px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--primary);
    border: 1px dashed var(--primary);
    background: var(--surface-2);
    border-radius: var(--radius-sm, 6px);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .btn-cloud-chat:hover:not(:disabled) {
    background: var(--primary-soft);
    border-style: solid;
  }
  .btn-cloud-chat:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .chat-shell {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 280px minmax(0, 1fr);
    gap: 16px;
  }
  .chat-shell.history-closed {
    grid-template-columns: minmax(0, 1fr);
  }
  .conv-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    padding: 14px 10px 10px;
  }
  .conv-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px;
  }
  .conv-count {
    padding: 0 8px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .conv-search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 12px;
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .conv-search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: none;
    font-size: 13px;
  }
  .conv-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .conv-item {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: 12px;
  }
  .conv-item:hover {
    background: var(--surface-2);
  }
  .conv-item.active {
    background: var(--accent-soft);
  }
  .conv-open {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 10px;
    border: 0;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .conv-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13.5px;
    font-weight: 500;
  }
  .pin {
    margin-right: 5px;
    color: var(--accent);
    font-size: 9px;
    vertical-align: middle;
  }
  .conv-meta {
    font-size: 11.5px;
    color: var(--text-3);
  }
  .conv-actions {
    display: none;
    padding-right: 4px;
  }
  .conv-item:hover .conv-actions, .conv-item:focus-within .conv-actions {
    display: flex;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--text-3);
    cursor: pointer;
  }
  .icon-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .conv-empty {
    padding: 16px 8px;
    font-size: 13px;
    text-align: center;
  }
  .conv-foot {
    margin: 0;
    padding: 0 6px;
    font-size: 11px;
  }
  .chat-top {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .chat-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .chat-msg.error .msg-content {
    color: var(--err);
  }
  @media (max-width: 900px) {
    .chat-shell {
      grid-template-columns: minmax(0, 1fr);
    }
    .conv-panel {
      max-height: 40vh;
    }
  }
</style>
