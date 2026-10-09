import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiProviderId, AiSelection } from '../src/lib/ai/types.ts';
import type { AssistantConversation, AssistantConversationSummary, AssistantMessage } from '../src/lib/assistant/types.ts';
import { DATA_DIR } from './paths.ts';

/**
 * Assistant conversations, one JSON file each. The connector writes them itself while answering,
 * so a conversation survives closing the page mid-answer, rebuilding the app, or switching between
 * the browser and the Mac app, and later agent runs (e.g. issue investigations) can use the same store.
 */
export const CONVERSATIONS_DIR = join(DATA_DIR, 'assistant', 'conversations');

const ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_MESSAGES = 500;
const MAX_TEXT = 200_000;

export class ConversationError extends Error {}

export function isConversationId(id: unknown): id is string {
  return typeof id === 'string' && ID.test(id);
}

/** First user line, trimmed to something that fits a list row. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'Percakapan baru';
}

export function summarize(c: AssistantConversation): AssistantConversationSummary {
  const last = c.messages.at(-1);
  return {
    id: c.id,
    title: c.title,
    kind: c.kind,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messages.length,
    preview: last ? last.text.replace(/\s+/g, ' ').slice(0, 120) : '',
    pinned: c.pinned,
  };
}

export class ConversationFiles {
  constructor(readonly dir = CONVERSATIONS_DIR) {}

  private file(id: string) {
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<AssistantConversationSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: AssistantConversationSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const c = await this.get(name.slice(0, -5)).catch(() => undefined);
      if (c) out.push(summarize(c));
    }
    return out.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<AssistantConversation | undefined> {
    if (!isConversationId(id)) throw new ConversationError('id percakapan tidak valid.');
    try {
      const c = JSON.parse(await readFile(this.file(id), 'utf8')) as AssistantConversation;
      return c?.id === id && Array.isArray(c.messages) ? c : undefined;
    } catch {
      return undefined;
    }
  }

  async create(firstText: string, kind: AssistantConversation['kind'] = 'chat'): Promise<AssistantConversation> {
    const now = new Date().toISOString();
    const c: AssistantConversation = { id: randomUUID(), title: titleFrom(firstText), kind, createdAt: now, updatedAt: now, messages: [], sessions: {} };
    await this.save(c);
    return c;
  }

  async save(c: AssistantConversation): Promise<void> {
    if (!isConversationId(c.id)) throw new ConversationError('id percakapan tidak valid.');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `.${c.id}.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(c), { mode: 0o600 });
    await rename(tmp, this.file(c.id));
  }

  /** Appends a message and bumps updatedAt; old messages beyond the cap are dropped from the front. */
  async append(id: string, msg: Omit<AssistantMessage, 'id' | 'at'>, patch: { ai?: AiSelection; session?: { provider: AiProviderId; id: string } } = {}) {
    const c = await this.get(id);
    if (!c) throw new ConversationError('Percakapan tidak ditemukan.');
    const at = new Date().toISOString();
    c.messages.push({ ...msg, text: msg.text.slice(0, MAX_TEXT), id: randomUUID(), at });
    if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
    if (patch.ai) c.ai = patch.ai;
    if (patch.session) c.sessions = { ...c.sessions, [patch.session.provider]: patch.session.id };
    c.updatedAt = at;
    await this.save(c);
    return c;
  }

  async update(id: string, patch: { title?: string; pinned?: boolean }) {
    const c = await this.get(id);
    if (!c) throw new ConversationError('Percakapan tidak ditemukan.');
    if (typeof patch.title === 'string' && patch.title.trim()) c.title = patch.title.trim().slice(0, 120);
    if (typeof patch.pinned === 'boolean') c.pinned = patch.pinned;
    await this.save(c);
    return summarize(c);
  }

  /** Moves the file to .trash, so a mistaken delete can still be recovered by hand. */
  async remove(id: string): Promise<void> {
    if (!isConversationId(id)) throw new ConversationError('id percakapan tidak valid.');
    const trash = join(this.dir, '.trash');
    await mkdir(trash, { recursive: true, mode: 0o700 });
    try {
      await rename(this.file(id), join(trash, `${id}-${Date.now()}.json`));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
