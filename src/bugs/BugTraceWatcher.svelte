<script lang="ts">
  import { toasts } from '../components/toast.svelte';
  import { bugs } from '../lib/bugs/client';
  import { traces } from '../lib/trace/client';
  import type { BugJob } from '../lib/bugs/types';

  /**
   * Tracing runs in the background, so the result may land while another page is open: this
   * watches the connector's bug tracing jobs and code traces, and announces each one that
   * finishes, with a link.
   */
  const FAST_MS = 4_000;
  const SLOW_MS = 15_000;

  $effect(() => {
    const seen = new Map<string, BugJob['status']>();
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    async function tick() {
      const jobs = await bugs.jobs().catch(() => null);
      if (stopped) return;
      for (const j of jobs ?? []) {
        const before = seen.get(j.id);
        if (!first && before === 'running' && j.status !== 'running') {
          const title = j.caseTitle ? `"${j.caseTitle}"` : 'bug';
          const href = `#/bugs/${j.caseId}`;
          if (j.status === 'done') toasts.show(`Agent tracing selesai untuk ${title}. Analisa dan usulan task siap direview.`, 'ok', 15_000, { label: 'Lihat analisa', href });
          else if (j.status === 'error') toasts.show(`Agent tracing gagal untuk ${title}: ${j.error ?? 'tanpa keterangan'}`, 'err', 15_000, { label: 'Buka bug', href });
        }
        seen.set(j.id, j.status);
      }
      first = false;
      const running = (jobs ?? []).some((j) => j.status === 'running');
      timer = setTimeout(() => void tick(), running ? FAST_MS : SLOW_MS);
    }

    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  // Code traces (Agent Tasks): one toast per question that finishes.
  $effect(() => {
    const seen = new Map<string, string>();
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    async function tick() {
      const list = await traces.list().catch(() => null);
      if (stopped) return;
      let running = false;
      for (const t of list ?? []) {
        for (const turn of t.turns) {
          if (turn.status === 'running') running = true;
          if (!first && seen.get(turn.id) === 'running' && turn.status !== 'running') {
            const q = `"${turn.question.split('\n')[0].slice(0, 60)}"`;
            if (turn.status === 'done') toasts.show(`Trace selesai: ${q}.`, 'ok', 15_000, { label: 'Lihat di Agent Tasks', href: '#/agents' });
            else if (turn.status === 'error') toasts.show(`Trace gagal: ${q}: ${turn.error ?? 'tanpa keterangan'}`, 'err', 15_000, { label: 'Agent Tasks', href: '#/agents' });
          }
          seen.set(turn.id, turn.status);
        }
      }
      first = false;
      timer = setTimeout(() => void tick(), running ? FAST_MS : SLOW_MS);
    }

    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });
</script>
