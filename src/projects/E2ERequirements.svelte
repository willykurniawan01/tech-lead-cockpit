<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { qa } from '../lib/qa/client';
  import { handleConflict } from '../lib/qa/conflict';
  import { e2eRequirements } from '../lib/qa/requirements';
  import type { QAEnvironment, QAFlow } from '../lib/qa/types';

  const AUTO_OPEN_MAX = 12;

  /**
   * The keys an environment still needs before the flows can run, filled in place: variables
   * nobody provides (or only the AI's example value), service base URLs, the auth token.
   */
  let { flows, env, environments = $bindable(), onopenenv }: { flows: QAFlow[]; env?: QAEnvironment; environments: QAEnvironment[]; onopenenv: () => void } = $props();

  const req = $derived(e2eRequirements(flows, env));
  const todoVars = $derived(req.variables.filter((v) => v.status === 'missing' || v.status === 'example'));
  const doneVars = $derived(req.variables.filter((v) => v.status !== 'missing' && v.status !== 'example'));
  const todoServices = $derived(req.services.filter((s) => s.status === 'missing'));
  const defaultServices = $derived(req.services.filter((s) => s.status === 'default' && s.service));

  let open = $state<boolean | null>(null);
  // Opens on its own only when the list is short; a long one waits for a click.
  const expanded = $derived(open ?? (req.todo > 0 && req.todo <= AUTO_OPEN_MAX));
  let query = $state('');
  const match = (name: string) => !query.trim() || name.toLowerCase().includes(query.trim().toLowerCase());
  const shownVars = $derived(todoVars.filter((v) => match(v.name)));
  const missingCount = $derived(todoVars.filter((v) => v.status === 'missing').length);
  let values = $state<Record<string, string>>({});
  /** Per variable: kept in the Keychain. Defaults to on for names that look like credentials. */
  let secretFlags = $state<Record<string, boolean>>({});
  let urls = $state<Record<string, string>>({});
  let saving = $state(false);

  const isSecret = (name: string, sensitive: boolean) => secretFlags[name] ?? sensitive;
  const filled = $derived(Object.values(values).filter((v) => v.trim()).length + Object.values(urls).filter((v) => v.trim()).length);
  const flowsTitle = (list: string[]) => list.join('\n');

  async function save() {
    if (!env || !filled) return;
    const plain: Record<string, string> = {};
    const secret: Record<string, string> = {};
    for (const v of todoVars) {
      const value = values[v.name]?.trim();
      if (value) (isSecret(v.name, v.sensitive) ? secret : plain)[v.name] = value;
    }
    const services = { ...env.services };
    for (const [svc, url] of Object.entries(urls)) if (url.trim()) services[svc] = url.trim();
    // Secret variables are replaced as a set: stored names with an empty value keep their value.
    const secretVariables = Object.keys(secret).length ? { ...Object.fromEntries((env.secretVariableNames ?? []).map((n) => [n, ''])), ...secret } : undefined;
    saving = true;
    try {
      environments = await qa.saveEnvironment({ ...$state.snapshot(env), variables: { ...env.variables, ...plain }, services }, undefined, secretVariables);
      values = {};
      urls = {};
      toasts.show(`Tersimpan ke environment ${env.name}.`, 'ok', 2000);
    } catch (e) {
      if (!(await handleConflict(e, async () => (environments = await qa.environments())))) toasts.show((e as Error).message, 'err');
    } finally {
      saving = false;
    }
  }

  function copyKeys() {
    const lines = [...todoVars.map((v) => `${v.name} = ${v.status === 'example' ? `# contoh AI: ${v.example}` : ''}`.trim()), ...todoServices.map((s) => `${s.service || '(base URL default)'} = https://`)];
    void navigator.clipboard.writeText(lines.join('\n'));
    toasts.show('Daftar key disalin.', 'ok', 1500);
  }

  const STATUS = { missing: { label: 'Belum ada nilai', cls: 'st-err' }, example: { label: 'Masih contoh AI', cls: 'st-warn' }, set: { label: 'Variabel', cls: 'st-ok' }, secret: { label: 'Rahasia', cls: 'st-ok' }, auto: { label: 'Otomatis', cls: '' } } as const;
</script>

{#if flows.length}
  <section class="card reqs" class:todo={req.todo > 0}>
    <button class="reqs-head" onclick={() => (open = !expanded)} aria-expanded={expanded}>
      <Icon name="key" size={14} />
      <strong>Yang perlu diatur{env ? ` di ${env.name}` : ''}</strong>
      {#if !env}
        <span class="badge st-warn">pilih environment</span>
      {:else if req.todo}
        <span class="badge st-warn">{req.todo} key belum diisi</span>
      {:else}
        <span class="badge st-ok"><Icon name="check" size={11} /> semua siap</span>
      {/if}
      <span class="muted small">{req.variables.length} variabel dipakai · {req.services.length} service</span>
      <span class="grow"></span>
      <Icon name="chevron" size={13} />
    </button>

    {#if expanded}
      {#if !env}
        <p class="muted small">Pilih atau buat environment dulu; daftar key dihitung terhadap isinya. <button class="link-btn" onclick={onopenenv}>Buka Environment</button></p>
      {:else}
        {#if req.authMissing}
          <div class="row warn-row">
            <Icon name="lock" size={13} />
            <span>Token/password auth environment (<code>{env.auth.type}</code>) belum disimpan, padahal step memakai auth environment.</span>
            <button class="btn btn-sm" onclick={onopenenv}>Atur di Environment</button>
          </div>
        {/if}

        {#if todoVars.length}
          <div class="vars-head">
            <h4>Variabel <span class="muted small">({missingCount} belum ada nilai · {todoVars.length - missingCount} masih contoh AI)</span></h4>
            {#if todoVars.length > 8}
              <input class="input search" type="search" bind:value={query} placeholder="Cari key…" aria-label="Cari key" />
            {/if}
          </div>
          <div class="grid scroll">
            {#each shownVars as v (v.name)}
              <code class="name" title={v.sensitive ? 'Nama ini tampak seperti kredensial' : ''}>{v.name}</code>
              <span class="badge {STATUS[v.status].cls}">{STATUS[v.status].label}</span>
              <input
                class="input mono"
                type={isSecret(v.name, v.sensitive) ? 'password' : 'text'}
                autocomplete="off"
                bind:value={values[v.name]}
                placeholder={v.example ? `contoh AI: ${isSecret(v.name, v.sensitive) ? '••••' : v.example}` : 'isi nilai'}
                aria-label="Nilai {v.name}"
              />
              <label class="check small" title="Disimpan di macOS Keychain dan disamarkan di hasil run"><input type="checkbox" checked={isSecret(v.name, v.sensitive)} onchange={(e) => (secretFlags = { ...secretFlags, [v.name]: e.currentTarget.checked })} /> Rahasia</label>
              <span class="muted small used" title={flowsTitle(v.flows)}>
                {v.flows.length} flow
                {#if v.example && !isSecret(v.name, v.sensitive)}· <button class="link-btn" onclick={() => (values = { ...values, [v.name]: v.example ?? '' })}>pakai contoh</button>{/if}
              </span>
            {/each}
            {#if !shownVars.length}<p class="muted small">Tidak ada key yang cocok.</p>{/if}
          </div>
        {/if}

        {#if todoServices.length}
          <h4>Base URL service <span class="muted small">(belum ada URL sendiri maupun base URL default)</span></h4>
          <div class="grid urls">
            {#each todoServices as s (s.service)}
              <code class="name">{s.service || '(tanpa service)'}</code>
              <span class="badge st-err">Belum ada URL</span>
              <input class="input mono" type="url" bind:value={urls[s.service]} placeholder="https://service.dev.internal" aria-label="Base URL {s.service || 'default'}" />
              <span></span>
              <span class="muted small used" title={flowsTitle(s.flows)}>{s.flows.length} flow</span>
            {/each}
          </div>
        {/if}

        {#if todoVars.length || todoServices.length}
          <div class="actions">
            <button class="btn btn-primary btn-sm" onclick={save} disabled={!filled || saving}><Icon name="save" size={13} /> {saving ? 'Menyimpan…' : `Simpan ${filled || ''} nilai ke ${env.name}`}</button>
            <button class="btn btn-sm" onclick={copyKeys}><Icon name="copy" size={13} /> Salin daftar key</button>
            <span class="muted small">Yang dicentang Rahasia masuk Keychain, tidak pernah dikirim ke AI. Contoh AI tetap dipakai saat run sampai diganti nilai asli.</span>
          </div>
        {:else if !req.authMissing}
          <p class="muted small"><Icon name="check" size={12} /> Semua variabel dan base URL sudah punya nilai.</p>
        {/if}

        {#if defaultServices.length}
          <p class="muted small">Memakai base URL default (belum punya URL sendiri): {defaultServices.map((s) => s.service).join(', ')}. <button class="link-btn" onclick={onopenenv}>Atur per service</button></p>
        {/if}

        {#if doneVars.length}
          <details class="done">
            <summary class="small">Sudah diatur & otomatis ({doneVars.length})</summary>
            <ul>
              {#each doneVars as v (v.name)}
                <li class="small"><code>{v.name}</code> <span class="badge {STATUS[v.status].cls}">{STATUS[v.status].label}</span> <span class="muted">{v.source ?? (v.status === 'secret' ? 'Keychain' : 'environment')}</span></li>
              {/each}
            </ul>
            <p class="muted small">Variabel otomatis terisi saat flow dijalankan berurutan; jalankan flow sumbernya lebih dulu.</p>
          </details>
        {/if}
      {/if}
    {/if}
  </section>
{/if}

<style>
  .reqs {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .reqs.todo {
    border-color: var(--warn);
  }
  .reqs-head {
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  h4 {
    margin: 4px 0 0;
    font-size: 13px;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(120px, max-content) max-content minmax(160px, 1fr) max-content max-content;
    gap: 6px 10px;
    align-items: center;
  }
  .vars-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .search {
    width: 220px;
    padding: 4px 10px;
    font-size: 12px;
  }
  /* A long list scrolls inside the card (most of the screen), so the page around it keeps its place. */
  .scroll {
    max-height: 70vh;
    overflow-y: auto;
    padding-right: 4px;
  }
  .done ul {
    max-height: 40vh;
    overflow-y: auto;
  }
  .name {
    font-size: 12px;
    word-break: break-all;
  }
  .used {
    white-space: nowrap;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .warn-row {
    padding: 8px 10px;
    border-radius: var(--radius);
    background: var(--warn-soft);
    color: var(--warn);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .done ul {
    margin: 6px 0;
    padding-left: 16px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .small {
    font-size: 12px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text);
    white-space: nowrap;
  }
  .st-ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .st-err {
    background: var(--err-soft);
    color: var(--err);
  }
  .st-warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .link-btn {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  @media (max-width: 720px) {
    .grid {
      grid-template-columns: 1fr max-content;
    }
    .grid .input {
      grid-column: 1 / -1;
    }
  }
</style>
