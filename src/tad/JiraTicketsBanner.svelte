<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { parseScopeTasks } from '../lib/tad/task-links';
  import JiraTicketsDialog from './JiraTicketsDialog.svelte';
  import type { Draft } from './drafts.svelte';

  /**
   * Tasks added to the scope after the tickets were made have no Jira ticket: point them out (only
   * for TADs that already use Jira, i.e. some tasks have a key) and offer to create them.
   */
  let { draft }: { draft: Draft } = $props();

  const DISMISS_KEY = 'tlc.jiraTickets.dismissed';
  const tasks = $derived(parseScopeTasks(draft.markdown));
  const missing = $derived(tasks.filter((t) => !t.jiraKeys.length));
  const usesJira = $derived(tasks.some((t) => t.jiraKeys.length));
  /** Dismissing hides the banner until another task without a ticket shows up. */
  const signature = $derived(`${draft.id}:${missing.map((t) => t.title).join('|')}`);
  let dismissed = $state(readDismissed());
  let dialogOpen = $state(false);

  function readDismissed(): string {
    try {
      return localStorage.getItem(DISMISS_KEY) ?? '';
    } catch {
      return '';
    }
  }

  function dismiss() {
    dismissed = signature;
    try {
      localStorage.setItem(DISMISS_KEY, signature);
    } catch {
      /* the banner just comes back next time */
    }
  }
</script>

{#if usesJira && missing.length && dismissed !== signature}
  <div class="banner" role="status">
    <Icon name="jira" size={15} />
    <span>
      <strong>{missing.length} task belum punya tiket Jira</strong>
      ({missing
        .slice(0, 2)
        .map((t) => t.title.replace(/^(\s*\[[^\]]*\])+\s*-?\s*/, ''))
        .join(', ')}{missing.length > 2 ? `, +${missing.length - 2} lainnya` : ''}), kemungkinan karena scope berubah.
    </span>
    <button class="btn btn-primary btn-sm" onclick={() => (dialogOpen = true)}>Buat tiket</button>
    <button class="btn btn-ghost btn-sm" onclick={dismiss}>Nanti</button>
  </div>
{/if}

<JiraTicketsDialog bind:open={dialogOpen} {draft} />

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 16px 0;
    padding: 8px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    font-size: 12.5px;
  }
  .banner span {
    flex: 1;
    min-width: 0;
  }
</style>
