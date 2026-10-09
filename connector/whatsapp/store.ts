import type { WaChat, WaMessage } from '../../src/lib/whatsapp/types.ts';

/**
 * In-memory view of recent chats. Message content is never written to disk: it lives only
 * for the lifetime of the connector process.
 */

const MAX_CHATS = 300;
const MAX_MESSAGES_PER_CHAT = 100;

/** Minimal shape of a Baileys message used here (keeps the store testable without Baileys). */
export interface RawMessage {
  key?: { remoteJid?: string | null; fromMe?: boolean | null; id?: string | null; participant?: string | null } | null;
  message?: Record<string, unknown> | null;
  messageTimestamp?: number | { toNumber(): number } | null;
  pushName?: string | null;
}

export function isSkippableJid(jid: string): boolean {
  return jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

function timestampOf(ts: RawMessage['messageTimestamp']): number {
  if (!ts) return 0;
  return typeof ts === 'number' ? ts : ts.toNumber();
}

type AnyRecord = Record<string, any>;

/** Readable text for a message; null for protocol/reaction messages that shouldn't show up. */
export function messageText(message: RawMessage['message']): string | null {
  if (!message) return null;
  let m = message as AnyRecord;
  // Unwrap containers (ephemeral, view-once, edited) to reach the real content.
  for (let i = 0; i < 4; i++) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message ?? m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  if (typeof m.conversation === 'string') return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  const withCaption = (label: string, caption?: string) => (caption ? `[${label}] ${caption}` : `[${label}]`);
  if (m.imageMessage) return withCaption('Gambar', m.imageMessage.caption);
  if (m.videoMessage) return withCaption('Video', m.videoMessage.caption);
  if (m.documentMessage) return withCaption('Dokumen', m.documentMessage.caption ?? m.documentMessage.fileName);
  if (m.audioMessage) return '[Pesan suara]';
  if (m.stickerMessage) return '[Stiker]';
  if (m.contactMessage) return `[Kontak] ${m.contactMessage.displayName ?? ''}`.trim();
  if (m.locationMessage) return '[Lokasi]';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return `[Polling] ${(m.pollCreationMessage ?? m.pollCreationMessageV3).name ?? ''}`.trim();
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;
  if (m.listResponseMessage?.title) return m.listResponseMessage.title;
  return null;
}

export function extractAttachment(message: RawMessage['message']): WaMessage['attachment'] | undefined {
  if (!message) return undefined;
  let m = message as AnyRecord;
  for (let i = 0; i < 4; i++) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message ?? m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  if (m.imageMessage) {
    return { type: 'image', mimetype: m.imageMessage.mimetype, caption: m.imageMessage.caption };
  }
  if (m.videoMessage) {
    return { type: 'video', mimetype: m.videoMessage.mimetype, caption: m.videoMessage.caption };
  }
  if (m.audioMessage) {
    return { type: 'audio', mimetype: m.audioMessage.mimetype };
  }
  if (m.documentMessage) {
    return {
      type: 'document',
      fileName: m.documentMessage.fileName || 'Dokumen',
      mimetype: m.documentMessage.mimetype,
      caption: m.documentMessage.caption,
    };
  }
  return undefined;
}

export class WaStore {
  private chats = new Map<string, WaChat>();
  private messages = new Map<string, WaMessage[]>();
  private names = new Map<string, string>();
  private phonebookNames = new Set<string>();

  clear() {
    this.chats.clear();
    this.messages.clear();
    this.names.clear();
    this.phonebookNames.clear();
  }

  setName(jid: string, name: string | null | undefined, isPhonebook = false) {
    if (!jid || !name) return;
    if (this.phonebookNames.has(jid) && !isPhonebook) {
      return;
    }
    if (isPhonebook) {
      this.phonebookNames.add(jid);
    }
    this.names.set(jid, name);
    const chat = this.chats.get(jid);
    if (chat && (!chat.name || chat.name === shortJid(jid) || isPhonebook)) chat.name = name;
  }

  nameOf(jid: string): string {
    return this.names.get(jid) ?? this.chats.get(jid)?.name ?? shortJid(jid);
  }

  upsertChat(jid: string, patch: { name?: string | null; unread?: number | null; timestamp?: number | null }) {
    if (!jid || isSkippableJid(jid)) return;
    const chat = this.chats.get(jid) ?? { jid, name: this.names.get(jid) ?? shortJid(jid), isGroup: isGroupJid(jid), unread: 0, lastTimestamp: 0, lastText: '' };
    if (patch.name) chat.name = patch.name;
    if (typeof patch.unread === 'number' && patch.unread >= 0) chat.unread = patch.unread;
    if (patch.timestamp && patch.timestamp > chat.lastTimestamp) chat.lastTimestamp = patch.timestamp;
    this.chats.set(jid, chat);
    this.trimChats();
  }

  /** Returns the stored message, or null when it has no displayable text or is a duplicate. */
  addMessage(raw: RawMessage, opts: { countUnread: boolean; myName?: string }): WaMessage | null {
    const jid = raw.key?.remoteJid ?? '';
    const id = raw.key?.id ?? '';
    if (!jid || !id || isSkippableJid(jid)) return null;
    const text = messageText(raw.message);
    if (text === null) return null;

    const fromMe = Boolean(raw.key?.fromMe);
    const author = raw.key?.participant || jid;
    if (!fromMe && raw.pushName) this.setName(isGroupJid(jid) ? author : jid, raw.pushName);
    const msg: WaMessage = {
      id,
      fromMe,
      sender: fromMe ? 'Saya' : this.nameOf(author),
      text,
      timestamp: timestampOf(raw.messageTimestamp),
      attachment: extractAttachment(raw.message),
    };

    const list = this.messages.get(jid) ?? [];
    if (list.some((m) => m.id === id)) return null;
    list.push(msg);
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
    this.messages.set(jid, list);

    this.upsertChat(jid, { timestamp: msg.timestamp });
    const chat = this.chats.get(jid)!;
    if (msg.timestamp >= chat.lastTimestamp || !chat.lastText) chat.lastText = fromMe ? `Saya: ${text}` : text;
    if (opts.countUnread && !fromMe) chat.unread += 1;
    return msg;
  }

  hasChat(jid: string): boolean {
    return this.chats.has(jid);
  }

  markRead(jid: string) {
    const chat = this.chats.get(jid);
    if (chat) chat.unread = 0;
  }

  listChats(): WaChat[] {
    return [...this.chats.values()].sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  }

  listMessages(jid: string): WaMessage[] {
    return this.messages.get(jid) ?? [];
  }

  private trimChats() {
    if (this.chats.size <= MAX_CHATS) return;
    const oldest = [...this.chats.values()].sort((a, b) => a.lastTimestamp - b.lastTimestamp).slice(0, this.chats.size - MAX_CHATS);
    for (const c of oldest) {
      this.chats.delete(c.jid);
      this.messages.delete(c.jid);
    }
  }
}

/** `628123@s.whatsapp.net` → `+628123`; groups and LIDs keep their id part. */
export function shortJid(jid: string): string {
  const [user, server] = jid.split('@');
  const bare = user.split(':')[0];
  return server === 's.whatsapp.net' ? `+${bare}` : bare;
}
