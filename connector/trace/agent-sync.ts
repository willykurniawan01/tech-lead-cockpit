import type { Trace, TraceTurn } from '../../src/lib/trace/types.ts';
import type { AgentTaskStatus, AgentTaskStore } from '../agent-tasks.ts';

const TERMINAL = new Set<AgentTaskStatus>(['completed', 'failed', 'cancelled']);
const STATUS: Record<TraceTurn['status'], AgentTaskStatus> = { running: 'running', done: 'completed', error: 'failed', cancelled: 'cancelled' };

/** First sentence of the answer, without Markdown, for the task card. */
function summaryOf(answer: string): string {
  const text = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const end = text.search(/[.!?](\s|$)/);
  return (end > 0 ? text.slice(0, end + 1) : text).slice(0, 300);
}

/**
 * Keeps a trace question visible in Agent Tasks (kind `trace`, runner `local`): one entry per
 * question, so a follow-up after a finished answer shows up as its own task.
 */
export async function syncTraceTurn(store: Pick<AgentTaskStore, 'get' | 'create' | 'update'>, trace: Trace, turn: TraceTurn): Promise<string> {
  let task = turn.agentTaskId ? await store.get(turn.agentTaskId) : undefined;
  if (!task) {
    const followUp = trace.turns.findIndex((t) => t.id === turn.id) > 0;
    ({ task } = await store.create({
      title: followUp ? `Lanjutan · ${turn.question.split('\n')[0].slice(0, 120)}` : trace.title,
      prompt: turn.question,
      provider: turn.ai.provider,
      model: turn.ai.model || undefined,
      status: 'queued',
      approvalPolicy: 'review_required',
      kind: 'trace',
      runner: 'local',
      links: { traceId: trace.id },
      idempotencyKey: `trace-${turn.id}`,
    }));
  }
  if (TERMINAL.has(task.status)) return task.id;
  const status = STATUS[turn.status];
  const message =
    turn.status === 'running'
      ? turn.progress || 'Menelusuri codebase…'
      : turn.status === 'done'
        ? summaryOf(turn.answer ?? '') || 'Jawaban siap.'
        : turn.status === 'cancelled'
          ? 'Dibatalkan.'
          : 'Trace gagal.';
  await store.update(task.id, { status, progress: { message }, error: turn.status === 'error' ? (turn.error ?? 'Gagal.').slice(0, 2_000) : null });
  return task.id;
}
