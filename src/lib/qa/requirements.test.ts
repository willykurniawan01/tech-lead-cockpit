import { describe, expect, it } from 'vitest';
import { e2eRequirements, flowVariables } from './requirements';
import type { QAEnvironment, QAFlow, QAStep } from './types';

const step = (over: Partial<QAStep> & { path: string; body?: unknown }): QAStep => ({
  id: over.path,
  name: over.path,
  service: over.service,
  request: { method: 'POST', path: over.path, headers: over.request?.headers ?? {}, query: {}, body: over.body },
  assertions: over.assertions ?? [{ type: 'status', op: 'equals', expected: 200 }],
  extract: over.extract ?? {},
  ...(over.useEnvAuth === false ? { useEnvAuth: false } : {}),
});

const flow = (name: string, steps: QAStep[], extra: Partial<QAFlow> = {}): QAFlow => ({ id: name, name, description: '', category: 'happy-path', taskTitles: [], variables: {}, steps, enabled: true, ...extra });

const env = (over: Partial<QAEnvironment> = {}): QAEnvironment => ({ id: 'dev', name: 'Development', baseUrl: '', services: {}, headers: {}, variables: {}, auth: { type: 'none' }, readOnly: false, timeoutMs: 10_000, ...over });

const login = flow('Login CMS', [step({ path: '/cms/login', service: 'core-promo', useEnvAuth: false, body: { username: '{{cmsUsername}}', password: '{{cmsPassword}}' }, extract: { accessToken: '$.data.token' } })], { variables: { cmsUsername: 'admin.qa', cmsPassword: 'rahasia' } });
const create = flow('Create promo', [
  step({ path: '/cms/promo', service: 'core-promo', request: { method: 'POST', path: '', headers: { Authorization: 'Bearer {{accessToken}}' }, query: {} }, body: { name: 'E2E {{$timestamp}}', partnerId: '{{partnerId}}', items: [{ productId: '{{productId}}' }] }, extract: { promoUuid: '$.data.uuid' } }),
  step({ path: '/cms/promo/{{promoUuid}}/activate', service: 'core-promo', assertions: [{ type: 'db', db: 'promo', sql: "SELECT status FROM promos WHERE uuid = '{{promoUuid}}' AND owner = '{{ownerId}}'", op: 'equals', expected: 'ACTIVE' }] }),
]);
const reserve = flow('Reserve', [step({ path: '/internal/promo/reserve', service: 'core-tcico', body: { promo: '{{promoId}}', msisdn: '{{msisdn}}' } })], { dataQueries: [{ name: 'promoId', db: 'promo', sql: 'SELECT id FROM promos LIMIT 1' }], variables: { msisdn: '081234567890' } });

describe('E2E requirements', () => {
  it('finds every {{name}} a flow uses: path, headers, body, db checks, data queries', () => {
    expect([...flowVariables(create)].sort()).toEqual(['$timestamp', 'accessToken', 'ownerId', 'partnerId', 'productId', 'promoUuid']);
    expect([...flowVariables(reserve)].sort()).toEqual(['msisdn', 'promoId']);
  });

  it('lists the keys to set first, and leaves out built-ins and extracted values', () => {
    const r = e2eRequirements([login, create, reserve], env({ variables: { partnerId: 'P-1' }, secretVariableNames: ['cmsPassword'] }));
    const by = Object.fromEntries(r.variables.map((v) => [v.name, v]));
    expect(r.variables.map((v) => [v.name, v.status])).toEqual([
      ['ownerId', 'missing'],
      ['productId', 'missing'],
      // No database in the environment: the data query cannot run, so a value is needed.
      ['promoId', 'missing'],
      ['cmsUsername', 'example'],
      ['msisdn', 'example'],
      ['partnerId', 'set'],
      ['cmsPassword', 'secret'],
      ['accessToken', 'auto'],
      ['promoUuid', 'auto'],
    ]);
    expect(by.$timestamp).toBeUndefined();
    expect(by.cmsUsername).toMatchObject({ example: 'admin.qa', flows: ['Login CMS'] });
    expect(by.accessToken.source).toBe('diambil dari response di flow "Login CMS"');
    expect(by.cmsPassword.sensitive).toBe(true);
    expect(by.msisdn.sensitive).toBe(false);
  });

  it('counts an example made of a built-in as a fresh value per run', () => {
    const ref = flow('Confirm', [step({ path: '/internal/promo/confirm', body: { service_ref: '{{serviceRef}}' } })], { variables: { serviceRef: 'E2E-BLR-{{$timestamp}}' } });
    expect(e2eRequirements([ref], env()).variables[0]).toMatchObject({ name: 'serviceRef', status: 'auto', source: 'dibuat tiap run: E2E-BLR-{{$timestamp}}' });
  });

  it('counts a data query as automatic once the environment has a database', () => {
    const r = e2eRequirements([reserve], env({ databases: [{ name: 'promo', database: 'promo_db' }] as QAEnvironment['databases'] }));
    expect(r.variables.find((v) => v.name === 'promoId')).toMatchObject({ status: 'auto', source: 'query database di flow "Reserve"' });
  });

  it('flags services without a URL and a missing auth token', () => {
    const none = e2eRequirements([login, reserve], env({ services: { 'CORE-PROMO': 'http://promo.dev' } }));
    expect(none.services).toEqual([
      { service: 'core-tcico', status: 'missing', flows: ['Reserve'] },
      { service: 'core-promo', status: 'own', flows: ['Login CMS'] },
    ]);
    expect(e2eRequirements([reserve], env({ baseUrl: 'http://gw.dev' })).services[0].status).toBe('default');
    expect(e2eRequirements([reserve], env({ auth: { type: 'bearer' } })).authMissing).toBe(true);
    expect(e2eRequirements([reserve], env({ auth: { type: 'bearer' }, hasSecret: true })).authMissing).toBe(false);
    // Only steps that use the environment's auth need it.
    expect(e2eRequirements([login], env({ auth: { type: 'bearer' } })).authMissing).toBe(false);
    // 7 variables (ownerId, partnerId, productId, promoId, cmsUsername, cmsPassword, msisdn) and 2 services without a URL.
    expect(e2eRequirements([login, create, reserve], env()).todo).toBe(7 + 2);
  });
});
