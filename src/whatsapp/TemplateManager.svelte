<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { wa } from '../lib/whatsapp/client';
  import { AUDIENCES, templateVariables, type WaAudience, type WaTemplate } from '../lib/whatsapp/types';

  let {
    open = $bindable(false),
    templates,
    onsaved,
  }: {
    open: boolean;
    templates: WaTemplate[];
    onsaved: (templates: WaTemplate[]) => void;
  } = $props();

  let list = $state<WaTemplate[]>([]);
  let selectedId = $state('');
  let saving = $state(false);

  // Edit a copy; nothing changes until "Simpan".
  $effect(() => {
    if (!open) return;
    untrack(() => {
      list = templates.map((t) => ({ ...t }));
      selectedId = list[0]?.id ?? '';
    });
  });

  const selected = $derived(list.find((t) => t.id === selectedId));
  const dirty = $derived(JSON.stringify(list) !== JSON.stringify(templates));

  function add(audience: WaAudience) {
    const t: WaTemplate = { id: `custom-${Date.now().toString(36)}`, name: 'Template baru', audience, body: 'Halo {{nama}}, ' };
    list = [...list, t];
    selectedId = t.id;
  }

  async function remove(id: string) {
    const t = list.find((x) => x.id === id);
    if (!t) return;
    const ok = await confirmDialog({
      title: 'Hapus Template',
      message: `Hapus template "${t.name}"?`,
      confirmText: 'Hapus Template',
      danger: true,
    });
    if (!ok) return;
    list = list.filter((x) => x.id !== id);
    selectedId = list[0]?.id ?? '';
  }

  function update(patch: Partial<WaTemplate>) {
    list = list.map((t) => (t.id === selectedId ? { ...t, ...patch } : t));
  }

  async function save() {
    if (list.some((t) => !t.name.trim() || !t.body.trim())) {
      toasts.show('Nama dan isi template tidak boleh kosong.', 'err');
      return;
    }
    saving = true;
    try {
      const saved = await wa.saveTemplates(list);
      onsaved(saved);
      toasts.show('Template disimpan.', 'ok');
      open = false;
    } catch (e) {
      toasts.show((e as Error).message, 'err', 6000);
    } finally {
      saving = false;
    }
  }
</script>

<Modal bind:open title="Template pesan" subtitle={'Gunakan {{variabel}} untuk bagian yang diisi saat membalas, mis. {{nama}} atau {{task}}.'} width={900} height={580}>
  <div class="grid">
    <div class="groups">
      {#each AUDIENCES as a (a.id)}
        <div class="group">
          <div class="group-head">
            <span>{a.label}</span>
            <button class="btn btn-ghost btn-sm" onclick={() => add(a.id)} aria-label={`Tambah template ${a.label}`}><Icon name="plus" size={13} /></button>
          </div>
          {#each list.filter((t) => t.audience === a.id) as t (t.id)}
            <button class="item" class:active={t.id === selectedId} onclick={() => (selectedId = t.id)}>{t.name}</button>
          {:else}
            <p class="muted small">Belum ada template.</p>
          {/each}
        </div>
      {/each}
    </div>

    {#if selected}
      <div class="editor">
        <label class="field">
          <span>Nama</span>
          <input class="input" value={selected.name} oninput={(e) => update({ name: e.currentTarget.value })} maxlength="120" />
        </label>
        <label class="field">
          <span>Untuk</span>
          <select class="input" value={selected.audience} onchange={(e) => update({ audience: e.currentTarget.value as WaAudience })}>
            {#each AUDIENCES as a (a.id)}<option value={a.id}>{a.label}</option>{/each}
          </select>
        </label>
        <label class="field grow">
          <span>Isi pesan</span>
          <textarea class="input" rows="8" value={selected.body} oninput={(e) => update({ body: e.currentTarget.value })} maxlength="4096"></textarea>
          <small>Variabel: {templateVariables(selected.body).map((v) => `{{${v}}}`).join(', ') || 'tidak ada'}. Format WhatsApp: *tebal*, _miring_, ~coret~.</small>
        </label>
        <button class="btn btn-danger btn-sm" onclick={() => remove(selected.id)}><Icon name="trash" size={13} /> Hapus template ini</button>
      </div>
    {:else}
      <p class="muted">Pilih atau tambah template.</p>
    {/if}
  </div>

  {#snippet footer()}
    <span class="muted small" style="flex:1">Disimpan lokal di ~/.tech-lead-cockpit/wa-templates.json</span>
    <button class="btn" onclick={() => (open = false)}>Batal</button>
    <button class="btn btn-primary" onclick={save} disabled={!dirty || saving}>{saving ? 'Menyimpan…' : 'Simpan'}</button>
  {/snippet}
</Modal>

<style>
  .grid {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 18px;
    min-height: 380px;
  }
  @media (max-width: 700px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  .groups {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
    margin-bottom: 4px;
  }
  .item {
    display: block;
    width: 100%;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
    cursor: pointer;
    font-size: 13px;
  }
  .item:hover {
    background: var(--surface-hover);
  }
  .item.active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .editor .btn {
    align-self: flex-start;
  }
  .small {
    font-size: 12px;
    margin: 0;
  }
</style>
