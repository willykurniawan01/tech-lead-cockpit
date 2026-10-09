<script lang="ts">
  import Icon from './Icon.svelte';
  import { toasts } from './toast.svelte';
  import { agents, isLive } from '../lib/agents/client';
  import type { AgentTask, AgentTaskEvent } from '../lib/agents/types';

  let {
    taskId,
    task: initialTask,
    autoPoll = true,
    compact = false,
  }: {
    taskId: string;
    task?: AgentTask;
    autoPoll?: boolean;
    compact?: boolean;
  } = $props();

  let loadedTask = $state<AgentTask | null>(null);
  const task = $derived(loadedTask ?? initialTask ?? null);
  let events = $state<AgentTaskEvent[]>([]);
  let coderRun = $state<any>(null);
  let loading = $state(true);
  let error = $state('');

  async function load() {
    try {
      const res = await agents.get(taskId);
      loadedTask = res.task;
      events = res.events ?? [];
      coderRun = (res as any).coderRun ?? null;
      error = '';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void taskId;
    loading = true;
    void load();
  });

  // Auto-poll while task is live
  $effect(() => {
    if (!autoPoll || !task || !isLive(task)) return;
    const interval = setInterval(load, 2500);
    return () => clearInterval(interval);
  });

  function formatTime(ts?: string): string {
    if (!ts) return '';
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function parseData(data?: string): { summary: string; detail?: string } {
    if (!data) return { summary: '' };
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed === 'string') return { summary: parsed };
      if (parsed && typeof parsed === 'object') {
        const text = parsed.text || parsed.message || parsed.content || parsed.summary || parsed.error;
        if (typeof text === 'string') {
          return { summary: text, detail: JSON.stringify(parsed, null, 2) };
        }
        return { summary: JSON.stringify(parsed), detail: JSON.stringify(parsed, null, 2) };
      }
      return { summary: String(parsed) };
    } catch {
      return { summary: data };
    }
  }

  function eventBadge(evName: string): { label: string; tone: string } {
    const name = evName.toLowerCase();
    if (name.includes('error') || name.includes('fail')) return { label: 'error', tone: 'err' };
    if (name.includes('tool')) return { label: 'tool', tone: 'accent' };
    if (name.includes('approval')) return { label: 'approval', tone: 'warn' };
    if (name.includes('steer')) return { label: 'steer', tone: 'accent' };
    if (name.includes('progress')) return { label: 'progress', tone: 'ok' };
    if (name.includes('text') || name.includes('message')) return { label: 'pesan', tone: 'text' };
    if (name.includes('dispatch') || name.includes('run')) return { label: 'system', tone: 'muted' };
    return { label: evName.replace(/^local\./, ''), tone: 'muted' };
  }

  async function copyLogs() {
    if (!events.length) return;
    const lines = events.map((e) => {
      const t = formatTime(e.at);
      const parsed = parseData(e.data);
      return `[${t}] [${e.event}] ${parsed.summary}${parsed.detail && parsed.detail !== parsed.summary ? `\n${parsed.detail}` : ''}`;
    });
    if (task) {
      lines.unshift(`=== Log Agent Task: ${task.title} (${task.status}) ===\nID: ${task.id}\nPrompt: ${task.prompt}\n`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toasts.show('Log progress disalin ke clipboard.', 'ok');
    } catch {
      toasts.show('Gagal menyalin log.', 'err');
    }
  }
</script>

<div class="agent-log-viewer" class:compact>
  <div class="log-toolbar">
    <div class="status-summary">
      <span class="pulse-indicator" class:active={task && isLive(task)}></span>
      <strong>{events.length} event</strong>
      {#if task?.progress?.percent !== undefined}
        <span class="pct">· {task.progress.percent}%</span>
      {/if}
      {#if task?.progress?.message}
        <span class="msg muted" title={task.progress.message}>· {task.progress.message}</span>
      {/if}
    </div>
    <div class="toolbar-actions">
      <button class="btn btn-ghost btn-sm" onclick={copyLogs} disabled={!events.length} title="Salin semua log ke clipboard">
        <Icon name="copy" size={13} /> Salin
      </button>
      <button class="btn btn-ghost btn-sm" onclick={load} disabled={loading} title="Muat ulang log sekarang">
        <Icon name="refresh" size={13} /> Refresh
      </button>
    </div>
  </div>

  {#if task?.progress?.percent !== undefined}
    <div class="progress-bar">
      <div class="progress-fill" style:width="{Math.max(0, Math.min(100, task.progress.percent))}%"></div>
    </div>
  {/if}

  {#if task?.error}
    <div class="error-banner">
      <Icon name="alert" size={14} />
      <span>{task.error}</span>
    </div>
  {/if}

  {#if loading && !events.length}
    <p class="muted log-empty">Memuat log progress…</p>
  {:else if error}
    <p class="err log-empty">{error}</p>
  {:else if !events.length}
    <p class="muted log-empty">Belum ada aktivitas log untuk task ini.</p>
  {:else}
    <ol class="log-stream mono">
      {#each events as e, i (e.at + ':' + i)}
        {@const badge = eventBadge(e.event)}
        {@const parsed = parseData(e.data)}
        <li class="log-item tone-{badge.tone}">
          <span class="time">{formatTime(e.at)}</span>
          <span class="badge badge-{badge.tone}">{badge.label}</span>
          <span class="content">
            {parsed.summary || e.event}
            {#if parsed.detail && parsed.detail !== parsed.summary}
              <details class="log-detail">
                <summary>detail</summary>
                <pre>{parsed.detail}</pre>
              </details>
            {/if}
          </span>
        </li>
      {/each}
    </ol>
  {/if}

  {#if coderRun?.test}
    <details class="extra-block">
      <summary class="small">Output test ({coderRun.test.command}, exit {coderRun.test.exitCode})</summary>
      <pre class="out">{coderRun.test.output}</pre>
    </details>
  {/if}

  {#if coderRun?.reply}
    <details class="extra-block">
      <summary class="small">Ringkasan dari agent</summary>
      <pre class="out">{coderRun.reply}</pre>
    </details>
  {/if}

  {#if task?.prompt}
    <details class="extra-block">
      <summary class="small">Prompt task</summary>
      <pre class="out">{task.prompt}</pre>
    </details>
  {/if}
</div>

<style>
  .agent-log-viewer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
    padding: 12px;
    margin-top: 10px;
    font-size: 12px;
  }
  .log-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    font-size: 12px;
  }
  .status-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pulse-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-3, #888);
  }
  .pulse-indicator.active {
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
    animation: pulse 1.5s infinite ease-in-out;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
  }
  .pct {
    font-weight: 600;
    color: var(--accent);
  }
  .toolbar-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .progress-bar {
    height: 4px;
    background: var(--surface-2);
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
  }
  .error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 6px;
    background: rgba(239, 68, 68, 0.1);
    color: var(--err);
    font-size: 12px;
  }
  .log-stream {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 280px;
    overflow-y: auto;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: var(--font-mono);
  }
  .log-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 11.5px;
    line-height: 1.4;
    word-break: break-word;
  }
  .time {
    color: var(--text-3);
    flex-shrink: 0;
    font-size: 11px;
  }
  .badge {
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    text-transform: uppercase;
    font-weight: 600;
    flex-shrink: 0;
  }
  .badge-accent { background: rgba(59, 130, 246, 0.15); color: var(--accent); }
  .badge-err { background: rgba(239, 68, 68, 0.15); color: var(--err); }
  .badge-warn { background: rgba(245, 158, 11, 0.15); color: var(--warn); }
  .badge-ok { background: rgba(16, 185, 129, 0.15); color: var(--ok); }
  .badge-text { background: var(--surface-1); color: var(--text-1); }
  .badge-muted { background: var(--surface-1); color: var(--text-3); }
  .content {
    flex-grow: 1;
    color: var(--text-1);
  }
  .log-detail summary {
    cursor: pointer;
    color: var(--accent);
    font-size: 10.5px;
  }
  .log-detail pre {
    margin: 4px 0 0;
    padding: 6px;
    background: var(--surface-1);
    border-radius: 4px;
    font-size: 10.5px;
    white-space: pre-wrap;
    max-height: 150px;
    overflow-y: auto;
  }
  .extra-block {
    margin-top: 4px;
  }
  .extra-block summary {
    cursor: pointer;
    color: var(--text-2);
  }
  .extra-block pre {
    margin: 4px 0 0;
    padding: 8px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 11px;
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
  }
  .log-empty {
    padding: 16px;
    text-align: center;
    margin: 0;
  }
</style>
