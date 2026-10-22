<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { qa } from '../lib/qa/client';
  import { handleConflict } from '../lib/qa/conflict';
  import type { QASuite, QASuiteChange, QASuiteReview } from '../lib/qa/types';

  /**
   * Test case changes wait in a local draft; this banner and dialog show them (added, changed,
   * removed, per field and step) and send or throw away all or some of them.
   */
  let {
    projectId,
    projectName,
    suite = $bindable(),
    onreload,
  }: {
    projectId: string;
    projectName: string;
    suite: QASuite | null;
    onreload: () => Promise<unknown> | unknown;
  } = $props();

  let open = $state(false);
  let loading = $state(false);
  let busy = $state(false);
  let review = $state<QASuiteReview | null>(null);
  let picked = $state(new Set<string>());
  let expanded = $state(new Set<string>());

  const pending = $derived(suite?.draft?.changes ?? 0);
  const conflicts = $derived(new Set(review?.conflicts ?? []));
  const sendable = $derived([...picked].filter((k) => !conflicts.has(k)));

  const KIND_LABEL: Record<QASuiteChange['kind'], string> = { added: 'Baru', changed: 'Diubah', removed: 'Dihapus' };

  async function openReview() {
    open = true;
    loading = true;
    try {
      review = await qa.reviewSuite(projectId);
      picked = new Set(review.changes.map((c) => c.key).filter((k) => !review!.conflicts.includes(k)));
      expanded = new Set();
      if (!review.changes.length) {
        open = false;
        await onreload();
        toasts.show('Tidak ada perubahan yang menunggu dikirim.', 'info', 3000);
      }
    } catch (e) {
      open = false;
      toasts.show(`Review: ${(e as Error).message}`, 'err');
    } finally {
      loading = false;
    }
  }

  function toggle(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  function toggleAll() {
    const all = (review?.changes ?? []).map((c) => c.key).filter((k) => !conflicts.has(k));
    picked = picked.size === all.length ? new Set() : new Set(all);
  }

  async function send() {
    if (!review || !sendable.length) return;
    const ok = await confirmDialog({
      title: 'Kirim ke Confluence?',
      message: `${sendable.length} perubahan test case ${projectName} akan disimpan ke Workspace QA dan langsung terlihat oleh Tech Lead dan QA lain.${sendable.length < review.changes.length ? ` ${review.changes.length - sendable.length} perubahan lain tetap di draft.` : ''}`,
      confirmText: 'Kirim',
    });
    if (!ok) return;
    busy = true;
    try {
      const all = sendable.length === review.changes.length;
      const r = await qa.publishSuite(projectId, projectName, all ? undefined : sendable);
      suite = r.suite;
      toasts.show(`${r.sent} perubahan terkirim ke Confluence.`, 'ok', 3000);
      if (suite?.draft?.changes) await openReview();
      else open = false;
    } catch (e) {
      if (await handleConflict(e, openReview)) return;
      toasts.show(`Kirim: ${(e as Error).message}`, 'err');
    } finally {
      busy = false;
    }
  }

  async function discard(keys?: string[]) {
    const n = keys?.length ?? review?.changes.length ?? pending;
    const ok = await confirmDialog({
      title: 'Buang perubahan?',
      message: `${n} perubahan di laptop ini dibuang dan test case kembali seperti di Confluence. Tidak bisa dibatalkan.`,
      confirmText: 'Buang',
      danger: true,
    });
    if (!ok) return;
    busy = true;
    try {
      suite = await qa.discardSuite(projectId, keys);
      if (suite?.draft?.changes) await openReview();
      else open = false;
      toasts.show(`${n} perubahan dibuang.`, 'info', 3000);
    } catch (e) {
      toasts.show(`Buang: ${(e as Error).message}`, 'err');
    } finally {
      busy = false;
    }
  }

  const json = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2));
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
</script>

{#if pending}
  <div class="draft-banner" class:behind={suite?.draft?.behind}>
    <Icon name={suite?.draft?.behind ? 'alert' : 'upload'} size={14} />
    <span>
      <b>{pending} perubahan test case belum dikirim</b> ke Confluence{suite?.draft?.behind ? ', dan sebagian bentrok dengan perubahan orang lain' : ''}. Hanya terlihat di laptop ini sampai direview dan dikirim.
    </span>
    <button class="btn btn-sm btn-primary" onclick={openReview}><Icon name="eye" size={13} /> Review & kirim</button>
  </div>
{/if}

<Modal bind:open title="Review perubahan test case" subtitle={`${projectName}: periksa perubahan sebelum dikirim ke Workspace QA di Confluence.`} width={900}>
  {#if loading && !review}
    <p class="muted">Memuat perubahan…</p>
  {:else if review}
    {#if review.published}
      <p class="note" class:warn={review.conflicts.length}>
        Confluence sudah diubah{review.published.updatedBy ? ` oleh ${review.published.updatedBy}` : ''}{review.published.updatedAt ? ` pada ${when(review.published.updatedAt)}` : ''} setelah draft ini dibuat.
        {#if review.conflicts.length}
          {review.conflicts.length} test case di bawah juga diubah di sana: buang perubahanmu untuk test case itu, lalu ulangi bila masih perlu.
        {/if}
      </p>
    {/if}
    <div class="list-head">
      <label class="check"><input type="checkbox" checked={picked.size > 0 && picked.size === review.changes.length - review.conflicts.length} onchange={toggleAll} /> Pilih semua</label>
      <span class="muted small">{review.changes.length} perubahan sejak {when(review.startedAt)}</span>
    </div>
    <ul class="changes">
      {#each review.changes as c (c.key)}
        <li class:conflict={conflicts.has(c.key)}>
          <div class="row">
            <input type="checkbox" checked={picked.has(c.key)} disabled={conflicts.has(c.key)} onchange={() => (picked = toggle(picked, c.key))} aria-label={`Pilih ${c.title}`} />
            <span class="chip kind-{c.kind}">{KIND_LABEL[c.kind]}</span>
            <span class="title">{c.title}</span>
            {#if c.group}<span class="chip">{c.group}</span>{/if}
            {#if conflicts.has(c.key)}<span class="chip chip-warn">bentrok</span>{/if}
            <span class="grow"></span>
            <button class="btn btn-sm btn-ghost" onclick={() => (expanded = toggle(expanded, c.key))}>{expanded.has(c.key) ? 'Tutup' : 'Detail'}</button>
            <button class="btn btn-sm btn-ghost" title="Buang perubahan ini saja" onclick={() => discard([c.key])} disabled={busy}><Icon name="undo" size={13} /></button>
          </div>
          {#if c.details.length}
            <ul class="details">
              {#each c.details as d, i (i)}<li>{d}</li>{/each}
            </ul>
          {/if}
          {#if expanded.has(c.key)}
            <div class="compare">
              <div>
                <span class="muted small">Di Confluence</span>
                <pre>{json(c.before) || '(belum ada)'}</pre>
              </div>
              <div>
                <span class="muted small">Draft di laptop ini</span>
                <pre>{json(c.after) || '(dihapus)'}</pre>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#snippet footer()}
    <button class="btn btn-danger btn-sm" onclick={() => discard()} disabled={busy || !review?.changes.length}><Icon name="trash" size={13} /> Buang semua</button>
    <span class="grow"></span>
    <button class="btn btn-sm" onclick={() => (open = false)}>Tutup</button>
    <button class="btn btn-primary btn-sm" onclick={send} disabled={busy || !sendable.length}>
      <Icon name="send" size={13} /> {busy ? 'Mengirim…' : `Kirim ${sendable.length} perubahan`}
    </button>
  {/snippet}
</Modal>

<style>
  .draft-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: var(--radius);
    background: var(--accent-soft);
    font-size: 13px;
  }
  .draft-banner > span {
    flex: 1;
  }
  .draft-banner.behind {
    background: var(--warn-soft);
  }
  .note {
    margin: 0 0 12px;
    padding: 8px 12px;
    border-radius: var(--radius);
    background: var(--accent-soft);
    font-size: 13px;
  }
  .note.warn {
    background: var(--warn-soft);
  }
  .list-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .changes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .changes > li {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
  }
  .changes > li.conflict {
    border-color: var(--warn);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grow {
    flex: 1;
  }
  .kind-added {
    color: var(--ok);
  }
  .kind-removed {
    color: var(--err);
  }
  .details {
    margin: 6px 0 0 30px;
    padding: 0;
    font-size: 12.5px;
    color: var(--text-2);
  }
  .compare {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 8px;
  }
  .compare pre {
    margin: 4px 0 0;
    max-height: 320px;
    overflow: auto;
    font-size: 11.5px;
    padding: 8px;
    border-radius: var(--radius);
    background: var(--surface-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
  @media (max-width: 720px) {
    .compare {
      grid-template-columns: 1fr;
    }
  }
</style>
