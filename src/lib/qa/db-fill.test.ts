import { describe, expect, it } from 'vitest';
import { dbFillPlan, notReady } from './db-fill';
import type { QAEnvironment, QAFlow } from './types';

const flow = (id: string, body: Record<string, string>, extra: Partial<QAFlow> = {}): QAFlow => ({
  id,
  name: `Flow ${id}`,
  description: '',
  category: 'happy-path',
  taskTitles: [],
  variables: {},
  enabled: true,
  steps: [{ id: `${id}-s`, name: 's', service: 'core-promo', request: { method: 'POST', path: '/promo', body }, assertions: [] }],
  ...extra,
});

const env: QAEnvironment = { id: 'dev', name: 'Development', baseUrl: 'http://dev', services: {}, headers: {}, variables: { actorCreator: '1024' }, auth: { type: 'none' }, readOnly: false, timeoutMs: 10_000, databases: [{ name: 'core-promo', service: 'core-promo', database: 'db_promo' }] };

describe('every test case ready to execute', () => {
  const flows = [
    // promoUuid comes from this flow's own extract, actorCreator from the environment.
    { ...flow('create', { actor: '{{actorCreator}}' }), steps: [{ id: 'c', name: 'create', service: 'core-promo', request: { method: 'POST' as const, path: '/promo', body: { actor: '{{actorCreator}}' } }, assertions: [], extract: { promoUuid: '$.data.uuid' } }] },
    flow('reserve', { promo: '{{promoUuid}}', product: '{{billerProductId}}' }, { variables: { billerProductId: 'PLN-20K' } }),
    flow('pay', { pin: '{{pin}}', merchant: '{{merchantId}}' }),
    flow('queried', { partner: '{{partnerId}}' }, { dataQueries: [{ name: 'partnerId', db: 'core-promo', sql: 'SELECT id FROM partners LIMIT 1' }] }),
  ];

  it('lists, per test case, the variables that still have no real value', () => {
    const r = notReady(flows, env);
    expect([...r]).toEqual([
      ['reserve', ['billerProductId']],
      ['pay', ['merchantId', 'pin']],
    ]);
    // Environment values, extracted values and database queries count as ready.
    expect(r.has('create')).toBe(false);
    expect(r.has('queried')).toBe(false);
  });

  it('plans the database fill for data, and leaves credentials to the Keychain', () => {
    const plan = dbFillPlan(flows, env);
    expect(plan.vars.map((v) => v.name)).toEqual(['merchantId', 'billerProductId']);
    expect(plan.manual.map((v) => v.name)).toEqual(['pin']);
    expect(plan.flowIds).toEqual(['reserve', 'pay']);
    expect(plan.instruction).toContain('{{merchantId}}, {{billerProductId}} (contoh AI: PLN-20K)');
    // The rules come before the list, so a long list can't cut them off.
    expect(plan.instruction.indexOf('"dataQueries"')).toBeLessThan(plan.instruction.indexOf('{{merchantId}}'));
    expect(plan.instruction).toContain('"dataQueries"');
    expect(plan.instruction).toContain('Nilai di blok "variables" flow adalah CONTOH dari AI');
    expect(plan.instruction).toContain('jangan mengganti variabel yang sudah dihasilkan "extract"');
    expect(plan.instruction).not.toContain('{{pin}}');
    // Without databases nothing is "auto" from a query: the queried flow needs a value too.
    expect(notReady(flows, { ...env, databases: [] }).has('queried')).toBe(true);
  });
});
