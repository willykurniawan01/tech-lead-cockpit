/** Contract between the WhatsApp UI and the local connector. */

import type { AiSelection } from '../ai/types';

export type WaConnection = 'idle' | 'connecting' | 'qr' | 'open' | 'reconnecting' | 'logged-out';

export interface WaStatus {
  connection: WaConnection;
  /** PNG data URL of the pairing QR while `connection` is 'qr'. */
  qr?: string;
  me?: { id: string; name: string };
  error?: string;
  /** Linked-device credentials exist on disk, so "connect" resumes without a QR. */
  hasSession: boolean;
}

export interface WaChat {
  jid: string;
  name: string;
  isGroup: boolean;
  unread: number;
  /** Unix seconds of the latest message, 0 when unknown. */
  lastTimestamp: number;
  lastText: string;
}

export interface WaMessageAttachment {
  type: 'image' | 'video' | 'audio' | 'document';
  fileName?: string;
  mimetype?: string;
  caption?: string;
}

export interface WaMessage {
  id: string;
  fromMe: boolean;
  /** Display name of the sender ("Saya" for own messages). */
  sender: string;
  text: string;
  timestamp: number;
  attachment?: WaMessageAttachment;
}

export type WaAudience = 'team' | 'pm' | 'client' | 'friend';

export const AUDIENCES: { id: WaAudience; label: string; hint: string }[] = [
  { id: 'team', label: 'Tim dev/QA', hint: 'Santai tapi jelas: task, MR, blocker, review.' },
  { id: 'pm', label: 'PM/Stakeholder', hint: 'Ringkas dan terstruktur: progres, risiko, estimasi.' },
  { id: 'client', label: 'Klien/eksternal', hint: 'Formal dan sopan, tanpa istilah teknis internal.' },
  { id: 'friend', label: 'Teman', hint: 'Santai dan akrab, bahasa sehari-hari, boleh emoji.' },
];

export interface WaTemplate {
  id: string;
  name: string;
  audience: WaAudience;
  /** Text with `{{variable}}` placeholders, e.g. `Halo {{nama}}`. */
  body: string;
}

export interface WaDraftRequest {
  jid: string;
  audience: WaAudience;
  chatName?: string;
  /** Template body (variables already filled) the AI should adapt instead of writing from scratch. */
  template?: string;
  instruction?: string;
  ai?: AiSelection;
}

export interface WaDraftResponse {
  draft: string;
}

export interface WaAttachmentInput {
  filename: string;
  mimetype: string;
  data: string; // base64
  size?: number;
}

export interface WaSendRequest {
  jid: string;
  text: string;
  attachment?: WaAttachmentInput;
}

/** `{{ nama }}` → `nama`, in order of first appearance. */
export function templateVariables(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) seen.add(m[1]);
  return [...seen];
}

/** Replaces known variables; unknown ones stay as `{{var}}` so they remain visible. */
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, name: string) => (values[name]?.trim() ? values[name].trim() : all));
}
