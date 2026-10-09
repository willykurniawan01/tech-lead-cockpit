<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { drafts, type Draft } from './drafts.svelte';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import PreviewPane from './PreviewPane.svelte';

  let {
    draft,
    busy,
    onbrainstorm,
    onapprove,
  }: {
    draft: Draft;
    /** An AI job is running for this draft. */
    busy: boolean;
    onbrainstorm: () => void;
    onapprove: () => void;
  } = $props();

  let editing = $state(false);
  const plan = $derived(draft.scopePlan ?? '');
  const agreed = $derived(draft.scopeStatus === 'agreed');
  // Rough size of the plan, to show the reviewer what they are approving.
  const taskCount = $derived((plan.match(/^\|\s*\d+\s*\|\s*\[(BACKEND|MOBILE-FE|WEB-FE)\]/gm) ?? []).length);
  const openQuestions = $derived.by(() => {
    const m = plan.match(/##\s*Pertanyaan Terbuka\s*\n([\s\S]*?)(\n##\s|$)/i);
    return m ? (m[1].match(/^\s*(?:[-*]|\d+\.)\s+\S/gm) ?? []).length : 0;
  });

  function reopen() {
    drafts.update(draft.id, { scopeStatus: 'draft' });
  }
</script>

<section class="scope">
  <header class="bar">
    <div class="status">
      {#if agreed}
        <span class="chip chip-ok"><Icon name="check" size={12} /> Disetujui</span>
      {:else if plan}
        <span class="chip chip-warn">Draft, menunggu persetujuan</span>
      {:else}
        <span class="chip">Belum ada rencana</span>
      {/if}
      {#if plan}
        <span class="muted small">{taskCount} usulan task{openQuestions ? ` · ${openQuestions} pertanyaan terbuka` : ''}</span>
      {/if}
    </div>
    <div class="actions">
      {#if plan && !agreed}
        <button class="btn btn-sm" onclick={() => (editing = !editing)}>
          <Icon name={editing ? 'eye' : 'edit'} size={13} /> {editing ? 'Pratinjau' : 'Edit manual'}
        </button>
      {/if}
      {#if agreed}
        <button class="btn btn-sm" onclick={reopen} disabled={busy}>Buka lagi untuk diskusi</button>
      {:else}
        <button class="btn btn-sm" onclick={onbrainstorm} disabled={busy}>
          <Icon name="sparkles" size={13} /> {plan ? 'Diskusikan di chat' : 'Mulai brainstorming'}
        </button>
        <button class="btn btn-sm btn-primary" onclick={onapprove} disabled={busy || !plan.trim()}>
          <Icon name="check" size={13} /> Setujui scope & generate TAD
        </button>
      {/if}
    </div>
  </header>

  {#if openQuestions && !agreed}
    <p class="hint">Masih ada {openQuestions} pertanyaan terbuka. Jawab di chat (mode Brainstorm) supaya AI memperbarui rencana sebelum TAD ditulis.</p>
  {/if}

  <div class="body">
    {#if !plan}
      <div class="empty">
        <Icon name="list" size={28} />
        <p>Brainstorming membuat AI menyusun <strong>rencana scope</strong> ringkas lebih dulu: service terdampak beserta buktinya di codebase, usulan task, keputusan desain, dan pertanyaan terbuka.</p>
        <p class="muted">Diskusikan dan setujui rencananya, baru AI menulis TAD lengkap. Lebih hemat dan hasilnya sesuai keinginanmu.</p>
      </div>
    {:else if editing && !agreed}
      <MarkdownEditor value={plan} onchange={(v) => drafts.update(draft.id, { scopePlan: v })} onsave={() => drafts.saveNow()} />
    {:else}
      <PreviewPane markdown={plan} />
    {/if}
  </div>
</section>

<style>
  .scope {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .status,
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .small {
    font-size: 12.5px;
  }
  .hint {
    margin: 0;
    padding: 6px 14px;
    background: var(--warn-soft);
    color: var(--warn);
    font-size: 12.5px;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .empty {
    max-width: 520px;
    margin: 12vh auto 0;
    padding: 0 24px;
    text-align: center;
    color: var(--text-2);
    line-height: 1.6;
  }
</style>
