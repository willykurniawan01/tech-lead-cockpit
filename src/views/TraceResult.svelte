<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { renderPreview } from '../lib/markdown/preview';
  import { renderMermaid } from '../lib/markdown/mermaid';
  import { bugs } from '../lib/bugs/client';
  import { traces } from '../lib/trace/client';
  import { FINDING_LABELS, type Trace, type TraceFinding, type TraceTurn } from '../lib/trace/types';

  let { traceId, onchange }: { traceId: string; onchange?: () => void } = $props();

  const POLL_MS = 3_000;
  let trace = $state<Trace | null>(null);
  let error = $state('');
  let followUp = $state('');
  let asking = $state(false);
  let diagrams = $state<Record<string, string>>({});

  const running = $derived(trace?.turns.some((t) => t.status === 'running') ?? false);
  const CONFIDENCE: Record<string, string> = { high: 'Yakin', medium: 'Cukup yakin', low: 'Kurang yakin' };

  async function load() {
    try {
      trace = await traces.get(traceId);
      error = '';
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    void traceId;
    void load();
  });

  // Poll while a question is being traced; tell the list when it finishes.
  $effect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      await load();
      if (!trace?.turns.some((x) => x.status === 'running')) onchange?.();
    }, POLL_MS);
    return () => clearInterval(t);
  });

  // Render each answer's diagram once.
  $effect(() => {
    for (const turn of trace?.turns ?? []) {
      if (!turn.diagram || turn.id in diagrams) continue;
      diagrams[turn.id] = '';
      renderMermaid(turn.diagram)
        .then((svg) => (diagrams[turn.id] = svg))
        .catch(() => (diagrams[turn.id] = 'error'));
    }
  });

  async function ask() {
    const q = followUp.trim();
    const last = trace?.turns.at(-1);
    if (!q || !trace || !last) return;
    asking = true;
    try {
      trace = await traces.ask(q, last.ai, trace.id);
      followUp = '';
      onchange?.();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      asking = false;
    }
  }

  async function cancel() {
    if (!trace) return;
    try {
      trace = await traces.cancel(trace.id);
      setTimeout(() => void load().then(() => onchange?.()), 800);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  /** A finding becomes a Bug Tracing case, prefilled with what the trace found. */
  async function toBug(f: TraceFinding, turn: TraceTurn) {
    const where = f.file ? `\n\nLokasi: ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    try {
      const c = await bugs.create({ title: f.title.slice(0, 200), description: `${f.detail}${where}\n\nDitemukan saat trace: "${turn.question.slice(0, 300)}"` });
      location.hash = `#/bugs/${c.id}`;
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  const fmt = (ts?: string) => (ts ? new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '');
</script>

<div class="trace">
  {#if error}
    <p class="err small">{error}</p>
  {:else if !trace}
    <p class="muted small">Memuat hasil trace…</p>
  {:else}
    {#each trace.turns as turn, i (turn.id)}
      <section class="turn">
        <div class="q">
          <Icon name="search" size={13} />
          <strong>{i ? 'Lanjutan: ' : ''}{turn.question}</strong>
          <span class="muted small">{turn.ai.provider}{turn.ai.model ? ` / ${turn.ai.model}` : ''} · {fmt(turn.askedAt)}</span>
        </div>

        {#if turn.status === 'running'}
          <div class="banner">
            <span class="spinner" aria-hidden="true"></span>
            <span>Menelusuri codebase di background. <span class="muted">{turn.progress ?? ''}</span></span>
            <button class="btn btn-sm" onclick={cancel}>Batalkan</button>
          </div>
        {:else if turn.status === 'error' || turn.status === 'cancelled'}
          <p class="err small">{turn.error ?? 'Gagal.'}</p>
          {#if turn.rawReply}<details><summary class="small">Jawaban mentah AI</summary><pre class="code">{turn.rawReply}</pre></details>{/if}
        {:else}
          <div class="meta">
            {#if turn.confidence}<span class="chip conf-{turn.confidence}">{CONFIDENCE[turn.confidence]}</span>{/if}
            {#each turn.versions ?? [] as v (v.repo)}<span class="chip mono" title="Kode yang ditelusuri">{v.repo} · {v.branch}@{v.commit}</span>{/each}
          </div>
          {#if turn.touchedRepos?.length}
            <p class="err small">Peringatan: working tree berubah selama trace di {turn.touchedRepos.join(', ')}. Periksa repo tersebut.</p>
          {/if}
          <div class="answer">{@html renderPreview(turn.answer ?? '').html}</div>

          {#if turn.diagram}
            <div class="diagram">
              {#if diagrams[turn.id] && diagrams[turn.id] !== 'error'}
                {@html diagrams[turn.id]}
              {:else}
                <pre class="code">{turn.diagram}</pre>
              {/if}
            </div>
          {/if}

          {#if turn.evidence?.length}
            <h4>Bukti di kode ({turn.evidence.filter((e) => e.verified).length}/{turn.evidence.length} terverifikasi)</h4>
            <ul class="evidence">
              {#each turn.evidence as e, j (j)}
                <li class:unverified={!e.verified}>
                  <div class="ev-head">
                    <span class="chip {e.verified ? 'chip-ok' : 'chip-warn'}" title={e.verified ? 'File dan baris ada di codebase' : 'File/baris tidak ditemukan; jangan dipercaya begitu saja'}>
                      {e.verified ? 'Terverifikasi' : 'Tidak terverifikasi'}
                    </span>
                    <code>{e.file}{e.line ? `:${e.line}` : ''}</code>
                  </div>
                  {#if e.note}<p class="small">{e.note}</p>{/if}
                  {#if e.snippet}<pre class="code">{e.snippet}</pre>{/if}
                </li>
              {/each}
            </ul>
          {/if}

          {#if turn.findings?.length}
            <h4>Temuan</h4>
            <ul class="findings">
              {#each turn.findings as f, j (j)}
                <li>
                  <div class="ev-head">
                    <span class="chip sev-{f.severity}">{FINDING_LABELS[f.kind]} · {f.severity}</span>
                    <strong>{f.title}</strong>
                    {#if f.file}<code class="small">{f.file}{f.line ? `:${f.line}` : ''}</code>{/if}
                    <span class="grow"></span>
                    {#if f.kind === 'bug' || f.kind === 'risk'}
                      <button class="btn btn-sm btn-ghost" onclick={() => toBug(f, turn)} title="Buat kasus di Bug Tracing dari temuan ini"><Icon name="bug" size={12} /> Jadikan bug</button>
                    {/if}
                  </div>
                  {#if f.detail}<p class="small">{f.detail}</p>{/if}
                </li>
              {/each}
            </ul>
          {/if}

          {#if turn.openQuestions?.length}
            <h4>Perlu dikonfirmasi</h4>
            <ul class="small">
              {#each turn.openQuestions as q, j (j)}<li>{q}</li>{/each}
            </ul>
          {/if}
        {/if}
      </section>
    {/each}

    <form
      class="follow"
      onsubmit={(e) => {
        e.preventDefault();
        void ask();
      }}
    >
      <input class="input" bind:value={followUp} disabled={running || asking} placeholder={running ? 'Tunggu jawaban selesai…' : 'Tanya lanjutan, mis. "kalau callback-nya timeout gimana?"'} />
      <button class="btn btn-sm btn-primary" type="submit" disabled={running || asking || !followUp.trim()}><Icon name="send" size={13} /> Tanya</button>
    </form>
  {/if}
</div>

<style>
  .trace {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 6px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .turn {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .turn + .turn {
    padding-top: 12px;
    border-top: 1px dashed var(--border);
  }
  .q {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .meta,
  .ev-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .grow {
    flex: 1;
  }
  .answer {
    font-size: 13px;
    line-height: 1.55;
  }
  .answer :global(p) {
    margin: 0 0 8px;
  }
  .answer :global(pre),
  .code {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    white-space: pre;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .diagram {
    overflow: auto;
    padding: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .diagram :global(svg) {
    max-width: 100%;
    height: auto;
  }
  h4 {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-2);
  }
  .evidence,
  .findings {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .evidence li p,
  .findings li p {
    margin: 4px 0;
  }
  .unverified code {
    text-decoration: line-through;
    opacity: 0.7;
  }
  .conf-high,
  .sev-low {
    color: var(--ok);
  }
  .conf-low,
  .sev-critical,
  .sev-high {
    color: var(--err);
  }
  .conf-medium,
  .sev-medium {
    color: var(--warn);
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    font-size: 12.5px;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .follow {
    display: flex;
    gap: 8px;
  }
  .follow .input {
    flex: 1;
  }
  .err {
    color: var(--err);
  }
  .small {
    font-size: 12px;
  }
</style>
