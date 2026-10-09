// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationError, ConversationFiles, titleFrom } from './conversations-store.ts';
import { historyBlock } from './assistant.ts';

describe('ConversationFiles', () => {
  let dir: string;
  let files: ConversationFiles;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-conv-'));
    files = new ConversationFiles(join(dir, 'conversations'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('creates a conversation titled after the first message and appends turns', async () => {
    const c = await files.create('Draft TAD apa saja yang saya punya dan statusnya sekarang bagaimana ya kira-kira?');
    expect(c.title.length).toBeLessThanOrEqual(60);
    expect(c.title.endsWith('…')).toBe(true);

    await files.append(c.id, { role: 'user', text: 'halo' }, { ai: { provider: 'claude', model: 'haiku' } });
    await files.append(c.id, { role: 'assistant', text: 'hai', provider: 'claude' }, { session: { provider: 'claude', id: 'sess-1' } });

    const saved = await files.get(c.id);
    expect(saved?.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'halo'],
      ['assistant', 'hai'],
    ]);
    expect(saved?.ai).toEqual({ provider: 'claude', model: 'haiku' });
    expect(saved?.sessions).toEqual({ claude: 'sess-1' });

    const [summary] = await files.list();
    expect(summary).toMatchObject({ id: c.id, messageCount: 2, preview: 'hai', kind: 'chat' });
  });

  it('lists pinned conversations first, then newest', async () => {
    const a = await files.create('a');
    await new Promise((r) => setTimeout(r, 5));
    const b = await files.create('b');
    expect((await files.list()).map((s) => s.id)).toEqual([b.id, a.id]);
    await files.update(a.id, { pinned: true, title: 'Penting' });
    const list = await files.list();
    expect(list[0]).toMatchObject({ id: a.id, title: 'Penting', pinned: true });
  });

  it('moves deleted conversations to .trash and rejects bad ids', async () => {
    const c = await files.create('hapus aku');
    await files.remove(c.id);
    expect(await files.list()).toEqual([]);
    expect(await readdir(join(files.dir, '.trash'))).toHaveLength(1);
    await expect(files.get('../x')).rejects.toBeInstanceOf(ConversationError);
    await expect(files.append('missing-id', { role: 'user', text: 'x' })).rejects.toBeInstanceOf(ConversationError);
  });

  it('falls back to a default title for empty text', () => {
    expect(titleFrom('   ')).toBe('Percakapan baru');
  });
});

describe('historyBlock', () => {
  const msg = (role: 'user' | 'assistant', text: string, error = false) => ({ id: text, role, text, at: '', error });

  it('replays earlier turns without failed answers', () => {
    const out = historyBlock([msg('user', 'satu'), msg('assistant', 'dua'), msg('assistant', 'gagal', true)]);
    expect(out).toBe('### RIWAYAT PERCAKAPAN SEBELUMNYA\nUSER: satu\n\nASSISTANT: dua');
  });

  it('keeps only the most recent turns within the size budget', () => {
    const long = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `pesan ${i} ${'x'.repeat(2_000)}`));
    const out = historyBlock(long);
    expect(out).toContain('pesan 39');
    expect(out).not.toContain('pesan 0 ');
    expect(out.length).toBeLessThan(17_000);
  });

  it('is empty for a new conversation', () => {
    expect(historyBlock([])).toBe('');
  });
});
