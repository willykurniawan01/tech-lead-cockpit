import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratorJob } from '../lib/generator/types';

// A minimal drafts store: the delivery only reads drafts and calls these.
const store = vi.hoisted(() => {
  const s = {
    drafts: [] as { id: string; markdown: string; pendingJobId?: string; pendingReview?: boolean; aiSessions?: Record<string, string>; proposal?: { base: string } }[],
    update: (id: string, patch: Record<string, unknown>) => Object.assign(s.drafts.find((d) => d.id === id)!, patch),
    setProposal: vi.fn((id: string, p: { base: string }) => ((s.drafts.find((d) => d.id === id)!.proposal = p), { id: 'prop-1', ...p })),
    applyRevision: vi.fn(() => ({ id: 'rev-1' })),
    addChatMessage: vi.fn(),
  };
  return s;
});
vi.mock('./drafts.svelte', () => ({ drafts: store }));
vi.mock('../components/toast.svelte', () => ({ toasts: { show: vi.fn() } }));
vi.mock('../lib/ai/usage.svelte', () => ({ aiUsage: { load: vi.fn(async () => {}) } }));

const { finishGeneratorJob } = await import('./job-delivery');

const job = (id: string, over: Partial<GeneratorJob> = {}): GeneratorJob =>
  ({
    id,
    draftId: 'd1',
    status: 'done',
    kind: 'edit',
    prompt: 'Update TAD dari temuan',
    ai: { provider: 'claude', model: '' },
    events: [],
    result: { reply: 'Diperbarui', changed: true, updatedTadMarkdown: '# TAD baru', baseTadMarkdown: '# TAD', sessionId: 's9' },
    ...over,
  }) as unknown as GeneratorJob;

describe('handing a finished TAD job to its draft', () => {
  beforeEach(() => {
    store.drafts = [{ id: 'd1', markdown: '# TAD' }];
    store.setProposal.mockClear();
    store.applyRevision.mockClear();
  });

  it('makes a job started from E2E findings a proposal even when the chat applies edits directly', () => {
    store.drafts[0].pendingJobId = 'j1';
    store.drafts[0].pendingReview = true;
    finishGeneratorJob('d1', job('j1'), { reviewMode: false });
    expect(store.setProposal).toHaveBeenCalledTimes(1);
    expect(store.applyRevision).not.toHaveBeenCalled();
    expect(store.drafts[0]).toMatchObject({ pendingJobId: undefined, pendingReview: undefined, aiSessions: { claude: 's9' } });
  });

  it('delivers each job once, whichever page sees it finish first', () => {
    store.drafts[0].pendingJobId = 'j2';
    finishGeneratorJob('d1', job('j2'), { reviewMode: true });
    finishGeneratorJob('d1', job('j2'), { reviewMode: true });
    expect(store.setProposal).toHaveBeenCalledTimes(1);
    // A job no longer pending on the draft (another one replaced it) is left alone.
    store.drafts[0].pendingJobId = 'j4';
    finishGeneratorJob('d1', job('j3'), { reviewMode: true });
    expect(store.setProposal).toHaveBeenCalledTimes(1);
  });

  it('still applies a chat edit directly when review is off and nothing asks for a proposal', () => {
    store.drafts[0].pendingJobId = 'j5';
    finishGeneratorJob('d1', job('j5'), { reviewMode: false });
    expect(store.applyRevision).toHaveBeenCalledWith('d1', '# TAD baru', expect.stringContaining('AI (Claude)'));
    expect(store.setProposal).not.toHaveBeenCalled();
  });
});
