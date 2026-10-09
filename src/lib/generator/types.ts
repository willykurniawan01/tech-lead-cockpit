/** Contract for AI generator jobs between the TAD chat pane and the local connector. */

import type { AiSelection } from '../ai/types';

export type GeneratorJobStatus = 'running' | 'done' | 'error' | 'cancelled';

/** brainstorm: agree on scope in SCOPE.md first; edit: write the TAD. */
export type GeneratorJobKind = 'brainstorm' | 'edit';

export interface GeneratorJobEvent {
  /** Milliseconds since the job started. */
  at: number;
  kind: 'text' | 'tool' | 'tool-error' | 'info';
  text: string;
}

export interface GeneratorJobResult {
  reply: string;
  updatedTadMarkdown?: string;
  changed: boolean;
  error?: string;
  updatedScopeMarkdown?: string;
  scopeChanged?: boolean;
  /** Repos under the codebase folder whose working tree changed during the run. */
  touchedRepos?: { repo: string; files: string[] }[];
  /** CLI session/conversation to resume on the next message for this draft and provider. */
  sessionId?: string;
  /** The run failed or timed out after editing TAD.md; the edits are returned anyway. */
  partial?: boolean;
  /** TAD the AI started from, so the client can diff and review exactly what it changed. */
  baseTadMarkdown?: string;
}

export interface GeneratorJob {
  id: string;
  draftId: string;
  prompt: string;
  ai: AiSelection;
  kind: GeneratorJobKind;
  status: GeneratorJobStatus;
  startedAt: string;
  finishedAt?: string;
  events: GeneratorJobEvent[];
  result?: GeneratorJobResult;
}

export interface StartGeneratorJobRequest {
  draftId: string;
  prompt: string;
  prdMarkdown?: string;
  tadMarkdown: string;
  ai?: AiSelection;
  /** Codebase folder for the AI to analyse (read-only), e.g. ~/Code/Services. */
  servicesRoot?: string;
  figmaLinks?: { title?: string; url: string }[];
  /** Session id from the previous job with the same provider, to keep the conversation going. */
  resumeSession?: string;
  kind?: GeneratorJobKind;
  scopeMarkdown?: string;
  scopeAgreed?: boolean;
  /** The draft is linked to a Confluence page: continue that TAD instead of writing from scratch. */
  existingTad?: boolean;
}
