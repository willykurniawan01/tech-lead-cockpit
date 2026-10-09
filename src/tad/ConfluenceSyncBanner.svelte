<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { connector } from '../lib/confluence/client';
  import ConfluenceMergeModal from './ConfluenceMergeModal.svelte';
  import type { Draft } from './drafts.svelte';

  /**
   * Notices edits made directly in Confluence: compares the page's current version with the one
   * the draft is based on (on open, on window focus, and every few minutes) and offers a merge.
   */
  let { draft }: { draft: Draft } = $props();

  const POLL_MS = 120_000;
  let remote = $state<{ version: number; by?: string; when?: string } | null>(null);
  let mergeOpen = $state(false);
  let dismissedAt = $state(0);

  const pageId = $derived(draft.confluence.pageId);
  const base = $derived(draft.confluence.version ?? 0);
  const behind = $derived(Boolean(remote && remote.version > base && remote.version !== dismissedAt));

  async function check(id: string | undefined) {
    if (!id) {
      remote = null;
      return;
    }
    try {
      const r = await connector.pageVersion(id);
      if (id === draft.confluence.pageId) remote = r;
    } catch {
      /* offline / VPN: try again later */
    }
  }

  $effect(() => {
    const id = pageId;
    remote = null;
    dismissedAt = 0;
    void check(id);
    const timer = setInterval(() => void check(id), POLL_MS);
    const onFocus = () => void check(id);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  });

  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '');
</script>

{#if behind && remote}
  <div class="banner" role="status">
    <Icon name="alert" size={15} />
    <span>
      <strong>Confluence sudah diubah</strong> (v{remote.version}{remote.by ? ` oleh ${remote.by}` : ''}{remote.when ? `, ${fmt(remote.when)}` : ''}), sedangkan draft ini berbasis v{base || '?'}. Gabungkan dulu sebelum publish agar perubahan di Confluence tidak tertimpa.
    </span>
    <button class="btn btn-primary btn-sm" onclick={() => (mergeOpen = true)}>Lihat & gabungkan</button>
    <button class="btn btn-ghost btn-sm" onclick={() => (dismissedAt = remote?.version ?? 0)} aria-label="Sembunyikan">Nanti</button>
  </div>
{/if}

<ConfluenceMergeModal bind:open={mergeOpen} {draft} onmerged={() => void check(pageId)} />

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 16px 0;
    padding: 8px 12px;
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    font-size: 12.5px;
  }
  .banner span {
    flex: 1;
  }
</style>
