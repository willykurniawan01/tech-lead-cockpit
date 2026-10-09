<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import Modal from '../components/Modal.svelte';
  import { toasts } from '../components/toast.svelte';
  import { coder } from '../lib/coder/client';
  import type { CoderRun } from '../lib/coder/types';
  import { detailTaskSpec, extractTadFlowSteps, type TadFlowStep } from '../lib/tad/task-links';
  import type { Draft } from '../tad/drafts.svelte';

  let {
    open = $bindable(false),
    run,
    draft,
    onupdate,
    onshowdiff,
  }: {
    open: boolean;
    run: CoderRun | null;
    draft: Draft;
    onupdate?: () => void;
    onshowdiff?: (run: CoderRun) => void;
  } = $props();

  let runningTests = $state(false);
  let generatingTests = $state(false);
  let showCustomPrompt = $state(false);
  let customInstructions = $state('');

  const spec = $derived(run ? detailTaskSpec(draft.markdown, run.taskTitle) : undefined);
  const flowSteps = $derived<TadFlowStep[]>(spec ? extractTadFlowSteps(spec) : []);

  async function handleRunTests() {
    if (!run) return;
    runningTests = true;
    try {
      const res = await coder.runTests(run.id);
      if (run) run.test = res;
      toasts.show(res?.exitCode === 0 ? 'Unit test lulus (exit 0)!' : 'Unit test gagal (exit non-zero).', res?.exitCode === 0 ? 'ok' : 'err');
      onupdate?.();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      runningTests = false;
    }
  }

  async function handleGenerateFlowTests() {
    if (!run) return;
    generatingTests = true;
    try {
      await coder.generateFlowTests(run.id, customInstructions.trim() || undefined);
      toasts.show('Agent mulai membuat unit test sesuai flow TAD.', 'ok');
      open = false;
      onupdate?.();
    } catch (e) {
      toasts.show((e as Error).message, 'err');
    } finally {
      generatingTests = false;
    }
  }

  function copyOutput() {
    if (!run?.test?.output) return;
    void navigator.clipboard.writeText(run.test.output);
    toasts.show('Output test disalin ke clipboard.', 'ok');
  }
</script>

{#if run}
  <Modal
    bind:open
    title="Unit Test Flow TAD"
    subtitle="{run.taskTitle} · {run.repo} ({run.branch})"
    width={960}
  >
    <div class="modal-body">
      <!-- Section 1: TAD Flow Overview -->
      <section class="flow-section">
        <div class="section-head">
          <div class="section-title">
            <Icon name="list" size={14} />
            <h4>Alur Teknis (Flow) dari Spesifikasi TAD</h4>
          </div>
          <span class="step-count">{flowSteps.length} tahapan flow teridentifikasi</span>
        </div>

        {#if flowSteps.length === 0}
          <p class="muted small">Tidak ditemukan rincian Technical Implementation di Detail Task TAD ini.</p>
        {:else}
          <div class="flow-steps-grid">
            {#each flowSteps as step (step.number + step.title)}
              <div class="flow-card">
                <div class="flow-card-head">
                  <span class="step-badge">Tahap {step.number}</span>
                  <span class="step-title">{step.title}</span>
                </div>
                <p class="step-detail">{step.detail}</p>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- Section 2: Current Unit Test Status -->
      <section class="test-status-section">
        <div class="section-head">
          <div class="section-title">
            <Icon name="code" size={14} />
            <h4>Status Eksekusi Test di Repo</h4>
          </div>
          <div class="head-controls">
            {#if run.test}
              <span class="test-badge {run.test.exitCode === 0 ? 'badge-pass' : 'badge-fail'}">
                {run.test.exitCode === 0 ? '✓ Lulus (Exit 0)' : `✗ Gagal (Exit ${run.test.exitCode})`}
              </span>
            {:else}
              <span class="test-badge badge-none">Belum diuji</span>
            {/if}
            <button
              type="button"
              class="btn btn-xs"
              onclick={handleRunTests}
              disabled={runningTests || generatingTests}
              title="Jalankan perintah test repo sekarang"
            >
              <Icon name="refresh" size={11} />
              <span>{runningTests ? 'Menjalankan…' : 'Jalankan Test Sekarang'}</span>
            </button>
          </div>
        </div>

        {#if run.test}
          <div class="command-bar">
            <span class="label">Perintah:</span>
            <code class="command-text">{run.test.command}</code>
            <button type="button" class="btn btn-xs btn-ghost copy-btn" onclick={copyOutput} title="Salin output terminal">
              <Icon name="copy" size={11} /> Salin Log
            </button>
          </div>
          <pre class="terminal-box">{run.test.output || '(Tidak ada output terminal)'}</pre>
        {:else}
          <div class="empty-test">
            <p class="muted small">Belum ada hasil test yang tersimpan untuk branch ini. Klik tombol di atas untuk menjalankan test lokal.</p>
          </div>
        {/if}
      </section>

      <!-- Section 3: Generator Action -->
      <section class="generator-box">
        <div class="generator-header">
          <div>
            <h5>Lengkapi Unit Test Sesuai Flow TAD</h5>
            <p class="muted small">
              Minta agent menulis file test (happy path, validasi parameter error, branching reject, & mock dependency) yang mencakup seluruh poin flow TAD di atas.
            </p>
          </div>
          <div class="generator-actions">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onclick={() => (showCustomPrompt = !showCustomPrompt)}
            >
              <Icon name="edit" size={12} />
              <span>{showCustomPrompt ? 'Tutup Catatan' : 'Tambah Catatan Tambahan'}</span>
            </button>
            <button
              type="button"
              class="btn btn-sm btn-primary"
              onclick={handleGenerateFlowTests}
              disabled={generatingTests || runningTests}
            >
              <Icon name="sparkles" size={13} />
              <span>{generatingTests ? 'Menyiapkan…' : 'Generate Unit Test Flow TAD'}</span>
            </button>
          </div>
        </div>

        {#if showCustomPrompt}
          <div class="prompt-input-wrap">
            <textarea
              class="input custom-input"
              rows="3"
              bind:value={customInstructions}
              placeholder="Catatan tambahan untuk agent (misal: 'pastikan mock repository X menggunakan nilai return Y', 'tambah assertion untuk field Z')…"
            ></textarea>
          </div>
        {/if}
      </section>
    </div>

    {#snippet footer()}
      <div class="modal-footer-bar">
        <div class="footer-left">
          {#if onshowdiff}
            <button
              type="button"
              class="btn btn-sm"
              onclick={() => {
                const target = run;
                open = false;
                if (target) onshowdiff(target);
              }}
            >
              <Icon name="eye" size={12} /> Lihat Diff & Kesesuaian TAD
            </button>
          {/if}
        </div>
        <button type="button" class="btn btn-sm btn-ghost" onclick={() => (open = false)}>
          Tutup
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

<style>
  .modal-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 2px 0;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }
  .section-title {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  h5 {
    margin: 0 0 3px 0;
    font-size: 13.5px;
    font-weight: 600;
  }
  .step-count {
    font-size: 11.5px;
    color: var(--text-3);
  }
  .flow-steps-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 10px;
    max-height: 240px;
    overflow-y: auto;
    padding-right: 2px;
  }
  .flow-card {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 10px 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .flow-card-head {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .step-badge {
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--brand-subtle, rgba(59, 130, 246, 0.15));
    color: var(--brand, #3b82f6);
    font-size: 10.5px;
    font-weight: 600;
    white-space: nowrap;
  }
  .step-title {
    font-weight: 500;
    font-size: 12.5px;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-detail {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-2);
    line-height: 1.45;
  }
  .head-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .test-badge {
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
  }
  .badge-pass {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .badge-fail {
    background: var(--err-soft);
    color: var(--err);
  }
  .badge-none {
    background: var(--surface-2);
    color: var(--text-3);
  }
  .command-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    font-size: 12px;
  }
  .label {
    color: var(--text-3);
    font-weight: 500;
  }
  .command-text {
    flex: 1;
    font-family: var(--font-mono, monospace);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .terminal-box {
    margin: 0;
    padding: 12px;
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid var(--border);
    border-radius: 0 0 8px 8px;
    font-family: var(--font-mono, monospace);
    font-size: 11.5px;
    line-height: 1.45;
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .empty-test {
    padding: 18px;
    border: 1px dashed var(--border);
    border-radius: 8px;
    text-align: center;
  }
  .generator-box {
    padding: 14px 16px;
    border: 1px solid var(--brand, #3b82f6);
    background: var(--brand-subtle, rgba(59, 130, 246, 0.05));
    border-radius: 12px;
  }
  .generator-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .generator-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .prompt-input-wrap {
    margin-top: 10px;
  }
  .custom-input {
    width: 100%;
    font-size: 12px;
  }
  .modal-footer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }
</style>
