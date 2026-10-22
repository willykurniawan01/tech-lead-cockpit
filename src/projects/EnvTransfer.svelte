<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { qa } from '../lib/qa/client';
  import { handleConflict } from '../lib/qa/conflict';
  import type { QAEnvImportAction, QAEnvImportPreview, QAEnvironment } from '../lib/qa/types';

  /**
   * Environments to and from a file (between laptops, and between Tech Lead Cockpit and QA
   * Cockpit). Keychain secrets go along encrypted with a passphrase, and back into the Keychain.
   */
  let { environments = $bindable([]) }: { environments: QAEnvironment[] } = $props();

  const MIN_PASSPHRASE = 8;

  // Export
  let exportOpen = $state(false);
  let exportIds = $state(new Set<string>());
  let withSecrets = $state(true);
  let exportPass = $state('');
  let exportPass2 = $state('');
  let exporting = $state(false);
  const exportError = $derived(
    !exportIds.size ? 'Pilih minimal satu environment.' : withSecrets && exportPass.length < MIN_PASSPHRASE ? `Passphrase minimal ${MIN_PASSPHRASE} karakter.` : withSecrets && exportPass !== exportPass2 ? 'Passphrase dan ulangannya belum sama.' : '',
  );

  function openExport() {
    exportIds = new Set(environments.map((e) => e.id));
    withSecrets = true;
    exportPass = '';
    exportPass2 = '';
    exportOpen = true;
  }

  async function doExport() {
    if (exportError) return;
    exporting = true;
    try {
      const all = exportIds.size === environments.length;
      const r = await qa.exportEnvironments(all ? undefined : [...exportIds], withSecrets ? exportPass : undefined);
      exportOpen = false;
      toasts.show(`${r.count} environment di-export${r.withSecrets ? ' beserta rahasia (terenkripsi)' : ''} ke ${r.path}`, 'ok', 8000);
    } catch (e) {
      toasts.show(`Export: ${(e as Error).message}`, 'err');
    } finally {
      exporting = false;
      exportPass = '';
      exportPass2 = '';
    }
  }

  // Import
  let fileInput: HTMLInputElement | undefined = $state();
  let importOpen = $state(false);
  let importFile = $state<unknown>(null);
  let importName = $state('');
  let importPass = $state('');
  let preview = $state<QAEnvImportPreview | null>(null);
  let actions = $state<Record<string, QAEnvImportAction>>({});
  let importing = $state(false);
  const chosen = $derived(Object.values(actions).filter((a) => a !== 'skip').length);

  async function pickFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('File terlalu besar (maks. 4 MB).');
      importFile = JSON.parse(await file.text());
      importName = file.name;
      importPass = '';
      await loadPreview();
      importOpen = true;
    } catch (err) {
      toasts.show(`Import: ${err instanceof SyntaxError ? 'file bukan JSON yang valid.' : (err as Error).message}`, 'err');
    }
  }

  async function loadPreview() {
    preview = await qa.previewEnvironmentImport(importFile, importPass || undefined);
    actions = Object.fromEntries(preview.items.map((i) => [i.id, i.error ? 'skip' : i.match ? 'replace' : 'new']));
  }

  async function unlock() {
    try {
      await loadPreview();
      toasts.show('Rahasia di file terbuka.', 'ok', 2500);
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  async function doImport() {
    if (!preview || !chosen) return;
    const secretsLeft = preview.hasSecrets && !preview.secretsOpened;
    const ok = await confirmDialog({
      title: 'Import environment?',
      message: `${chosen} environment disimpan ke Workspace QA (terlihat oleh semua pemakai)${preview.secretsOpened ? '; rahasianya masuk ke Keychain laptop ini' : ''}.${secretsLeft ? ' Rahasia di file TIDAK ikut karena passphrase belum diisi.' : ''} Environment yang diganti ditimpa isinya.`,
      confirmText: 'Import',
    });
    if (!ok) return;
    importing = true;
    try {
      const r = await qa.importEnvironments(importFile, preview.secretsOpened ? importPass : undefined, actions);
      environments = r.environments;
      importOpen = false;
      toasts.show(`${r.imported} environment di-import${r.skipped ? `, ${r.skipped} dilewati` : ''}.`, 'ok', 4000);
    } catch (e) {
      if (await handleConflict(e, loadPreview)) return;
      toasts.show(`Import: ${(e as Error).message}`, 'err');
    } finally {
      importing = false;
    }
  }

  function closeImport() {
    importFile = null;
    importPass = '';
    preview = null;
  }

  function toggle(id: string) {
    const next = new Set(exportIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    exportIds = next;
  }
</script>

<div class="transfer">
  <button class="btn btn-sm" onclick={openExport} disabled={!environments.length}><Icon name="upload" size={13} /> Export</button>
  <button class="btn btn-sm" onclick={() => fileInput?.click()}><Icon name="download" size={13} /> Import</button>
  <input bind:this={fileInput} type="file" accept=".json,application/json" hidden onchange={pickFile} />
</div>

<Modal bind:open={exportOpen} title="Export environment" subtitle="Disimpan sebagai file JSON di folder Downloads." width={560}>
  <div class="stack">
    <div class="list">
      {#each environments as e (e.id)}
        <label class="check"><input type="checkbox" checked={exportIds.has(e.id)} onchange={() => toggle(e.id)} /> {e.name} <span class="muted small mono">{e.baseUrl}</span></label>
      {/each}
    </div>
    <label class="check"><input type="checkbox" bind:checked={withSecrets} /> Sertakan rahasia (token auth, variabel rahasia, password DB)</label>
    {#if withSecrets}
      <p class="muted small">Rahasia dienkripsi dengan passphrase ini. Passphrase dibutuhkan saat import dan tidak disimpan di mana pun; kirimkan lewat jalur lain, bukan bersama file.</p>
      <div class="grid2">
        <label class="field"><span>Passphrase</span><input class="input" type="password" bind:value={exportPass} autocomplete="new-password" /></label>
        <label class="field"><span>Ulangi passphrase</span><input class="input" type="password" bind:value={exportPass2} autocomplete="new-password" /></label>
      </div>
    {/if}
    {#if exportError}<p class="muted small">{exportError}</p>{/if}
  </div>
  {#snippet footer()}
    <button class="btn btn-sm" onclick={() => (exportOpen = false)}>Batal</button>
    <button class="btn btn-sm btn-primary" onclick={doExport} disabled={exporting || Boolean(exportError)}><Icon name="upload" size={13} /> {exporting ? 'Meng-export…' : `Export ${exportIds.size} environment`}</button>
  {/snippet}
</Modal>

<Modal bind:open={importOpen} title="Import environment" subtitle={importName} width={760} onclose={closeImport}>
  {#if preview}
    <div class="stack">
      <p class="muted small">Di-export {preview.exportedAt ? new Date(preview.exportedAt).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}{preview.exportedBy ? ` oleh ${preview.exportedBy}` : ''}.</p>
      {#if preview.hasSecrets && !preview.secretsOpened}
        <div class="unlock">
          <label class="field grow"><span>File ini berisi rahasia terenkripsi. Isi passphrase untuk ikut meng-import-nya.</span><input class="input" type="password" bind:value={importPass} onkeydown={(e) => e.key === 'Enter' && unlock()} /></label>
          <button class="btn btn-sm" onclick={unlock} disabled={importPass.length < MIN_PASSPHRASE}><Icon name="unlock" size={13} /> Buka</button>
        </div>
      {:else if preview.secretsOpened}
        <p class="ok small"><Icon name="lock" size={12} /> Rahasia terbuka dan akan disimpan ke Keychain laptop ini.</p>
      {/if}
      <table class="items">
        <thead><tr><th>Environment</th><th>Di sini</th><th>Rahasia</th><th>Tindakan</th></tr></thead>
        <tbody>
          {#each preview.items as item (item.id)}
            <tr>
              <td><strong>{item.name}</strong><br /><span class="muted small mono">{item.baseUrl}</span>{#if item.error}<br /><span class="err small">{item.error}</span>{/if}</td>
              <td class="small">{item.match ? `${item.match.name} (${item.match.by === 'id' ? 'id sama' : 'nama sama'})` : 'belum ada'}</td>
              <td class="small">{item.secrets.length ? item.secrets.join(', ') : preview.hasSecrets && !preview.secretsOpened ? 'terkunci' : '-'}</td>
              <td>
                <select class="input" bind:value={actions[item.id]} disabled={Boolean(item.error)}>
                  {#if item.match}<option value="replace">Ganti "{item.match.name}"</option>{/if}
                  <option value="new">Tambah baru</option>
                  <option value="skip">Lewati</option>
                </select>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  {#snippet footer()}
    <button class="btn btn-sm" onclick={() => (importOpen = false)}>Batal</button>
    <button class="btn btn-sm btn-primary" onclick={doImport} disabled={importing || !chosen}><Icon name="download" size={13} /> {importing ? 'Meng-import…' : `Import ${chosen} environment`}</button>
  {/snippet}
</Modal>

<style>
  .transfer {
    display: flex;
    gap: 6px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 260px;
    overflow: auto;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .unlock {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
  .items {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .items th,
  .items td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .ok {
    color: var(--ok);
    margin: 0;
  }
  .err {
    color: var(--err);
  }
  @media (max-width: 640px) {
    .grid2 {
      grid-template-columns: 1fr;
    }
  }
</style>
