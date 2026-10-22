<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { qa } from '../lib/qa/client';
  import type { QARun } from '../lib/qa/types';
  import { openExternal } from '../lib/open-external';

  /** Sends a finished run to Confluence as a readable evidence page, or opens the one sent. */
  let { projectId, run = $bindable() }: { projectId: string; run: QARun } = $props();

  let sending = $state(false);

  async function send() {
    const again = Boolean(run.evidence);
    const ok = await confirmDialog({
      title: again ? 'Perbarui evidence?' : 'Kirim evidence ke Confluence?',
      message: again
        ? 'Halaman evidence run ini di Confluence diganti dengan isi terbaru.'
        : `Halaman evidence (ringkasan, ${run.flows.length} test case, request dan response tiap step, plus lampiran JSON run) dibuat di bawah halaman Run proyek di Workspace QA dan terlihat oleh semua yang punya akses. Token dan password sudah disamarkan.`,
      confirmText: again ? 'Perbarui' : 'Kirim',
    });
    if (!ok) return;
    sending = true;
    try {
      const evidence = await qa.publishEvidence(projectId, run.id);
      run.evidence = evidence;
      toasts.show(again ? 'Evidence diperbarui.' : 'Evidence terkirim ke Confluence.', 'ok', 3000);
    } catch (e) {
      toasts.show(`Evidence: ${(e as Error).message}`, 'err');
    } finally {
      sending = false;
    }
  }
</script>

{#if run.evidence?.url}
  <button class="btn btn-sm" onclick={() => openExternal(run.evidence!.url!)} title={run.evidence.title ?? 'Evidence di Confluence'}><Icon name="confluence" size={13} /> Lihat evidence</button>
  <button class="btn btn-sm btn-ghost" onclick={send} disabled={sending} title="Kirim ulang evidence run ini (halaman yang sama diperbarui)" aria-label="Perbarui evidence"><Icon name="refresh" size={13} /></button>
{:else}
  <button class="btn btn-sm" onclick={send} disabled={sending} title="Buat halaman evidence run ini di Confluence (Workspace QA)">
    <Icon name="confluence" size={13} /> {sending ? 'Mengirim…' : 'Kirim evidence'}
  </button>
{/if}
