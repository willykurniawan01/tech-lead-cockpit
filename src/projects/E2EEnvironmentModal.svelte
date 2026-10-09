<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { confirmDialog } from '../components/confirm.svelte';
  import { toasts } from '../components/toast.svelte';
  import { qa } from '../lib/qa/client';
  import { emptyEnvironment, type QAEnvironment } from '../lib/qa/types';

  let {
    open = $bindable(false),
    environments = $bindable([]),
    services = [],
    selectedId = $bindable(''),
  }: {
    open: boolean;
    environments: QAEnvironment[];
    /** Service names from the TAD, offered as rows for their base URLs. */
    services?: string[];
    selectedId?: string;
  } = $props();

  let editing = $state<QAEnvironment | null>(null);
  let servicesText = $state('');
  let headersText = $state('');
  let variablesText = $state('');
  let secretVarsText = $state('');
  let secretVarsInitial = '';
  let secret = $state('');
  let clearSecret = $state(false);
  let saving = $state(false);
  let error = $state('');

  const toLines = (r: Record<string, string>, sep: string) =>
    Object.entries(r)
      .map(([k, v]) => `${k}${sep}${v}`)
      .join('\n');

  function fromLines(text: string, sep: ':' | '=', what = 'Baris'): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf(sep);
      if (i <= 0) throw new Error(`${what} "${t.slice(0, 40)}" harus berformat nama ${sep} nilai.`);
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
  }

  function edit(env: QAEnvironment | null) {
    const e = env ? structuredClone($state.snapshot(env)) : emptyEnvironment();
    // Offer the TAD's services that have no URL yet, so the user only fills in the blanks.
    const services_ = { ...e.services };
    for (const s of services) if (!Object.keys(services_).some((k) => k.toLowerCase() === s.toLowerCase())) services_[s] = '';
    editing = e;
    servicesText = toLines(services_, ' = ');
    headersText = toLines(e.headers, ': ');
    variablesText = toLines(e.variables, ' = ');
    // Stored values are never sent back to the UI: names only, an empty value keeps the stored one.
    secretVarsInitial = (e.secretVariableNames ?? []).map((n) => `${n} = `).join('\n');
    secretVarsText = secretVarsInitial;
    secret = '';
    clearSecret = false;
    error = '';
  }

  async function save() {
    if (!editing) return;
    error = '';
    let env: QAEnvironment;
    let secretVariables: Record<string, string> | undefined;
    try {
      secretVariables = secretVarsText.trim() === secretVarsInitial.trim() ? undefined : fromLines(secretVarsText, '=', 'Variabel rahasia');
      env = {
        ...$state.snapshot(editing),
        services: Object.fromEntries(Object.entries(fromLines(servicesText, '=')).filter(([, v]) => v)),
        headers: fromLines(headersText, ':'),
        variables: fromLines(variablesText, '='),
      };
    } catch (e) {
      error = (e as Error).message;
      return;
    }
    saving = true;
    try {
      const before = new Set(environments.map((e) => e.id));
      environments = await qa.saveEnvironment(env, clearSecret ? '' : secret || undefined, secretVariables);
      const saved = env.id ? env.id : environments.find((e) => !before.has(e.id))?.id;
      if (saved) selectedId = saved;
      secret = '';
      editing = null;
      toasts.show('Environment tersimpan.', 'ok', 2000);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  async function remove(env: QAEnvironment) {
    const ok = await confirmDialog({ title: 'Hapus environment?', message: `Hapus "${env.name}" beserta token-nya di Keychain?`, confirmText: 'Hapus', danger: true });
    if (!ok) return;
    try {
      environments = await qa.deleteEnvironment(env.id);
      if (selectedId === env.id) selectedId = environments[0]?.id ?? '';
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    }
  }

  const secretLabel = $derived(editing?.auth.type === 'basic' ? 'Password' : 'Token');
</script>

<Modal bind:open title="Environment E2E" subtitle="Server tujuan test: base URL per service, header, variabel, dan auth" width={760} onclose={() => (editing = null)}>
  {#if !editing}
    <div class="env-list">
      {#if !environments.length}
        <p class="muted">Belum ada environment. Tambahkan server dev/staging/lokal yang akan dites.</p>
      {/if}
      {#each environments as env (env.id)}
        <div class="env-row">
          <div class="env-info">
            <strong>{env.name}</strong>
            <span class="muted small mono">{env.baseUrl || '(tanpa base URL default)'}{Object.keys(env.services).length ? ` · ${Object.keys(env.services).length} service` : ''}</span>
          </div>
          <div class="env-tags">
            {#if env.readOnly}<span class="chip chip-ok">Read-only</span>{/if}
            {#if env.secretVariableNames?.length}<span class="chip" title={env.secretVariableNames.join(', ')}><Icon name="lock" size={11} /> {env.secretVariableNames.length} rahasia</span>{/if}
            {#if env.auth.type !== 'none'}<span class="chip {env.hasSecret ? '' : 'chip-warn'}"><Icon name="key" size={11} /> {env.auth.type}{env.hasSecret ? '' : ' (token kosong)'}</span>{/if}
          </div>
          <button class="btn btn-sm" onclick={() => edit(env)}><Icon name="edit" size={13} /> Ubah</button>
          <button class="btn btn-ghost btn-sm" onclick={() => remove(env)} aria-label="Hapus {env.name}"><Icon name="trash" size={13} /></button>
        </div>
      {/each}
      <button class="btn btn-primary btn-sm add" onclick={() => edit(null)}><Icon name="plus" size={13} /> Tambah environment</button>
    </div>
  {:else}
    <form class="env-form" onsubmit={(e) => { e.preventDefault(); void save(); }}>
      <div class="grid2">
        <label class="field">
          <span>Nama</span>
          <input class="input" bind:value={editing.name} placeholder="mis. Staging" required />
        </label>
        <label class="field">
          <span>Base URL default</span>
          <input class="input mono" bind:value={editing.baseUrl} placeholder="https://api-staging.internal.net" />
        </label>
      </div>

      <label class="field">
        <span>Base URL per service <em class="muted">(satu per baris: <code>nama-service = https://…</code>; kosong = pakai default)</em></span>
        <textarea class="input mono" rows="5" bind:value={servicesText} placeholder="core-payment = https://payment-staging.internal.net&#10;merchant-service = http://localhost:8081"></textarea>
      </label>

      <div class="grid2">
        <label class="field">
          <span>Header default <em class="muted">(<code>Nama: nilai</code>)</em></span>
          <textarea class="input mono" rows="4" bind:value={headersText}></textarea>
        </label>
        <label class="field">
          <span>Variabel <em class="muted">(<code>nama = nilai</code>, dipakai sebagai <code>{'{{nama}}'}</code>)</em></span>
          <textarea class="input mono" rows="4" bind:value={variablesText} placeholder="merchantId = M-0001&#10;username = qa.tester"></textarea>
        </label>
      </div>

      <label class="field">
        <span>Variabel rahasia <em class="muted">(kredensial uji, PIN, OTP statis: <code>nama = nilai</code>; disimpan di Keychain dan disamarkan di hasil. Nilai kosong = tetap pakai yang tersimpan, hapus baris = hapus variabel)</em></span>
        <textarea class="input mono" rows="3" bind:value={secretVarsText} placeholder="password = …&#10;pin = …" autocomplete="off" spellcheck="false"></textarea>
      </label>

      <div class="grid3">
        <label class="field">
          <span>Auth</span>
          <select class="input" bind:value={editing.auth.type}>
            <option value="none">Tanpa auth</option>
            <option value="bearer">Bearer token</option>
            <option value="basic">Basic (username + password)</option>
            <option value="header">Header API key</option>
          </select>
        </label>
        {#if editing.auth.type === 'header'}
          <label class="field">
            <span>Nama header</span>
            <input class="input mono" bind:value={editing.auth.headerName} placeholder="X-Api-Key" />
          </label>
        {:else if editing.auth.type === 'basic'}
          <label class="field">
            <span>Username</span>
            <input class="input" bind:value={editing.auth.username} autocomplete="off" />
          </label>
        {/if}
        {#if editing.auth.type !== 'none'}
          <label class="field">
            <span>{secretLabel} {editing.hasSecret ? '(tersimpan di Keychain)' : ''}</span>
            <input class="input" type="password" bind:value={secret} autocomplete="off" placeholder={editing.hasSecret ? 'Kosongkan untuk tetap memakai yang lama' : `${secretLabel} untuk environment ini`} disabled={clearSecret} />
            {#if editing.hasSecret}
              <label class="check small"><input type="checkbox" bind:checked={clearSecret} /> Hapus {secretLabel.toLowerCase()} tersimpan</label>
            {/if}
          </label>
        {/if}
      </div>

      <div class="grid2">
        <label class="check">
          <input type="checkbox" bind:checked={editing.readOnly} />
          <span><strong>Read-only</strong>: hanya request GET yang dikirim. Aktifkan untuk server yang datanya tidak boleh berubah.</span>
        </label>
        <label class="field">
          <span>Timeout per request (detik)</span>
          <input class="input" type="number" min="1" max="300" value={Math.round(editing.timeoutMs / 1000)} oninput={(e) => editing && (editing.timeoutMs = Number(e.currentTarget.value) * 1000)} />
        </label>
      </div>

      <p class="muted small">Token, password, dan variabel rahasia disimpan di macOS Keychain, tidak pernah dikirim ke AI, dan disamarkan (<code>***</code>) di hasil run maupun perintah curl. Variabel biasa tersimpan sebagai teks di <code>~/.tech-lead-cockpit/qa</code>.</p>
      {#if error}<p class="err small">{error}</p>{/if}
      <div class="form-actions">
        <button type="button" class="btn btn-sm" onclick={() => (editing = null)}>Batal</button>
        <button type="submit" class="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Menyimpan…' : 'Simpan environment'}</button>
      </div>
    </form>
  {/if}
</Modal>

<style>
  .env-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .env-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .env-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .env-info .small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .env-tags {
    display: flex;
    gap: 6px;
  }
  .add {
    align-self: flex-start;
    margin-top: 4px;
  }
  .env-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .grid2,
  .grid3 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .grid3 {
    grid-template-columns: repeat(3, 1fr);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12.5px;
  }
  .field em {
    font-style: normal;
    font-size: 11.5px;
  }
  textarea {
    resize: vertical;
    font-size: 12px;
  }
  .check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 12.5px;
    line-height: 1.4;
  }
  .check.small {
    margin-top: 4px;
    font-size: 11.5px;
  }
  .err {
    color: var(--err);
    margin: 0;
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .small {
    font-size: 12px;
  }
  @media (max-width: 720px) {
    .grid2,
    .grid3 {
      grid-template-columns: 1fr;
    }
  }
</style>
