<script lang="ts">
  import AiPicker from '../components/AiPicker.svelte';
  import AiUsageMeter from '../components/AiUsageMeter.svelte';
  import Icon from '../components/Icon.svelte';
  import { toasts } from '../components/toast.svelte';
  import { loadAiSelection, saveAiSelection } from '../lib/ai/providers.svelte';
  import type { AiSelection } from '../lib/ai/types';
  import { wa } from '../lib/whatsapp/client';
  import { waCustomNames } from '../lib/whatsapp/custom-names.svelte';
  import { AUDIENCES, fillTemplate, templateVariables, type WaAudience, type WaChat, type WaTemplate } from '../lib/whatsapp/types';

  let {
    chat,
    templates,
    audience,
    draft = $bindable(''),
    onaudience,
    onsent,
    onmanage,
  }: {
    chat: WaChat;
    templates: WaTemplate[];
    audience: WaAudience;
    draft: string;
    onaudience: (a: WaAudience) => void;
    onsent: () => void;
    onmanage: () => void;
  } = $props();

  let templateId = $state('');
  let values = $state<Record<string, string>>({});
  let instruction = $state('');
  let ai = $state<AiSelection>(loadAiSelection('whatsapp'));
  let drafting = $state(false);
  let sending = $state(false);
  let confirming = $state(false);

  let attachment = $state<{
    file: File;
    filename: string;
    mimetype: string;
    data: string;
    size: number;
    previewUrl?: string;
  } | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    processFile(file);
    input.value = '';
  }

  function processFile(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      toasts.show('Ukuran file maksimal 25 MB.', 'err');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] || '';
      attachment = {
        file,
        filename: file.name,
        mimetype: file.type || 'application/octet-stream',
        data: base64,
        size: file.size,
        previewUrl: file.type.startsWith('image/') ? result : undefined,
      };
      confirming = false;
    };
    reader.readAsDataURL(file);
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          processFile(file);
          break;
        }
      }
    }
  }

  function removeAttachment() {
    attachment = null;
    confirming = false;
  }

  const forAudience = $derived(templates.filter((t) => t.audience === audience));
  const template = $derived(templates.find((t) => t.id === templateId));
  const variables = $derived(template ? templateVariables(template.body) : []);
  const filled = $derived(template ? fillTemplate(template.body, values) : '');
  const missing = $derived(variables.filter((v) => !values[v]?.trim()));

  // A new chat starts clean: no stale template values or pending send confirmation.
  let lastJid = '';
  $effect(() => {
    if (chat.jid === lastJid) return;
    lastJid = chat.jid;
    templateId = '';
    instruction = '';
    confirming = false;
    attachment = null;
  });

  function pickTemplate(id: string) {
    templateId = id;
    const displayName = waCustomNames.getName(chat.jid, chat.name);
    const firstName = chat.isGroup ? '' : displayName.replace(/^\+\d+$/, '').split(/\s+/)[0] ?? '';
    values = { nama: firstName };
  }

  function useTemplateAsIs() {
    if (!template) return;
    draft = filled;
    confirming = false;
  }

  async function generate() {
    drafting = true;
    confirming = false;
    try {
      const displayName = waCustomNames.getName(chat.jid, chat.name);
      const res = await wa.draft({
        jid: chat.jid,
        audience,
        chatName: displayName,
        template: template ? filled : undefined,
        instruction: instruction.trim() || undefined,
        ai,
      });
      draft = res.draft;
    } catch (e) {
      toasts.show((e as Error).message, 'err', 7000);
    } finally {
      drafting = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft);
      toasts.show('Draft disalin.', 'ok', 2000);
    } catch {
      toasts.show('Gagal menyalin ke clipboard.', 'err');
    }
  }

  async function send() {
    if (!confirming) {
      confirming = true;
      return;
    }
    sending = true;
    try {
      await wa.send({
        jid: chat.jid,
        text: draft,
        attachment: attachment
          ? {
              filename: attachment.filename,
              mimetype: attachment.mimetype,
              data: attachment.data,
              size: attachment.size,
            }
          : undefined,
      });
      draft = '';
      attachment = null;
      confirming = false;
      toasts.show(`Terkirim ke ${waCustomNames.getName(chat.jid, chat.name)}.`, 'ok');
      onsent();
    } catch (e) {
      // Keep the draft, but require a fresh confirmation for the next attempt.
      confirming = false;
      toasts.show((e as Error).message, 'err', 6000);
    } finally {
      sending = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') confirming = false;
  }
</script>

<aside class="composer">
  <div class="section">
    <div class="label">Lawan bicara</div>
    <div class="segmented" role="group" aria-label="Audiens">
      {#each AUDIENCES as a (a.id)}
        <button class:active={audience === a.id} aria-pressed={audience === a.id} onclick={() => (onaudience(a.id), (templateId = ''))} title={a.hint}>{a.label}</button>
      {/each}
    </div>
    <p class="hint muted">{AUDIENCES.find((a) => a.id === audience)?.hint}</p>
  </div>

  <div class="section">
    <div class="label-row">
      <span class="label">Template</span>
      <button class="btn btn-ghost btn-sm" onclick={onmanage}><Icon name="template" size={13} /> Kelola</button>
    </div>
    <select class="input" value={templateId} onchange={(e) => pickTemplate(e.currentTarget.value)} aria-label="Pilih template">
      <option value="">Tanpa template (AI menulis bebas)</option>
      {#each forAudience as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
    </select>
    {#if template && variables.length}
      <div class="vars">
        {#each variables as v (v)}
          <label class="var">
            <span class="mono">{v}</span>
            <input class="input" value={values[v] ?? ''} oninput={(e) => (values = { ...values, [v]: e.currentTarget.value })} placeholder={`isi ${v}`} />
          </label>
        {/each}
      </div>
    {/if}
    {#if template}
      <div class="preview">{filled}</div>
      <button class="btn btn-sm" onclick={useTemplateAsIs}>
        <Icon name="check" size={13} /> Pakai template apa adanya{missing.length ? ` (${missing.length} kosong)` : ''}
      </button>
    {/if}
  </div>

  <div class="section">
    <label class="label" for="wa-instruction">Instruksi untuk AI <span class="muted">(opsional)</span></label>
    <textarea id="wa-instruction" class="input" rows="2" bind:value={instruction} placeholder="mis. tolak halus, tawarkan jadwal Kamis jam 2"></textarea>
    <AiPicker value={ai} onchange={(sel) => ((ai = sel), saveAiSelection('whatsapp', sel))} disabled={drafting} />
    <AiUsageMeter provider={ai.provider} compact />
    <button class="btn btn-primary" onclick={generate} disabled={drafting}>
      <Icon name="sparkles" /> {drafting ? 'AI menyusun balasan…' : template ? 'Sesuaikan template dengan AI' : 'Buat balasan dengan AI'}
    </button>
  </div>

  <div class="section grow">
    <div class="label-row">
      <label class="label" for="wa-draft">Draft balasan</label>
      <span class="muted count">{draft.length}/4096</span>
    </div>
    <textarea
      id="wa-draft"
      class="input draft"
      bind:value={draft}
      oninput={() => (confirming = false)}
      onpaste={handlePaste}
      {onkeydown}
      placeholder="Draft muncul di sini. Kamu bisa edit sebelum kirim atau paste screenshot (Ctrl+V)."
    ></textarea>

    <input
      type="file"
      bind:this={fileInput}
      onchange={handleFileChange}
      style="display: none;"
    />

    {#if attachment}
      <div class="attachment-preview">
        {#if attachment.previewUrl}
          <img src={attachment.previewUrl} alt={attachment.filename} class="att-thumb" />
        {:else}
          <div class="att-icon"><Icon name="doc" size={18} /></div>
        {/if}
        <div class="att-info">
          <span class="att-name" title={attachment.filename}>{attachment.filename}</span>
          <span class="att-size">{formatBytes(attachment.size)}</span>
        </div>
        <button type="button" class="btn-att-remove" onclick={removeAttachment} title="Hapus lampiran" aria-label="Hapus lampiran">
          <Icon name="x" size={14} />
        </button>
      </div>
    {/if}

    <div class="actions">
      <button
        type="button"
        class="btn btn-attach"
        onclick={() => fileInput?.click()}
        title="Lampirkan file (gambar, dokumen, dll)"
      >
        <Icon name="paperclip" size={14} /> Lampirkan
      </button>
      <button class="btn" onclick={copy} disabled={!draft.trim()}><Icon name="copy" size={14} /> Salin</button>
      {#if confirming}
        <button class="btn" onclick={() => (confirming = false)} disabled={sending}>Batal</button>
      {/if}
      <button class="btn send" class:confirm={confirming} onclick={send} disabled={(!draft.trim() && !attachment) || sending}>
        <Icon name="send" size={14} />
        {sending ? 'Mengirim…' : confirming ? 'Ya, kirim' : 'Kirim'}
      </button>
    </div>
    {#if confirming}
      <p class="hint warn">
        Periksa lagi draft {attachment ? 'dan lampiran ' : ''}di atas. Pesan akan terkirim ke <strong>{chat.name}</strong> dari nomor WhatsApp kamu.
      </p>
    {/if}
  </div>
</aside>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    overflow: auto;
    padding: 14px;
    background: var(--surface);
    border-left: 1px solid var(--border);
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .section.grow {
    flex: 1;
    min-height: 220px;
  }
  .label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }
  .label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .hint.warn {
    color: var(--warn);
  }
  .segmented {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .segmented button {
    flex: 1;
    height: 28px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-2);
    cursor: pointer;
    font-size: 12.5px;
    font-weight: 500;
  }
  .segmented button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow);
  }
  .vars {
    display: grid;
    gap: 6px;
  }
  .var {
    display: grid;
    grid-template-columns: 90px 1fr;
    align-items: center;
    gap: 8px;
  }
  .var span {
    font-size: 12px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .var .input {
    min-height: 30px;
    padding: 4px 8px;
  }
  .preview {
    white-space: pre-wrap;
    font-size: 13px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-2);
    max-height: 140px;
    overflow: auto;
  }
  .btn {
    justify-content: center;
  }
  .draft {
    flex: 1;
    min-height: 140px;
    resize: none;
  }
  .count {
    font-size: 11.5px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
  }
  .send {
    background: var(--ok);
    border-color: var(--ok);
    color: #fff;
  }
  .send:hover:not(:disabled) {
    background: var(--ok);
    filter: brightness(0.92);
  }
  .send.confirm {
    background: var(--warn);
    border-color: var(--warn);
  }
  .attachment-preview {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .att-thumb {
    width: 36px;
    height: 36px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .att-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 4px;
    background: var(--surface);
    color: var(--primary);
  }
  .att-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .att-name {
    font-size: 12px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .att-size {
    font-size: 11px;
    color: var(--text-3);
  }
  .btn-att-remove {
    background: none;
    border: 0;
    color: var(--text-3);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    display: grid;
    place-items: center;
  }
  .btn-att-remove:hover {
    color: var(--err);
    background: var(--surface-hover);
  }
  .btn-attach {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-2);
  }
  .btn-attach:hover {
    color: var(--text);
  }
</style>
