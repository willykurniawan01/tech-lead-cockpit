<script lang="ts">
  import { flowChange, suiteFieldChange, type ChangeRow, type RowKind } from '../lib/qa/change-view';
  import type { QAFlow, QASuiteChange } from '../lib/qa/types';

  /** One reviewed change in words: fields "before → after" and step by step, no JSON. */
  let { change }: { change: QASuiteChange } = $props();

  let showSame = $state(false);
  let showJson = $state(false);

  const isSuite = $derived(change.key.startsWith('suite:'));
  const flow = $derived(isSuite ? null : flowChange(change.before as QAFlow | undefined, change.after as QAFlow | undefined));
  const suiteRows = $derived(isSuite ? suiteFieldChange(change.key.slice(6), change.before, change.after) : []);
  const visible = (rows: ChangeRow[]) => (showSame || change.kind !== 'changed' ? rows : rows.filter((r) => r.kind !== 'same'));
  const STEP_LABEL: Record<RowKind, string> = { added: 'Baru', removed: 'Dihapus', changed: 'Diubah', same: 'Tetap' };
  const json = (v: unknown) => (v === undefined ? '(tidak ada)' : JSON.stringify(v, null, 2));
</script>

{#snippet rows(list: ChangeRow[])}
  <div class="rows">
    {#each list as r, i (i)}
      <div class="row {r.kind}">
        {#if r.label}<span class="label">{r.label}</span>{/if}
        <span class="vals">
          {#if r.kind === 'changed'}
            <span class="before">{r.before}</span><span class="arrow">→</span><span class="after">{r.after}</span>
          {:else if r.kind === 'added'}
            <span class="sign">+</span><span class="after">{r.after}</span>
          {:else if r.kind === 'removed'}
            <span class="sign">−</span><span class="before">{r.before}</span>
          {:else}
            <span class="same">{r.after}</span>
          {/if}
        </span>
      </div>
    {/each}
  </div>
{/snippet}

<div class="detail">
  {#if isSuite}
    {@render rows(suiteRows)}
  {:else if flow}
    {@const fields = visible(flow.fields)}
    {#if fields.length}
      <h4>Test case</h4>
      {@render rows(fields)}
    {/if}
    {#if flow.steps.length}
      <h4>Step</h4>
      <ol class="steps">
        {#each flow.steps as st, i (i)}
          <li class="step {st.kind}">
            <div class="step-head">
              <span class="tag {st.kind}">{STEP_LABEL[st.kind]}</span>
              <strong>{st.title}</strong>
              <span class="mono muted">{st.endpoint}</span>
            </div>
            {#if st.kind !== 'same' || showSame}
              {#each st.sections as sec (sec.title)}
                {@const list = st.kind === 'changed' && !showSame ? sec.rows.filter((r) => r.kind !== 'same') : sec.rows}
                {#if list.length}
                  <div class="section">
                    <span class="sec-title">{sec.title}</span>
                    {@render rows(list)}
                  </div>
                {/if}
              {/each}
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
  <div class="tools">
    {#if change.kind === 'changed' && !isSuite}
      <label class="check small"><input type="checkbox" bind:checked={showSame} /> Tampilkan juga yang tidak berubah</label>
    {/if}
    <button class="btn btn-ghost btn-sm" onclick={() => (showJson = !showJson)}>{showJson ? 'Sembunyikan JSON' : 'JSON'}</button>
  </div>
  {#if showJson}
    <div class="compare">
      <div><span class="muted small">Di Confluence</span><pre>{json(change.before)}</pre></div>
      <div><span class="muted small">Draft di laptop ini</span><pre>{json(change.after)}</pre></div>
    </div>
  {/if}
</div>

<style>
  .detail {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12.5px;
  }
  h4 {
    margin: 6px 0 0;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-3);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(120px, 220px) 1fr;
    gap: 10px;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
  }
  .row:not(:has(.label)) {
    grid-template-columns: 1fr;
  }
  .label {
    color: var(--text-2);
    word-break: break-word;
  }
  .vals {
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .before {
    background: var(--err-soft);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--err) 60%, transparent);
    padding: 0 3px;
    border-radius: 3px;
  }
  .after {
    background: var(--ok-soft);
    padding: 0 3px;
    border-radius: 3px;
  }
  .arrow,
  .sign {
    margin: 0 6px;
    color: var(--text-3);
  }
  .same {
    color: var(--text-3);
  }
  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .step {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
  }
  .step.same {
    border-style: dashed;
  }
  .step-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .tag {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--surface-2);
  }
  .tag.added {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .tag.removed {
    background: var(--err-soft);
    color: var(--err);
  }
  .tag.changed {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .section {
    margin-top: 6px;
  }
  .sec-title {
    display: block;
    font-weight: 600;
    margin-bottom: 2px;
  }
  .tools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .compare {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
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
    .row,
    .compare {
      grid-template-columns: 1fr;
    }
  }
</style>
