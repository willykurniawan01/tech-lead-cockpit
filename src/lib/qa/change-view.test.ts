import { describe, expect, it } from 'vitest';
import { assertionText, flatten, flowChange, suiteFieldChange } from './change-view';
import type { QAFlow, QAStep } from './types';

const step = (id: string, extra: Partial<QAStep> = {}): QAStep => ({ id, name: `Step ${id}`, request: { method: 'POST', path: '/v1/promo', body: { name: 'A', rules: { amount: 1000 } } }, assertions: [{ type: 'status', op: 'equals', expected: 201 }], ...extra }) as QAStep;
const flow = (extra: Partial<QAFlow> = {}): QAFlow => ({ id: 'f', name: 'Buat promo', description: '', category: 'happy-path', taskTitles: ['[BACKEND] Create'], enabled: true, steps: [step('s1'), step('s2', { name: 'Cek', request: { method: 'GET', path: '/v1/promo/{{id}}' } as QAStep['request'] })], ...extra });

describe('change view', () => {
  it('words expectations and flattens bodies', () => {
    expect(assertionText({ type: 'json', path: 'data.id', op: 'exists' })).toBe('Body data.id ada');
    expect(assertionText({ type: 'status', op: 'in', expected: [200, 201] })).toBe('Status HTTP salah satu dari 200, 201');
    expect(flatten({ a: { b: [1, { c: 'x' }] }, e: {} })).toEqual({ 'a.b[0]': '1', 'a.b[1].c': 'x', e: '{}' });
  });

  it('shows only what changed, step by step', () => {
    const after = flow({
      name: 'Buat promo cashback',
      enabled: false,
      steps: [
        step('s1', { request: { method: 'POST', path: '/v1/promo', body: { name: 'A', rules: { amount: 2000 } } } as QAStep['request'], assertions: [{ type: 'status', op: 'equals', expected: 200 }, { type: 'json', path: 'data.id', op: 'exists' }] }),
        step('s3', { name: 'Hapus' }),
      ],
    });
    const c = flowChange(flow(), after);
    expect(c.fields.filter((r) => r.kind !== 'same')).toEqual([
      { label: 'Nama', before: 'Buat promo', after: 'Buat promo cashback', kind: 'changed' },
      { label: 'Aktif', before: 'ya', after: 'tidak', kind: 'changed' },
    ]);
    expect(c.steps.map((s) => [s.title, s.kind])).toEqual([
      ['Step s1', 'changed'],
      ['Hapus', 'added'],
      ['Cek', 'removed'],
    ]);
    const s1 = c.steps[0].sections;
    expect(s1.find((x) => x.title === 'Request')!.rows.filter((r) => r.kind !== 'same')).toEqual([{ label: 'Body rules.amount', before: '1000', after: '2000', kind: 'changed' }]);
    expect(s1.find((x) => x.title === 'Ekspektasi')!.rows.filter((r) => r.kind !== 'same')).toEqual([
      { label: '', before: 'Status HTTP = 201', after: 'Status HTTP = 200', kind: 'changed' },
      { label: '', after: 'Body data.id ada', kind: 'added' },
    ]);
  });

  it('a new test case is all added; suite fields read as lists', () => {
    const c = flowChange(undefined, flow());
    expect(c.fields.every((r) => r.kind === 'added')).toBe(true);
    expect(c.steps.every((s) => s.kind === 'added')).toBe(true);
    expect(suiteFieldChange('groups', ['A', 'B'], ['B', 'A', 'C'])).toEqual([
      { label: 'Grup', after: 'C', kind: 'added' },
      { label: 'Urutan', before: 'A → B', after: 'B → A → C', kind: 'changed' },
    ]);
  });
});
