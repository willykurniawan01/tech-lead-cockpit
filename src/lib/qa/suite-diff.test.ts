import { describe, expect, it } from 'vitest';
import { applyChanges, diffSuites } from './suite-diff';
import type { QAFlow, QAStep, QASuite } from './types';

const step = (id: string, extra: Partial<QAStep> = {}): QAStep => ({ id, name: `Step ${id}`, request: { method: 'GET', path: `/${id}` }, assertions: [], ...extra }) as QAStep;
const flow = (id: string, extra: Partial<QAFlow> = {}): QAFlow => ({ id, name: `Flow ${id}`, description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [step('s1')], ...extra });
const suite = (flows: QAFlow[], extra: Partial<QASuite> = {}): QASuite => ({ projectId: 'p', projectName: 'P', flows, updatedAt: 'x', ...extra });

describe('diffSuites', () => {
  it('lists added, changed and removed test cases with readable details, and suite fields', () => {
    const base = suite([flow('a'), flow('b'), flow('c')], { notes: 'lama' });
    const next = suite([flow('a', { name: 'A baru', steps: [step('s1', { request: { method: 'POST', path: '/s1' } as QAStep['request'] }), step('s2')] }), flow('c'), flow('d')], { notes: 'baru' });
    const changes = diffSuites(base, next);
    expect(changes.map((c) => [c.key, c.kind])).toEqual([
      ['a', 'changed'],
      ['d', 'added'],
      ['b', 'removed'],
      ['suite:notes', 'changed'],
    ]);
    expect(changes[0].details).toEqual(['Nama: Flow a → A baru', 'Step "Step s1": request diubah', 'Step "Step s2" ditambah']);
    expect(diffSuites(base, base)).toEqual([]);
  });
});

describe('applyChanges', () => {
  const base = suite([flow('a'), flow('b'), flow('c')], { notes: 'lama' });
  const draft = suite([flow('a', { name: 'A baru' }), flow('c'), flow('d')], { notes: 'baru', undo: { at: 'x', label: 'y', flows: [] } });

  it('takes only the chosen changes, keeping removed test cases in place when not chosen', () => {
    const out = applyChanges(base, draft, ['d', 'suite:notes']);
    expect(out.flows.map((f) => [f.id, f.name])).toEqual([
      ['a', 'Flow a'],
      ['b', 'Flow b'],
      ['c', 'Flow c'],
      ['d', 'Flow d'],
    ]);
    expect(out.notes).toBe('baru');
    // Everything chosen is the draft itself.
    const all = applyChanges(base, draft, diffSuites(base, draft).map((c) => c.key));
    expect(diffSuites(draft, all)).toEqual([]);
    expect(all.undo).toEqual(draft.undo);
  });

  it('chosen and not chosen together rebuild the draft', () => {
    const sent = applyChanges(base, draft, ['a', 'b']);
    const rest = applyChanges(sent, draft, ['d', 'suite:notes']);
    expect(diffSuites(draft, rest)).toEqual([]);
  });
});
