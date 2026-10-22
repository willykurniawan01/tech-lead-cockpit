import { describe, expect, it } from 'vitest';
import { mergeSuites } from './merge';
import type { QAFlow, QASuite } from './types';

const flow = (id: string, extra: Partial<QAFlow> = {}): QAFlow => ({ id, name: `Flow ${id}`, description: '', category: 'happy-path', taskTitles: [], enabled: true, steps: [], ...extra });
const suite = (flows: QAFlow[], extra: Partial<QASuite> = {}): QASuite => ({ projectId: 'p', projectName: 'P', flows, updatedAt: 'x', version: 3, ...extra });

describe('mergeSuites', () => {
  const base = suite([flow('a'), flow('b'), flow('c')], { groups: ['G1'], notes: 'n' });

  it('combines edits to different test cases, additions and deletions', () => {
    const mine = suite([flow('a', { name: 'A diubah QA' }), flow('b'), flow('c'), flow('d')], { groups: ['G1'], notes: 'n' });
    const theirs = suite([flow('a'), flow('b', { enabled: false })], { groups: ['G1', 'G2'], notes: 'catatan TL', version: 4 });
    // (mine left the notes as they were, so theirs win)
    const r = mergeSuites(base, mine, theirs);
    expect('suite' in r).toBe(true);
    if (!('suite' in r)) return;
    expect(r.suite.flows.map((f) => [f.id, f.name, f.enabled])).toEqual([
      ['a', 'A diubah QA', true],
      ['b', 'Flow b', false],
      ['d', 'Flow d', true],
    ]);
    expect(r.suite.groups).toEqual(['G1', 'G2']);
    expect(r.suite.notes).toBe('catatan TL');
    expect(r.suite.version).toBe(4);
  });

  it('refuses when the same test case changed on both sides, or was edited and deleted', () => {
    const mine = suite([flow('a', { name: 'versi QA' }), flow('b'), flow('c', { description: 'x' })]);
    const theirs = suite([flow('a', { name: 'versi TL' }), flow('b')]);
    expect(mergeSuites(base, mine, theirs)).toEqual({ conflicts: ['test case "versi QA"', 'test case "Flow c"'] });
    // Suite fields changed on both sides are not silently overwritten either.
    expect(mergeSuites(base, suite(base.flows, { notes: 'QA' }), suite(base.flows, { notes: 'TL' }))).toEqual({ conflicts: ['catatan suite'] });
  });

  it('keeps my order when only I reordered, and the same change on both sides is fine', () => {
    const mine = suite([flow('c'), flow('a'), flow('b', { name: 'B' })]);
    const theirs = suite([flow('a'), flow('b', { name: 'B' }), flow('c')]);
    const r = mergeSuites(base, mine, theirs);
    expect('suite' in r && r.suite.flows.map((f) => f.id)).toEqual(['c', 'a', 'b']);
  });
});
