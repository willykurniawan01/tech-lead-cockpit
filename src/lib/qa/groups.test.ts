import { describe, expect, it } from 'vitest';
import {
  addGroup,
  arrangeFlows,
  edgeOfGroup,
  groupCheck,
  groupFlows,
  groupNameError,
  groupOrder,
  moveFlowInGroup,
  moveFlowToGroup,
  moveGroup,
  normalizeGroups,
  removeGroup,
  renameGroup,
  setGroupEnabled,
} from './groups';
import type { QAFlow, QASuite } from './types';

const flow = (id: string, stage?: string, enabled = true): QAFlow => ({
  id,
  name: id,
  description: '',
  category: 'happy-path',
  taskTitles: [],
  variables: {},
  enabled,
  ...(stage ? { stage } : {}),
  steps: [{ id: `${id}-s`, name: 'x', request: { method: 'GET', path: '/x' }, assertions: [] }],
});

const suite = (flows: QAFlow[], groups?: string[]): QASuite => ({ projectId: 'p', projectName: 'P', flows, updatedAt: '', ...(groups ? { groups } : {}) });

const names = (s: QASuite) => s.flows.map((f) => `${f.stage ?? '-'}:${f.id}`);

describe('E2E flow groups', () => {
  const base = suite([flow('a1', 'A'), flow('b1', 'B', false), flow('a2', 'A', false), flow('loose'), flow('b2', 'B')]);

  it('orders groups: saved ones first (empty included), then groups found on flows', () => {
    expect(groupOrder(base)).toEqual(['A', 'B']);
    expect(groupOrder({ ...base, groups: ['Kosong', 'B'] })).toEqual(['Kosong', 'B', 'A']);
    expect(normalizeGroups(['  X  ', 'X', '', 7, 'a\nb'])).toEqual(['X', 'a b']);
  });

  it('lists flows by group, ungrouped last, and empty groups unless searching', () => {
    const s = { ...base, groups: ['Kosong'] };
    expect(groupFlows(s).map((g) => [g.name, g.flows.map((f) => f.id)])).toEqual([
      ['Kosong', []],
      ['A', ['a1', 'a2']],
      ['B', ['b1', 'b2']],
      ['', ['loose']],
    ]);
    expect(groupFlows(s, new Set(['b2'])).map((g) => g.name)).toEqual(['B']);
    // Run order follows the same grouping.
    expect(arrangeFlows(s.flows, groupOrder(s)).map((f) => f.id)).toEqual(['a1', 'a2', 'b1', 'b2', 'loose']);
  });

  it('checks a whole group: all, some or none, with the count', () => {
    expect(groupCheck(base.flows, 'A')).toEqual({ checked: 1, total: 2, state: 'some' });
    expect(groupCheck(base.flows, '')).toEqual({ checked: 1, total: 1, state: 'all' });
    expect(groupCheck(base.flows, 'Kosong')).toEqual({ checked: 0, total: 0, state: 'none' });
    const all = setGroupEnabled(base.flows, 'A', true);
    expect(groupCheck(all, 'A').state).toBe('all');
    expect(groupCheck(setGroupEnabled(all, 'A', false), 'A').state).toBe('none');
    // Other groups are untouched.
    expect(all.find((f) => f.id === 'b1')?.enabled).toBe(false);
  });

  it('adds an empty group and refuses empty, taken or reserved names', () => {
    const s = addGroup(base, '  Refund  ');
    expect(s.groups).toEqual(['A', 'B', 'Refund']);
    expect(groupFlows(s).find((g) => g.name === 'Refund')?.flows).toEqual([]);
    expect(() => addGroup(s, 'refund')).toThrow('Grup "refund" sudah ada.');
    expect(() => addGroup(s, '   ')).toThrow('Nama grup kosong.');
    expect(groupNameError(s, 'Tanpa grup')).toContain('sudah dipakai');
  });

  it('renames a group in place and takes its flows along', () => {
    const s = renameGroup({ ...base, groups: ['A', 'B'] }, 'A', 'Setup');
    expect(s.groups).toEqual(['Setup', 'B']);
    expect(names(s)).toEqual(['Setup:a1', 'Setup:a2', 'B:b1', 'B:b2', '-:loose']);
    expect(() => renameGroup(s, 'Setup', 'B')).toThrow('sudah ada');
    // Same name (case kept) is a no-op, not an error.
    expect(renameGroup(s, 'Setup', 'Setup').groups).toEqual(['Setup', 'B']);
  });

  it('removes a group but keeps its flows, now without a group', () => {
    const s = removeGroup({ ...base, groups: ['A', 'B'] }, 'A');
    expect(s.groups).toEqual(['B']);
    expect(s.flows).toHaveLength(5);
    expect(names(s)).toEqual(['B:b1', 'B:b2', '-:a1', '-:a2', '-:loose']);
  });

  it('reorders groups, and their flows run in that order', () => {
    const s = moveGroup(base, 'B', -1);
    expect(s.groups).toEqual(['B', 'A']);
    expect(s.flows.map((f) => f.id)).toEqual(['b1', 'b2', 'a1', 'a2', 'loose']);
    // Already first: nothing moves.
    expect(moveGroup(s, 'B', -1).groups).toEqual(['B', 'A']);
  });

  it('moves a flow to another group, a new group, or out of any group', () => {
    let s = moveFlowToGroup(base, 'loose', 'A');
    expect(names(s)).toEqual(['A:a1', 'A:a2', 'A:loose', 'B:b1', 'B:b2']);
    s = moveFlowToGroup(s, 'a1', 'Baru');
    expect(s.groups).toEqual(['A', 'B', 'Baru']);
    expect(names(s).at(-1)).toBe('Baru:a1');
    s = moveFlowToGroup(s, 'b1', '');
    expect(s.flows.find((f) => f.id === 'b1')?.stage).toBeUndefined();
    expect(names(s).at(-1)).toBe('-:b1');
  });

  it('moves a flow within its group only', () => {
    const s = moveFlowInGroup(base, 'a2', -1);
    expect(s.flows.map((f) => f.id)).toEqual(['a2', 'a1', 'b1', 'b2', 'loose']);
    // a2 is first of A now: up does nothing; it never jumps into another group.
    expect(moveFlowInGroup(s, 'a2', -1).flows.map((f) => f.id)).toEqual(['a2', 'a1', 'b1', 'b2', 'loose']);
    expect(moveFlowInGroup(s, 'a1', 1).flows.map((f) => f.id)).toEqual(['a2', 'a1', 'b1', 'b2', 'loose']);
    expect(edgeOfGroup(s, 'a2')).toEqual({ first: true, last: false });
    expect(edgeOfGroup(s, 'a1')).toEqual({ first: false, last: true });
  });
});
