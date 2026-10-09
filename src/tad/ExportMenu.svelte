<script lang="ts">
  import Icon, { type IconName } from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { toConfluenceStorage } from '../lib/confluence/storage';
  import { copyForConfluence, diagramPngs, downloadBlob, downloadText, fileSlug } from './export';
  import type { Draft } from './drafts.svelte';

  let { draft, title }: { draft: Draft; title: string } = $props();

  let open = $state(false);
  let busy = $state(false);
  let root: HTMLElement | undefined = $state();

  $effect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (open = false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  });

  async function run(task: () => Promise<string | void>) {
    open = false;
    busy = true;
    try {
      const msg = await task();
      if (msg) toasts.show(msg, 'ok');
    } catch (e) {
      toasts.show(`Gagal: ${e instanceof Error ? e.message : String(e)}`, 'err', 6000);
    } finally {
      busy = false;
    }
  }

  const items: { icon: IconName; label: string; hint: string; action: () => Promise<string | void> }[] = [
    {
      icon: 'copy',
      label: 'Salin untuk Confluence',
      hint: 'Rich text — paste langsung ke editor Confluence',
      action: async () => {
        await copyForConfluence(draft.markdown);
        return 'Tersalin. Paste ke halaman Confluence (Cmd+V).';
      },
    },
    {
      icon: 'download',
      label: 'Markdown (.md)',
      hint: 'Sumber TAD apa adanya',
      action: async () => downloadText(`${fileSlug(title)}.md`, draft.markdown, 'text/markdown'),
    },
    {
      icon: 'download',
      label: 'Confluence storage (.xml)',
      hint: 'Format native Confluence untuk API/import',
      action: async () => downloadText(`${fileSlug(title)}.confluence.xml`, toConfluenceStorage(draft.markdown, draft.storageOptions).xhtml, 'application/xml'),
    },
    {
      icon: 'download',
      label: 'Diagram (PNG)',
      hint: 'Semua diagram Mermaid sebagai gambar',
      action: async () => {
        const { diagrams } = toConfluenceStorage(draft.markdown, draft.storageOptions);
        if (!diagrams.length) return 'Tidak ada diagram Mermaid di dokumen ini.';
        for (const p of await diagramPngs(diagrams)) downloadBlob(`${fileSlug(title)}-${p.filename}`, p.blob);
        return `${diagrams.length} diagram diunduh.`;
      },
    },
  ];
</script>

<div class="menu" bind:this={root}>
  <button class="btn" onclick={() => (open = !open)} aria-haspopup="menu" aria-expanded={open} disabled={busy}>
    <Icon name="download" /> {busy ? 'Memproses…' : 'Export'} <Icon name="chevron" size={14} />
  </button>
  {#if open}
    <div class="popover" role="menu">
      {#each items as item (item.label)}
        <button role="menuitem" onclick={() => run(item.action)}>
          <Icon name={item.icon} />
          <span>
            <strong>{item.label}</strong>
            <small>{item.hint}</small>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu {
    position: relative;
  }
  .popover {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 20;
    width: 300px;
    padding: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow-lg);
  }
  .popover button {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .popover button:hover {
    background: var(--surface-hover);
  }
  .popover :global(svg) {
    margin-top: 2px;
    color: var(--text-3);
  }
  strong {
    display: block;
    font-weight: 500;
  }
  small {
    color: var(--text-3);
    font-size: 12px;
  }
</style>
