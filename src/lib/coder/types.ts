import type { AiSelection } from '../ai/types';

export type CoderProfileId = 'backend' | 'frontend';

export interface CoderProfile {
  id: CoderProfileId;
  label: string;
  ai: AiSelection;
  /** Role and working rules given to the agent before the task spec. */
  instructions: string;
}

export interface CoderSettings {
  /** Runs working at the same time (1–4). Runs on the same repo always wait for each other. */
  concurrency: number;
}

export interface StartCoderRunRequest {
  draftId: string;
  tadTitle: string;
  taskTitle: string;
  jiraKey?: string;
  profile: CoderProfileId;
  /** Folder name inside the Services root, e.g. core-tcico-ultimate. */
  repo: string;
  /** Branch the work starts from (TAD convention: staging or development). */
  baseBranch?: string;
  /** Target branch to merge into via MR (default: staging or same as baseBranch). */
  targetBranch?: string;
  /** Detail Task spec as plain text (for a bug fix: the analysis and fix plan). */
  spec: string;
  /** A TAD task (default) or a bug fix from Bug Tracing (fix/ branch, test-first prompt). */
  kind?: 'task' | 'bugfix';
  /** Where the run was started from when not a TAD task, e.g. a failed E2E test case. */
  source?: CoderRunSource;
  /** Branch name chosen by the user (validated by branchNameError); default from branchName. */
  branch?: string;
}

/** A bug fix started from a failed E2E test case ("Perbaiki kode"), no ticket involved. */
export interface CoderRunSource {
  kind: 'e2e';
  projectId: string;
  flowId: string;
  flowName: string;
  /** Every test case the run fixes when started for several at once (flowId is the first). */
  flowIds?: string[];
  /** The E2E run whose failure the fix starts from. */
  qaRunId: string;
}

export type CoderRunStatus = 'queued' | 'preparing' | 'running' | 'testing' | 'needs-input' | 'ready' | 'pushed' | 'completed' | 'failed' | 'cancelled';

export interface CoderRunEvent {
  at: string;
  kind: 'info' | 'ai' | 'tool' | 'error' | 'jira';
  text: string;
}

export type CoderReviewVerdict = 'APPROVE' | 'APPROVE_WITH_COMMENTS' | 'REQUEST_CHANGES';

export interface CoderAiReview {
  at: string;
  verdict?: CoderReviewVerdict;
  text: string;
  provider?: string;
  model?: string;
  strictness?: 'lenient' | 'standard' | 'strict';
  customInstruction?: string;
}

export interface CoderRun {
  id: string;
  draftId: string;
  tadTitle: string;
  taskTitle: string;
  jiraKey?: string;
  profile: CoderProfileId;
  ai: AiSelection;
  repo: string;
  baseBranch: string;
  targetBranch: string;
  branch: string;
  /** Cockpit's own clone for this run. */
  worktree: string;
  spec: string;
  kind?: 'task' | 'bugfix';
  source?: CoderRunSource;
  status: CoderRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pushedAt?: string;
  events: CoderRunEvent[];
  origin?: string;
  baseSha?: string;
  headSha?: string;
  sessionId?: string;
  reply?: string;
  error?: string;
  changedFiles?: { path: string; additions: number; deletions: number }[];
  test?: { command: string; exitCode: number; output: string };
  jira?: { started?: string; review?: string; completed?: string };
  /** GitLab "new merge request" page for the pushed branch (opened by the user as Draft). */
  mrCreateUrl?: string;
  revisions: number;
  /** The run's entry in the shared Agent Tasks list (a revision after push gets a new one). */
  agentTaskId?: string;
  /** AI code review result of the agent's changes against TAD spec. */
  aiReview?: CoderAiReview;
}

export interface CoderState {
  runs: CoderRun[];
  settings: CoderSettings;
  profiles: Record<CoderProfileId, CoderProfile>;
}
