import type { AiProviderId, AiSelection } from '../ai/types';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** ISO timestamp. */
  at: string;
  provider?: AiProviderId;
  model?: string;
  error?: boolean;
  /** The answer was cut short (page closed, cancelled, timeout). */
  partial?: boolean;
}

/** Something a conversation is about, so an agent run can be found from the issue, draft or chat later. */
export interface AssistantLink {
  kind: 'draft' | 'teams' | 'whatsapp' | 'jira' | 'mr' | 'issue';
  ref: string;
  label?: string;
}

export interface AssistantConversation {
  id: string;
  title: string;
  /** 'chat' for the Tech Lead chat; 'issue' is reserved for future issue-investigation agent runs. */
  kind: 'chat' | 'issue';
  createdAt: string;
  updatedAt: string;
  messages: AssistantMessage[];
  /** Last AI used, restored when the conversation is reopened. */
  ai?: AiSelection;
  /** CLI session per provider, so follow-up messages continue the same conversation. */
  sessions?: Partial<Record<AiProviderId, string>>;
  links?: AssistantLink[];
  pinned?: boolean;
}

export interface AssistantConversationSummary {
  id: string;
  title: string;
  kind: AssistantConversation['kind'];
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  pinned?: boolean;
}
