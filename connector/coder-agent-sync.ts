import type { CoderRun } from '../src/lib/coder/types.ts';
import type { AgentTaskStore } from './agent-tasks.ts';
import { agentStatusOf, CODER_PHASE } from './coder-runs.ts';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * Keeps a local coding run visible in the shared Agent Tasks list (kind `implement`, runner
 * `local`). coder-runs stays the engine; this is its index entry.
 * Returns the agent task id the run is tracked under (a revision after a finished task gets a new one).
 */
export async function syncCoderRun(store: Pick<AgentTaskStore, 'get' | 'create' | 'update'>, run: CoderRun): Promise<string> {
  const status = agentStatusOf(run);
  const last = run.events.at(-1)?.text;
  const busy = ['running', 'testing', 'preparing'].includes(run.status);
  const isMerged = run.events.some((e) => /merged/i.test(e.text));
  const progress = {
    message: isMerged
      ? '🟢 Selesai: MR sudah merged di GitLab'
      : run.error
        ? `${CODER_PHASE[run.status]}: ${run.error}`
        : `${CODER_PHASE[run.status]}${last && busy ? ` — ${last}` : ''}`,
  };
  const links = {
    draftId: run.draftId,
    tadTitle: run.tadTitle,
    taskTitle: run.taskTitle,
    jiraKey: run.jiraKey,
    repo: run.repo,
    branch: run.branch,
    mrUrl: run.mrCreateUrl,
    coderRunId: run.id,
  };
  let task = run.agentTaskId ? await store.get(run.agentTaskId) : undefined;
  if (!task || (TERMINAL.has(task.status) && task.status !== status)) {
    ({ task } = await store.create({
      title: run.revisions ? `Revisi #${run.revisions} · ${run.taskTitle}` : run.taskTitle,
      prompt: `Implementasikan task TAD "${run.taskTitle}" di repo ${run.repo} (branch ${run.branch}).\n\n${run.spec.slice(0, 4_000)}`,
      provider: run.ai.provider,
      model: run.ai.model || undefined,
      status: 'queued',
      approvalPolicy: 'review_required',
      kind: 'implement',
      runner: 'local',
      links,
      idempotencyKey: `coder-${run.id}-${run.revisions}`,
    }));
  }
  if (!TERMINAL.has(task.status)) await store.update(task.id, { status, progress, error: run.error ?? null, links });
  return task.id;
}
