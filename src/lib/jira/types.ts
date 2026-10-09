export type JiraFlavor = 'cloud' | 'datacenter';

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
  avatarUrl?: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  statusColor?: string;
  issueType: string;
  issueTypeIconUrl?: string;
  priority?: string;
  priorityIconUrl?: string;
  assignee?: {
    displayName: string;
    emailAddress?: string;
    avatarUrl?: string;
  };
  project?: {
    key: string;
    name: string;
  };
  updated: string;
  url: string;
}

export interface JiraIssueDetail extends JiraIssue {
  description?: string;
  comments?: {
    id: string;
    author: string;
    created: string;
    body: string;
  }[];
  labels?: string[];
  components?: string[];
}

export interface JiraTransition {
  id: string;
  name: string;
  to: {
    id: string;
    name: string;
  };
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey?: string;
}

export interface JiraStatus {
  configured: boolean;
  flavor?: JiraFlavor;
  baseUrl?: string;
  auth?: 'basic' | 'bearer';
  email?: string;
  tokenPresent: boolean;
  user?: JiraUser;
  error?: string;
}

export interface SaveTokenRequest {
  token: string;
  baseUrl?: string;
  email?: string;
  syncConfluence?: boolean;
}

/** Defaults for new TAD task tickets, copied from the TAD's existing tickets. */
export interface TadTicketTemplate {
  projectKey?: string;
  issueType?: string;
  parent?: { key: string; summary: string };
  labels: string[];
  components: string[];
  /** Keys the defaults were taken from. */
  basedOn: string[];
}

export interface TadTicketItem {
  /** Task Name in Development Scope, also the ticket summary. */
  title: string;
  description: string;
}

export interface TadTicketRequest {
  projectKey: string;
  issueType: string;
  parentKey?: string;
  labels?: string[];
  components?: string[];
  items: TadTicketItem[];
}

export interface TadTicketResult {
  title: string;
  key?: string;
  url?: string;
  /** An issue with the same summary already existed and was linked instead. */
  existed?: boolean;
  error?: string;
}
