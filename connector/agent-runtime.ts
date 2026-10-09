import { AgentTaskStore } from './agent-tasks.ts';

/**
 * The connector's shared Agent Tasks list: Cockpit's local coding-agent runs (TAD tasks and bug
 * fixes), mirrored into the store by coder-agent-sync. coder-runs is the engine; this is only
 * the index the Agent Tasks page and the mobile API read.
 */

/** The slice of the runtime the connector routes use; tests inject fakes of this shape. */
export interface AgentRuntime {
  store: Pick<AgentTaskStore, 'list' | 'get' | 'create' | 'update'>;
}

let singleton: AgentRuntime | undefined;

export function agentRuntime(config: { tasksDir?: string } = {}): AgentRuntime {
  singleton ??= { store: new AgentTaskStore(config.tasksDir ? { dir: config.tasksDir } : {}) };
  return singleton;
}
