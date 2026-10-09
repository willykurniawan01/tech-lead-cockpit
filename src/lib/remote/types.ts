// Remote Access: the Cockpit on the laptop, monitored and lightly controlled from a paired phone
// over Tailscale. Contract between the desktop UI, the connector and the mobile API.

/** How long Remote stays on. There is no "forever": every activation expires. */
export type RemoteDuration = { kind: '2h' } | { kind: '8h' } | { kind: 'until'; until: string };

/** Longest allowed "until" activation. */
export const REMOTE_MAX_HOURS = 24;

export interface RemoteDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt?: string;
  /** Has a live session token right now. */
  connected: boolean;
}

export interface RemoteReportTarget {
  /** WhatsApp group JID (…@g.us). */
  jid: string;
  name: string;
}

export interface RemoteSettings {
  /** Progress Report destination per project id; set on the laptop only. */
  reportTargets: Record<string, RemoteReportTarget>;
}

export interface RemoteStatus {
  active: boolean;
  startedAt?: string;
  expiresAt?: string;
  /** Base URL the phone opens, e.g. https://mac.tailnet.ts.net:5175 */
  baseUrl?: string;
  address?: string;
  port?: number;
  https?: boolean;
  /** Why HTTPS is not available (the PWA then cannot install). */
  httpsIssue?: string;
  devices: RemoteDevice[];
  /** Increments on every new phone connection, for desktop toasts. */
  connectionSeq: number;
  lastConnection?: { deviceName: string; at: string };
  /** Why Remote went off last time (expired, manual, phone, restart, too many failures). */
  lastStop?: { reason: string; at: string };
}

export interface RemotePairing {
  /** Short one-time code, also typed by hand on the phone. */
  code: string;
  expiresAt: string;
  /** URL in the QR code: opens the PWA with the code prefilled (in the hash, never sent to the server). */
  url: string;
}

/** Mobile API (served only on the Remote listener). */
export interface MobileProject {
  id: string;
  name: string;
  /** Dev progress % (same code-based rule as the Task Board), anti-regression peak applied. */
  devPercent: number;
  livePercent: number;
  tasks: number;
  stages: { merged: number; review: number; inProgress: number; todo: number };
  attention: { tad: string; task: string; jiraKeys: string[]; flags: string[] }[];
  /** Target end date from the estimate schedule (YYYY-MM-DD), when there is one. */
  targetDate?: string;
  /** Every task has an effort and a developer, so the target is complete. */
  targetComplete: boolean;
  reportTarget?: string;
  errors: string[];
}

export interface MobileAgentTask {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  error?: string;
  progress?: string;
}

export interface MobileMr {
  ref: string;
  title: string;
  author: string;
  webUrl: string;
  updatedAt: string;
  draft: boolean;
  hasConflicts?: boolean;
  pipelineStatus?: string;
}

export interface MobileE2E {
  projectId: string;
  projectName: string;
  status: string;
  environment: string;
  startedAt: string;
  finishedAt?: string;
  passedFlows: number;
  failedFlows: number;
  flows: number;
}

export interface MobileReportDraft {
  draftId: string;
  projectId: string;
  text: string;
  target?: string;
  expiresAt: string;
}
