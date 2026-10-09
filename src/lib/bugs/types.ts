// Bug tracing: a case is written up by hand (report + pasted/uploaded logs) and sent to the
// tracing agent, which traces it in the background through the codebase (read-only) to a root
// cause with file:line evidence and proposes fix tasks per service. Only after that analysis
// the Tech Lead turns each task into a Jira ticket and lets a coding agent fix it (test first).

import type { AiSelection } from '../ai/types';
import { formatTaskTitle, parseTaskTitle, type TaskType } from '../tad/template';

export type BugStatus = 'draft' | 'analyzing' | 'analyzed' | 'ticketed' | 'fixing' | 'fixed';
export type BugSeverity = 'critical' | 'high' | 'medium' | 'low';
export type Confidence = 'low' | 'medium' | 'high';

export interface BugLog {
  name: string;
  size: number;
  lines: number;
  addedAt: string;
}

export interface BugEvidence {
  /** Path relative to the Services root, e.g. core-promo-ultimate/internal/promo/service.go. */
  file: string;
  line?: number;
  note: string;
}

export type BugAgentProfile = 'backend' | 'frontend';

/** A fix task the tracing agent proposes: one per service/repo that needs a change. */
export interface BugTaskProposal {
  title: string;
  /** Service folder in the Services root. */
  repo: string;
  profile: BugAgentProfile;
  fixPlan: string;
  testPlan: string;
  jiraSummary: string;
  jiraDescription: string;
}

export type BugTaskStatus = 'proposed' | 'ticketed' | 'fixing' | 'fixed';

/** A fix task of a case: proposed by the analysis, edited by the Tech Lead, then ticketed and fixed. */
export interface BugTask extends BugTaskProposal {
  id: string;
  status: BugTaskStatus;
  jira?: { key: string; url: string; createdAt: string };
  /** Coding-agent runs started for this task. */
  coderRunIds: string[];
}

export interface BugAnalysis {
  at: string;
  ai: AiSelection;
  summary: string;
  rootCause: string;
  confidence: Confidence;
  severity: BugSeverity;
  /** Services involved, as folder names in the Services root. */
  services: string[];
  /** Repo the fix most likely belongs to (folder in the Services root). */
  repo?: string;
  evidence: BugEvidence[];
  /** Lines from the logs that point at the cause. */
  logSignals: string[];
  fixPlan: string;
  testPlan: string;
  /** Things the AI could not confirm; questions for the team. */
  openQuestions: string[];
  jiraSummary: string;
  jiraDescription: string;
  /** Fix tasks per service; at least one. */
  tasks: BugTaskProposal[];
  /** Repos whose working tree changed during the analysis (should be empty: read-only). */
  touchedRepos?: string[];
}

export interface BugCase {
  id: string;
  title: string;
  description: string;
  steps: string;
  expected: string;
  actual: string;
  /** e.g. staging, production, app version. */
  environment: string;
  /** Optional hint where to start looking (service folder name). */
  serviceHint: string;
  logs: BugLog[];
  status: BugStatus;
  analysis?: BugAnalysis;
  /** Fix tasks from the analysis; empty until the tracing agent has finished. */
  tasks: BugTask[];
  /** @deprecated Cases from before per-task tickets; migrated into `tasks` on read. */
  jira?: { key: string; url: string; createdAt: string };
  /** All coding-agent runs of the case (draftId `bug-<id>` in the coder). */
  coderRunIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type BugCaseInput = Pick<BugCase, 'title' | 'description' | 'steps' | 'expected' | 'actual' | 'environment' | 'serviceHint'>;

export interface BugJob {
  id: string;
  caseId: string;
  /** Case title when the job started, for the Agent Tasks list. */
  caseTitle?: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  progress?: string;
  error?: string;
  rawReply?: string;
}

export interface BugAnalyzeRequest {
  caseId: string;
  ai: AiSelection;
  /** Read the Services codebase (read-only); off = analyse from the report and logs only. */
  useCodebase: boolean;
  servicesRoot?: string;
  instructions?: string;
}

export interface BugTicketRequest {
  caseId: string;
  taskId: string;
  projectKey: string;
  issueType: string;
  summary: string;
  description: string;
  priority?: string;
}

/** Coder draft id for a bug case, so its runs can be listed per case. */
export const bugDraftId = (caseId: string) => `bug-${caseId}`;

export const STATUS_LABELS: Record<BugStatus, string> = {
  draft: 'Draft',
  analyzing: 'Tracing',
  analyzed: 'Siap dibuat task',
  ticketed: 'Ada tiket',
  fixing: 'Diperbaiki',
  fixed: 'Selesai',
};

export const TASK_STATUS_LABELS: Record<BugTaskStatus, string> = {
  proposed: 'Usulan',
  ticketed: 'Ada tiket',
  fixing: 'Diperbaiki',
  fixed: 'Selesai',
};

/** A web portal/CMS or app repo is frontend work; everything else backend. */
/** CODENAME of every bug-fix ticket (the team files bug fixes under tech debt). */
export const BUGFIX_CODENAME = 'TECH-DEBT';

const tag = (v: string) => v.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Task type of a fix in this repo: BACKEND, or MOBILE-FE / WEB-FE for front ends. */
export function bugTaskType(repo: string, profile: BugAgentProfile): TaskType {
  if (profile === 'backend') return 'BACKEND';
  return /mobile|android|ios|flutter|\bapp\b|-app\b|app-/i.test(repo) ? 'MOBILE-FE' : 'WEB-FE';
}

/**
 * A bug ticket title in the team's task format, `[TYPE][SERVICE][TECH-DEBT] - Fix …`: TYPE from
 * the repo's profile, SERVICE = the repo the fix goes to, CODENAME always TECH-DEBT. A title
 * already in the format keeps its type and name.
 */
export function bugTicketTitle(summary: string, repo: string, profile: BugAgentProfile): string {
  const parsed = parseTaskTitle(summary);
  const type = parsed?.normalizedType ?? bugTaskType(repo, profile);
  const service = tag(repo) || tag(parsed?.service ?? '') || 'SERVICE';
  const code = BUGFIX_CODENAME;
  let name = (parsed?.name ?? summary.replace(/^(\s*\[[^\]]*\])+\s*[-–—:]?\s*/, '')).trim() || 'Perbaikan bug';
  if (!/^(fix|hotfix|bugfix|perbaik)/i.test(name)) name = `Fix ${name}`;
  return formatTaskTitle(type, service, code, name).slice(0, 250);
}

export function profileForRepo(repo: string): BugAgentProfile {
  return /portal|cms|web|frontend|fe-|-fe\b|dashboard|app\b|mobile/i.test(repo) ? 'frontend' : 'backend';
}
