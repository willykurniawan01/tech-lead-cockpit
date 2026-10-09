// Code trace: a free question about existing code ("how does refund work from callback to
// balance?"), answered in the background by an AI that reads the Services codebase read-only.
// Each trace is listed in Agent Tasks; follow-up questions continue the same thread.

import type { AiSelection } from '../ai/types';

export type TraceStatus = 'running' | 'done' | 'error' | 'cancelled';
export type TraceConfidence = 'low' | 'medium' | 'high';
export type FindingKind = 'bug' | 'risk' | 'gap' | 'question';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface TraceEvidence {
  /** Path relative to the Services root, e.g. core-payment/internal/refund/service.go. */
  file: string;
  line?: number;
  note: string;
  /** Checked by the connector after the answer: the file exists and the line is in range. */
  verified: boolean;
  /** A few lines around `line` from the real file (only when verified). */
  snippet?: string;
}

export interface TraceFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

/** One question and its answer; a trace is a thread of these. */
export interface TraceTurn {
  id: string;
  question: string;
  askedAt: string;
  ai: AiSelection;
  status: TraceStatus;
  /** Last progress line while running. */
  progress?: string;
  error?: string;
  answeredAt?: string;
  /** Markdown. */
  answer?: string;
  confidence?: TraceConfidence;
  /** Mermaid flow/sequence diagram, when the question is about a flow. */
  diagram?: string;
  services?: string[];
  evidence?: TraceEvidence[];
  findings?: TraceFinding[];
  openQuestions?: string[];
  /** Branch and commit of each service the answer cites, at the time it was traced. */
  versions?: { repo: string; branch: string; commit: string }[];
  /** Repos whose working tree changed during the trace (should be empty: read-only). */
  touchedRepos?: string[];
  rawReply?: string;
  /** Agent Tasks entry for this turn. */
  agentTaskId?: string;
}

export interface Trace {
  id: string;
  title: string;
  turns: TraceTurn[];
  createdAt: string;
  updatedAt: string;
}

export const FINDING_LABELS: Record<FindingKind, string> = { bug: 'Bug', risk: 'Risiko', gap: 'Celah', question: 'Perlu dikonfirmasi' };
