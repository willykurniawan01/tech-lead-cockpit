<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { toasts } from '../components/toast.svelte';
  import type { ConnectorStatus, PreflightResponse, PublishResponse } from '../lib/confluence/api-types';
  import { connector, ConnectorRequestError } from '../lib/confluence/client';
  import { plainMentionCandidates, toConfluenceStorage, type StorageOptions } from '../lib/confluence/storage';
  import { appendChangeHistoryRow } from '../lib/confluence/changelog';
  import ConfluenceMergeModal from './ConfluenceMergeModal.svelte';
  import JiraTicketsDialog from './JiraTicketsDialog.svelte';
  import { tasksWithoutTicket } from '../lib/tad/tad-tickets';
  import { buildHunks, lineDiff, storageToLines, type DiffHunk } from '../lib/diff';
  import { htmlDiff, sameText } from '../lib/html-diff';
  import { renderPreview } from '../lib/markdown/preview';
  import { storageToMarkdown } from '../lib/confluence/storage-to-markdown';
  import type { ValidationResult } from '../lib/tad/validator';
  import { drafts, type Draft } from './drafts.svelte';
  import { copyForConfluence, diagramUploads } from './export';
  import PreviewPane from './PreviewPane.svelte';

  let {
    open = $bindable(false),
    draft,
    validation,
  }: {
    open: boolean;
    draft: Draft;
    validation: ValidationResult;
  } = $props();

  let status = $state<ConnectorStatus | null>(null);
  let statusError = $state('');
  let checkingStatus = $state(false);

  let spaceKey = $state('');
  let parentId = $state('');
  let versionMessage = $state('Diperbarui dari Tech Lead Cockpit');
  let generatingChangelog = $state(false);
  let syncChangeHistory = $state(false);
  let opts = $state<StorageOptions>({ mermaid: 'attachment', mermaidMacro: 'mermaid-cloud', toc: true });

  let preflight = $state<PreflightResponse | null>(null);
  let preflightKey = $state('');
  let preflightError = $state('');
  let checking = $state(false);
  let confirmExisting = $state(false);
  let tab = $state<'diff' | 'xml'>('diff');

  let view = $state<'doc' | 'md'>('doc');
  let expanded = $state<Set<number>>(new Set());
  const CONTEXT = 2;
  const COLLAPSE_AT = 60;

  let publishing = $state(false);
  let savingDraft = $state(false);
  let publishError = $state('');
  let result = $state<PublishResponse | null>(null);
  let ticketsOpen = $state(false);
  const withoutTicket = $derived(result ? tasksWithoutTicket(draft.markdown) : []);

  /** Name → account id of the people mentioned on the page being updated (repairs `@Name` text in older drafts). */
  let knownUsers = $state<Record<string, string>>({});
  const storage = $derived(toConfluenceStorage(draft.markdown, { ...opts, knownUsers }));
  const title = $derived(storage.title ?? '');
  const targetKey = $derived(`${spaceKey.trim()}|${parentId.trim()}|${title}`);
  // Any change to the target after a check means the check no longer applies.
  const preflightFresh = $derived(preflight !== null && preflightKey === targetKey);
  const existing = $derived(preflightFresh ? preflight?.existing : undefined);
  const linkedToDraft = $derived(Boolean(existing && existing.id === draft.confluence.pageId));
  /** The page was edited in Confluence after the version this draft is based on. */
  const remoteAhead = $derived(Boolean(linkedToDraft && existing && draft.confluence.version && existing.version > draft.confluence.version));
  let overwriteRemote = $state(false);
  let mergeOpen = $state(false);
  const needsConfirmExisting = $derived(Boolean(existing && !linkedToDraft));

  const existingMarkdown = $derived.by(() => {
    if (!existing?.storage) return '';
    try {
      return storageToMarkdown(existing.storage, existing.title).markdown;
    } catch (err) {
      console.warn('Gagal membaca storage Confluence ke Markdown:', err);
      return '';
    }
  });

  const diff = $derived.by(() => {
    if (existingMarkdown) {
      return lineDiff(existingMarkdown.split('\n'), draft.markdown.split('\n'));
    }
    if (existing?.storage !== undefined) {
      return lineDiff(storageToLines(existing.storage), storageToLines(storage.xhtml));
    }
    return null;
  });

  const hunks = $derived(diff ? buildHunks(diff) : []);
  const added = $derived(diff?.filter((d) => d.type === 'add').length ?? 0);
  const removed = $derived(diff?.filter((d) => d.type === 'del').length ?? 0);

  function trackedHtml(h: DiffHunk): { html: string; formatOnly: boolean } {
    if (!diff) return { html: '', formatOnly: false };
    if (!existingMarkdown) {
      const before = existing?.storage ?? '';
      const after = storage.xhtml;
      return { html: htmlDiff(before, after), formatOnly: sameText(before, after) };
    }
    let s = h.start;
    let e = h.end;
    const blank = (i: number) => diff[i].type === 'same' && !diff[i].text.trim();
    while (s > 0 && !blank(s - 1)) s--;
    while (e < diff.length && !blank(e)) e++;
    const lines = diff.slice(s, e);
    const before = renderPreview(lines.filter((l) => l.type !== 'add').map((l) => l.text).join('\n')).html;
    const after = renderPreview(lines.filter((l) => l.type !== 'del').map((l) => l.text).join('\n')).html;
    return { html: htmlDiff(before, after), formatOnly: sameText(before, after) };
  }

  const tracked = $derived(
    view === 'doc' && hunks.length
      ? new Map(hunks.map((h) => [h.id, trackedHtml(h)]))
      : new Map<number, { html: string; formatOnly: boolean }>(),
  );

  function linesOf(h: { start: number; end: number }) {
    if (!diff) return [];
    const from = Math.max(0, h.start - CONTEXT);
    const to = Math.min(diff.length, h.end + CONTEXT);
    return diff.slice(from, to).map((line, i) => ({ ...line, context: from + i < h.start || from + i >= h.end }));
  }

  const connected = $derived(Boolean(status?.configured && status.user));
  const blockers = $derived.by(() => {
    const b: string[] = [];
    if (!connected) b.push('Connector Confluence belum terhubung.');
    if (!title) b.push('Dokumen butuh judul H1 untuk nama halaman.');
    if (!preflightFresh) b.push('Cek target Confluence terlebih dahulu.');
    if (remoteAhead && !overwriteRemote) b.push(`Halaman sudah diubah di Confluence (v${existing?.version}) setelah versi dasar draft (v${draft.confluence.version}). Gabungkan dulu, atau centang timpa.`);
    if (needsConfirmExisting && !confirmExisting) b.push('Konfirmasi update halaman yang sudah ada.');
    return b;
  });

  // Reset per open so a stale check or result from a previous session never carries over.
  $effect(() => {
    if (!open) return;
    // Only `open` should trigger this; saving the target updates the draft mid-session.
    untrack(() => {
      spaceKey = draft.confluence.spaceKey;
      parentId = draft.confluence.parentId;
      opts = { ...draft.storageOptions };
      preflight = null;
      preflightError = '';
      publishError = '';
      result = null;
      confirmExisting = false;
      generatingChangelog = false;
      syncChangeHistory = false;
      loadStatus();
    });
  });

  async function loadStatus() {
    checkingStatus = true;
    statusError = '';
    try {
      status = await connector.status();
    } catch (e) {
      status = null;
      statusError = e instanceof Error ? e.message : String(e);
    } finally {
      checkingStatus = false;
    }
  }

  function saveTarget() {
    drafts.update(draft.id, {
      confluence: { ...draft.confluence, spaceKey: spaceKey.trim(), parentId: parentId.trim() },
      storageOptions: { ...opts },
    });
  }

  async function mentionedUsers(pageId: string): Promise<Record<string, string>> {
    try {
      const page = await connector.page({ id: pageId });
      const users: Record<string, string> = {};
      for (const m of (page.storage ?? '').matchAll(/<ri:user\b([^>]*?)\/?>/g)) {
        const attrs = m[1];
        const idMatch = attrs.match(/ri:(?:account-id|userkey|username)="([^"]+)"/);
        const nameMatch = attrs.match(/data-display-name="([^"]+)"/);
        if (idMatch && nameMatch) {
          const rawName = nameMatch[1].replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
          users[rawName] = idMatch[1];
        }
      }
      return users;
    } catch {
      return {};
    }
  }

  async function check() {
    checking = true;
    preflightError = '';
    publishError = '';
    confirmExisting = false;
    saveTarget();
    try {
      preflight = await connector.preflight({
        spaceKey: spaceKey.trim(),
        title,
        parentId: parentId.trim() || undefined,
        pageId: draft.confluence.pageId,
      });
      preflightKey = targetKey;
      // People mentioned on the page, plus plain `@Name` text matched exactly against the user directory.
      const onPage = preflight.existing ? await mentionedUsers(preflight.existing.id) : {};
      const candidates = plainMentionCandidates(draft.markdown, onPage);
      const resolved = candidates.length ? await connector.resolveUsers(candidates).catch(() => ({})) : {};
      knownUsers = { ...resolved, ...onPage };
    } catch (e) {
      preflight = null;
      preflightError = e instanceof Error ? e.message : String(e);
    } finally {
      checking = false;
    }
  }

  async function generateChangelog() {
    if (generatingChangelog || checking) return;
    if (!connected) {
      toasts.show('Connector Confluence belum terhubung.', 'err');
      return;
    }
    if (!spaceKey.trim() || !title) {
      toasts.show('Space key dan judul halaman wajib diisi terlebih dahulu.', 'info');
      return;
    }

    generatingChangelog = true;
    try {
      if (!preflightFresh) {
        await check();
      }
      if (preflightError) {
        toasts.show(`Gagal cek target: ${preflightError}`, 'err');
        return;
      }

      const isNewPage = !existing;
      let sectionsChanged: string[] = [];
      let diffSnippet = '';

      if (hunks.length) {
        const uniqueSections = new Set<string>();
        for (const h of hunks) {
          if (h.section && h.section !== 'Dokumen' && h.section !== 'Prolog') {
            uniqueSections.add(h.section);
          }
        }
        sectionsChanged = Array.from(uniqueSections);
      }

      if (diff?.length) {
        const changedLines: string[] = [];
        for (const d of diff) {
          if (d.type === 'add') {
            changedLines.push(`+ ${d.text}`);
          } else if (d.type === 'del') {
            changedLines.push(`- ${d.text}`);
          }
          if (changedLines.length >= 80) break;
        }
        diffSnippet = changedLines.join('\n');
      }

      const res = await connector.generateChangelog({
        title,
        isNewPage,
        sectionsChanged,
        diffSnippet,
      });

      if (res.message) {
        versionMessage = res.message;
        toasts.show('Catatan versi berhasil dibuat oleh AI.', 'ok');
      }
    } catch (err) {
      toasts.show(`Gagal membuat catatan versi: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      generatingChangelog = false;
    }
  }

  async function publish(asDraft = false) {
    if (blockers.length) return;
    publishing = !asDraft;
    savingDraft = asDraft;
    publishError = '';
    saveTarget();
    try {
      let currentMarkdown = draft.markdown;
      if (syncChangeHistory && versionMessage.trim()) {
        const author = status?.user || '';
        const updatedMarkdown = appendChangeHistoryRow(currentMarkdown, versionMessage.trim(), author);
        if (updatedMarkdown !== currentMarkdown) {
          currentMarkdown = updatedMarkdown;
          drafts.update(draft.id, { markdown: updatedMarkdown });
        }
      }
      const currentStorage = currentMarkdown !== draft.markdown
        ? toConfluenceStorage(currentMarkdown, { ...opts, knownUsers })
        : storage;
      const attachments = opts.mermaid === 'attachment' && currentStorage.diagrams.length ? await diagramUploads(currentStorage.diagrams) : [];
      result = await connector.publish({
        spaceKey: spaceKey.trim(),
        title: currentStorage.title ?? title,
        storage: currentStorage.xhtml,
        parentId: parentId.trim() || undefined,
        pageId: existing?.id,
        // Linked page: the draft's own base version, so an edit made in Confluence meanwhile is refused
        // (409) instead of silently overwritten. Only an explicit "timpa" uses the current version.
        expectedVersion: linkedToDraft && draft.confluence.version && !overwriteRemote ? draft.confluence.version : existing?.version,
        versionMessage: versionMessage.trim() || undefined,
        attachments,
        context: { draftId: draft.id, mrUrl: draft.source?.mrUrl, jiraKeys: draft.source?.jiraKeys || [] },
        asDraft,
      });
      drafts.update(draft.id, {
        confluence: {
          spaceKey: spaceKey.trim(),
          parentId: parentId.trim(),
          pageId: result.page.id,
          version: result.page.version,
          status: result.isDraft ? 'draft' : 'current',
          url: result.page.url,
          publishedAt: new Date().toISOString(),
        },
      });
      drafts.saveNow();
      if (result.isDraft) {
        toasts.show(`Draft Confluence berhasil disimpan (versi tetap ${result.page.version}).`, 'ok');
      } else {
        toasts.show(result.action === 'create' ? 'Halaman Confluence dibuat.' : `Halaman diperbarui ke versi ${result.page.version}.`, 'ok');
      }
    } catch (e) {
      publishError = e instanceof Error ? e.message : String(e);
      if (e instanceof ConnectorRequestError && (e.body.code === 'conflict' || e.body.code === 'exists')) {
        // Force a fresh look at the page before another attempt.
        preflight = null;
      }
    } finally {
      publishing = false;
      savingDraft = false;
    }
  }

  async function copyFallback() {
    try {
      await copyForConfluence(draft.markdown);
      toasts.show('Tersalin. Paste ke editor Confluence (Cmd+V).', 'ok');
    } catch (e) {
      toasts.show(`Gagal menyalin: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }
</script>

<Modal bind:open title="Publish ke Confluence" subtitle="Preview → konfirmasi → publish. Update memakai version check agar tidak menimpa perubahan orang lain." width={1060} height={720}>
  {#if result}
    <div class="done">
      <div class="done-icon"><Icon name="check" size={28} /></div>
      <h3>{result.isDraft ? 'Draft Confluence disimpan' : result.action === 'create' ? 'Halaman dibuat' : 'Halaman diperbarui'}</h3>
      <p class="muted">{result.page.title} · versi {result.page.version} {result.isDraft ? '(draft)' : ''} · space {result.page.spaceKey || spaceKey}</p>
      <a class="btn btn-primary" href={result.page.url} target="_blank" rel="noreferrer"><Icon name="external" /> Buka di Confluence</a>
      <p class="muted small">{result.isDraft ? 'Disimpan sebagai unpublished draft (tidak menaikkan versi). Tercatat di Audit log.' : 'Tercatat di Audit log.'}</p>
      {#if withoutTicket.length}
        <div class="next-step">
          <Icon name="jira" size={15} />
          <span><strong>{withoutTicket.length} task belum punya tiket Jira.</strong> Buat sekarang supaya task baru dari perubahan scope ikut terpantau di Task Board.</span>
          <button class="btn btn-sm btn-primary" onclick={() => (ticketsOpen = true)}>Buat tiket Jira</button>
        </div>
      {/if}
    </div>
  {:else}
    <div class="layout">
      <div class="col">
        <section class="card">
          <div class="card-head">
            <h3>Koneksi</h3>
            {#if checkingStatus}
              <span class="chip">Mengecek…</span>
            {:else if connected}
              <span class="chip chip-ok"><Icon name="check" size={12} /> {status?.user}</span>
            {:else}
              <span class="chip chip-warn">Belum terhubung</span>
            {/if}
          </div>
          {#if !checkingStatus && !connected}
            <p class="small">{status?.error ?? statusError}</p>
            <div class="inline-actions">
              <a class="btn btn-sm" href="#/connections" onclick={() => (open = false)}>Cara menghubungkan</a>
              <button class="btn btn-sm" onclick={loadStatus}><Icon name="refresh" size={13} /> Cek ulang</button>
              <button class="btn btn-sm" onclick={copyFallback}><Icon name="copy" size={13} /> Salin rich text</button>
            </div>
          {:else if connected}
            <p class="small muted mono">{status?.baseUrl}</p>
          {/if}
        </section>

        <section class="card">
          <h3>Target</h3>
          <label class="field">
            <span>Judul halaman</span>
            <input class="input" value={title} readonly />
            <small>Diambil dari H1 dokumen. Ubah di editor.</small>
          </label>
          <div class="row">
            <label class="field">
              <span>Space key</span>
              <input class="input mono" bind:value={spaceKey} placeholder="mis. ENG" autocapitalize="characters" />
            </label>
            <label class="field">
              <span>Parent page ID <em class="muted">(opsional)</em></span>
              <input class="input mono" bind:value={parentId} placeholder="mis. 123456789" inputmode="numeric" />
            </label>
          </div>
          {#if draft.confluence.pageId}
            <p class="small muted">Draft ini terhubung ke halaman #{draft.confluence.pageId} (terakhir v{draft.confluence.version}).</p>
          {/if}
        </section>

        <section class="card">
          <h3>Format</h3>
          <label class="field">
            <span>Diagram Mermaid</span>
            <select class="input" bind:value={opts.mermaid}>
              <option value="attachment">Gambar PNG + sumber (berjalan di semua Confluence)</option>
              <option value="macro">Macro Mermaid (butuh app Mermaid terpasang)</option>
              <option value="code">Code block saja</option>
            </select>
          </label>
          {#if opts.mermaid === 'macro'}
            <label class="field">
              <span>Nama macro</span>
              <input class="input mono" bind:value={opts.mermaidMacro} />
              <small>Sesuaikan dengan app Mermaid di instance kamu.</small>
            </label>
          {/if}
          <label class="check"><input type="checkbox" bind:checked={opts.toc} /> Tambahkan daftar isi (TOC macro)</label>
          <div class="field">
            <div class="field-head">
              <span>Catatan versi</span>
              <button
                type="button"
                class="ai-btn"
                onclick={generateChangelog}
                disabled={generatingChangelog || checking || !connected}
                title={preflightFresh ? 'Generate catatan versi otomatis dengan AI berdasarkan diff target' : 'Cek target dan generate catatan versi otomatis dengan AI'}
              >
                <Icon name="sparkles" size={12} />
                {generatingChangelog ? 'Menyusun…' : checking ? 'Mengecek target…' : 'Generate AI'}
              </button>
            </div>
            <input class="input" bind:value={versionMessage} placeholder="mis. Diperbarui dari Tech Lead Cockpit" />
            <label class="check small-check">
              <input type="checkbox" bind:checked={syncChangeHistory} />
              <span>Catat juga ke tabel Change History dokumen</span>
            </label>
          </div>
        </section>
      </div>

      <div class="col wide">
        <section class="card grow">
          <div class="card-head">
            <h3>Preview perubahan</h3>
            <button class="btn btn-sm" onclick={check} disabled={!connected || !spaceKey.trim() || !title || checking}>
              <Icon name="refresh" size={13} />
              {checking ? 'Mengecek…' : preflightFresh ? 'Cek ulang' : 'Cek target'}
            </button>
          </div>

          {#if preflightError}
            <p class="alert alert-err"><Icon name="error" /> {preflightError}</p>
          {/if}

          {#if preflightFresh && preflight}
            <div class="target">
              <div><span class="muted">Space</span> <strong>{preflight.space.name}</strong> <span class="mono muted">({preflight.space.key})</span></div>
              {#if preflight.parent}<div><span class="muted">Parent</span> {preflight.parent.title}</div>{/if}
              {#if existing}
                <div>
                  <span class="chip {existing.status === 'draft' ? 'chip-accent' : 'chip-warn'}">{existing.status === 'draft' ? 'Draft' : 'Update'}</span>
                  <a href={existing.url} target="_blank" rel="noreferrer">{existing.title}</a>
                  {#if existing.status === 'draft'}
                    <span class="muted">v{existing.version} (draft aktif)</span>
                  {:else}
                    <span class="muted">v{existing.version} → v{existing.version + 1}</span>
                  {/if}
                </div>
              {:else}
                <div><span class="chip chip-ok">Halaman baru</span> akan dibuat{preflight.parent ? ' di bawah parent' : ' di root space'}.</div>
              {/if}
            </div>
            {#if remoteAhead}
              <div class="remote-ahead">
                <p><strong>Halaman sudah diubah langsung di Confluence</strong> (v{existing?.version}) setelah versi dasar draft ini (v{draft.confluence.version}). Publish sekarang akan menimpa perubahan itu.</p>
                <div class="row">
                  <button class="btn btn-primary btn-sm" onclick={() => (mergeOpen = true)}>Lihat & gabungkan dulu</button>
                  <label class="check"><input type="checkbox" bind:checked={overwriteRemote} /> Timpa perubahan Confluence</label>
                </div>
              </div>
            {/if}
            {#if needsConfirmExisting}
              <label class="check confirm">
                <input type="checkbox" bind:checked={confirmExisting} />
                Halaman berjudul sama sudah ada dan belum pernah dipublish dari draft ini. Saya yakin ingin meng-update halaman tersebut.
              </label>
            {/if}
          {:else if !preflightError}
            <p class="muted small">Klik <em>Cek target</em> untuk memeriksa space, parent, dan apakah halaman sudah ada.</p>
          {/if}

          <div class="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'diff'} class:active={tab === 'diff'} onclick={() => (tab = 'diff')}>
              Perbandingan {#if diff}<span class="add">+{added}</span> <span class="del">−{removed}</span>{/if}
            </button>
            <button role="tab" aria-selected={tab === 'xml'} class:active={tab === 'xml'} onclick={() => (tab = 'xml')}>Storage format</button>
            <span class="spacer"></span>
            {#if tab === 'diff' && diff && (added > 0 || removed > 0)}
              <div class="view-switch" role="group" aria-label="Tampilan perbandingan">
                <button class:active={view === 'doc'} aria-pressed={view === 'doc'} onclick={() => (view = 'doc')}>Dokumen</button>
                <button class:active={view === 'md'} aria-pressed={view === 'md'} onclick={() => (view = 'md')}>Markdown</button>
              </div>
            {/if}
          </div>
          <div class="tab-body">
            {#if tab === 'xml'}
              <pre class="xml">{storage.xhtml.replace(/></g, '>\n<')}</pre>
            {:else if diff}
              {#if !added && !removed}
                <p class="muted small pad">Konten sama dengan versi di Confluence.</p>
              {:else if view === 'doc'}
                <div class="doc-wrap">
                  <p class="legend">
                    <ins class="tc-add-sample">teks baru</ins> ditambahkan · <del class="tc-del-sample">teks lama</del> dihapus
                  </p>
                  <div class="hunks doc">
                    {#each hunks as h (h.id)}
                      {@const t = tracked.get(h.id)}
                      <section class="hunk">
                        <div class="hunk-head">
                          <span class="section">{h.section}</span>
                          {#if t?.formatOnly}<span class="fmt">format saja</span>{/if}
                          <span class="add">+{h.added}</span>
                          <span class="del">−{h.removed}</span>
                        </div>
                        <div class="doc-body">
                          <PreviewPane html={t?.html ?? ''} embedded />
                        </div>
                      </section>
                    {/each}
                  </div>
                </div>
              {:else}
                <div class="hunks">
                  {#each hunks as h (h.id)}
                    {@const lines = linesOf(h)}
                    {@const long = lines.length > COLLAPSE_AT && !expanded.has(h.id)}
                    <section class="hunk">
                      <div class="hunk-head">
                        <span class="section">{h.section}</span>
                        <span class="add">+{h.added}</span>
                        <span class="del">−{h.removed}</span>
                      </div>
                      <div class="lines mono">
                        {#each long ? lines.slice(0, COLLAPSE_AT) : lines as line, i (i)}
                          <div class="line {line.context ? 'ctx' : line.type}">
                            <span class="sign">{line.context ? ' ' : line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
                            <span>{line.text || ' '}</span>
                          </div>
                        {/each}
                        {#if long}
                          <button class="more" onclick={() => (expanded = new Set([...expanded, h.id]))}>Tampilkan {lines.length - COLLAPSE_AT} baris lagi</button>
                        {/if}
                      </div>
                    </section>
                  {/each}
                </div>
              {/if}
            {:else}
              <p class="muted small pad">{existing ? 'Konten halaman lama tidak tersedia untuk dibandingkan.' : 'Belum ada versi sebelumnya — seluruh dokumen akan menjadi halaman baru.'}</p>
              <ul class="summary small">
                <li>{storage.diagrams.length} diagram {opts.mermaid === 'attachment' ? '(diupload sebagai PNG)' : ''}</li>
                <li>{(storage.xhtml.length / 1024).toFixed(1)} KB storage format</li>
              </ul>
            {/if}
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h3>Validasi Dokumen</h3>
            {#if validation.errorCount || validation.warningCount}
              <span class="chip {validation.errorCount ? 'chip-warn' : 'chip'}">
                {validation.errorCount ? `${validation.errorCount} error` : ''}
                {validation.errorCount && validation.warningCount ? ', ' : ''}
                {validation.warningCount ? `${validation.warningCount} warning` : ''}
              </span>
            {:else}
              <span class="chip chip-ok"><Icon name="check" size={12} /> Lengkap</span>
            {/if}
          </div>
          {#if validation.errorCount || validation.warningCount}
            <div class="alert alert-warn">
              <Icon name="alert" size={16} />
              <div class="alert-content">
                <div>
                  Terdapat catatan validasi ({validation.errorCount ? `${validation.errorCount} error` : ''}{validation.errorCount && validation.warningCount ? ', ' : ''}{validation.warningCount ? `${validation.warningCount} peringatan` : ''}).
                </div>
                <div class="muted small">Dokumen tetap dapat di-publish ke Confluence.</div>
              </div>
            </div>
            {#if validation.issues.length}
              <ul class="validation-issues small">
                {#each validation.issues.slice(0, 4) as issue}
                  <li>
                    <span class="sev-tag sev-{issue.severity}">{issue.severity === 'error' ? 'Error' : 'Warn'}</span>
                    <span class="issue-msg">{issue.message}</span>
                    {#if issue.line}<span class="muted mono">L{issue.line}</span>{/if}
                  </li>
                {/each}
                {#if validation.issues.length > 4}
                  <li class="muted">+{validation.issues.length - 4} catatan lainnya di panel validasi.</li>
                {/if}
              </ul>
            {/if}
          {:else}
            <p class="ok small"><Icon name="check" size={14} /> Semua section wajib lengkap dan valid.</p>
          {/if}
        </section>

        {#if publishError}
          <p class="alert alert-err"><Icon name="error" /> {publishError}</p>
        {/if}
      </div>
    </div>
  {/if}

  {#snippet footer()}
    {#if result}
      <button class="btn" onclick={() => (open = false)}>Tutup</button>
    {:else}
      <span class="blocker small muted">{blockers[0] ?? (existing?.status === 'draft' ? 'Draft Confluence siap disimpan atau dipublish.' : 'Siap dipublish atau disimpan sebagai draft.')}</span>
      <button class="btn" onclick={() => (open = false)}>Batal</button>
      <button class="btn" onclick={() => publish(true)} disabled={blockers.length > 0 || publishing || savingDraft} title="Simpan sebagai draft di Confluence tanpa menaikkan nomor versi">
        <Icon name="save" size={14} />
        {savingDraft ? 'Menyimpan draft…' : existing ? `Simpan Draft (tetap v${existing.version})` : 'Simpan sebagai Draft'}
      </button>
      <button class="btn btn-primary" onclick={() => publish(false)} disabled={blockers.length > 0 || publishing || savingDraft}>
        <Icon name="upload" />
        {publishing ? 'Mempublish…' : existing ? (existing.status === 'draft' ? `Publish Draft (v${existing.version})` : `Update ke v${existing.version + 1}`) : 'Publish halaman baru'}
      </button>
    {/if}
  {/snippet}
</Modal>

<JiraTicketsDialog bind:open={ticketsOpen} {draft} />

<ConfluenceMergeModal
  bind:open={mergeOpen}
  {draft}
  onmerged={() => {
    overwriteRemote = false;
    void check();
  }}
/>

<style>
  .remote-ahead {
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
    font-size: 12.5px;
  }
  .remote-ahead p {
    margin: 0 0 6px;
  }
  .remote-ahead .row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 14px;
    align-items: start;
  }
  @media (max-width: 860px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .field em {
    font-style: normal;
    font-weight: 400;
  }
  .field-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text-2);
  }
  .ai-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border-radius: 4px;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .ai-btn:hover:not(:disabled) {
    background: var(--accent);
    color: var(--accent-text, #fff);
  }
  .ai-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .small-check {
    font-size: 11.5px;
    color: var(--text-3);
    margin-top: 2px;
  }
  .small {
    font-size: 12.5px;
    margin: 0;
  }
  .check {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 13px;
    cursor: pointer;
  }
  .check input {
    margin-top: 3px;
  }
  .confirm {
    padding: 10px;
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
  }
  .inline-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .inline-actions a {
    text-decoration: none;
  }
  .alert {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .alert-err {
    background: var(--err-soft);
    color: var(--err);
  }
  .alert-warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .alert-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .validation-issues {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 120px;
    overflow-y: auto;
  }
  .validation-issues li {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .sev-tag {
    display: inline-flex;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }
  .sev-error {
    background: var(--err-soft);
    color: var(--err);
  }
  .sev-warning {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .issue-msg {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ok {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ok);
  }
  .target {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    font-size: 13px;
  }
  .target div {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    padding: 6px 10px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    cursor: pointer;
    color: var(--text-2);
    font-weight: 500;
    font-size: 13px;
  }
  .tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .spacer {
    flex: 1;
  }
  .view-switch {
    display: inline-flex;
    padding: 2px;
    border-radius: 999px;
    background: var(--surface-2);
    margin-right: 4px;
  }
  .view-switch button {
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    background: none;
    color: var(--text-2);
    font-size: 11.5px;
    cursor: pointer;
  }
  .view-switch button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }
  .add {
    color: var(--ok);
    font-weight: 600;
  }
  .del {
    color: var(--err);
    font-weight: 600;
  }
  .tab-body {
    min-height: 280px;
    max-height: 440px;
    flex: 1;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .pad {
    padding: 12px;
  }
  .doc-wrap {
    padding: 10px;
  }
  .legend {
    margin: 0 0 8px;
    font-size: 12px;
    color: var(--text-2);
  }
  .tc-add-sample {
    color: #006644;
    background: #e3fcef;
    text-decoration: underline;
  }
  .tc-del-sample {
    color: #bf2600;
    background: #ffebe6;
  }
  .hunks {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hunk {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface);
  }
  .hunks.doc .hunk {
    background: var(--page-bg);
  }
  .hunk-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
  }
  .section {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fmt {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text-2);
    font-size: 11px;
    font-weight: 500;
  }
  .doc-body {
    max-height: 45vh;
    overflow: auto;
  }
  .lines {
    font-size: 11.5px;
    line-height: 1.5;
  }
  .line {
    display: flex;
    gap: 8px;
    padding: 0 10px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .line .sign {
    width: 10px;
    flex-shrink: 0;
    font-weight: 700;
  }
  .line.ctx {
    color: var(--text-3);
  }
  .line.add {
    background: var(--ok-soft);
  }
  .line.del {
    background: var(--err-soft);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--err) 50%, transparent);
  }
  .more {
    width: 100%;
    padding: 6px;
    border: 0;
    border-top: 1px dashed var(--border);
    background: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 11.5px;
  }
  .pad {
    padding: 12px;
  }
  .summary {
    margin: 0;
    padding: 0 12px 12px 30px;
    color: var(--text-2);
  }
  .xml {
    margin: 0;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .blocker {
    flex: 1;
  }
  .done {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 32px 0;
    text-align: center;
  }
  .done-icon {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--ok-soft);
    color: var(--ok);
  }
  .done h3 {
    font-size: 18px;
    text-transform: none;
    letter-spacing: 0;
    color: var(--text);
  }
  .done a {
    text-decoration: none;
  }
  .next-step {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 560px;
    margin-top: 8px;
    padding: 10px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    font-size: 12.5px;
    text-align: left;
  }
</style>
