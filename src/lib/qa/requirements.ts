import type { QAEnvironment, QAFlow } from './types';

/**
 * What an environment still needs before the flows can run: the {{variables}} nobody fills, the
 * services without a base URL, and a missing auth token. Mirrors the runner's order: secret
 * variables, then values extracted by earlier steps/flows, then environment variables, then the
 * AI's example values in the flow (which run, but are rarely real test data).
 */

/** Built-ins the runner fills itself (connector/qa/runner.ts). */
export const QA_BUILTIN_VARS = ['$uuid', '$timestamp', '$unix', '$now', '$randomInt'] as const;

export type VarStatus = 'missing' | 'example' | 'set' | 'secret' | 'auto';

export interface VarNeed {
  name: string;
  status: VarStatus;
  /** The AI's example value (first flow that has one). */
  example?: string;
  /** For 'auto': where the value comes from. */
  source?: string;
  /** Names of the flows that use it. */
  flows: string[];
  /** Looks like a credential: belongs in the Keychain (secret variables). */
  sensitive: boolean;
}

export interface ServiceNeed {
  /** Empty: steps that name no service (they use the default base URL). */
  service: string;
  status: 'own' | 'default' | 'missing';
  flows: string[];
}

export interface E2ERequirements {
  variables: VarNeed[];
  services: ServiceNeed[];
  /** Steps use the environment's auth, but its token/password is not stored yet. */
  authMissing: boolean;
  /** Keys to act on: missing or example-only variables, services without a URL, auth. */
  todo: number;
}

const VAR = /\{\{\s*([$\w.-]+)\s*(?:\|\s*\w+\s*)?\}\}/g;
const SENSITIVE = /pass(word)?|\bpin\b|pin$|^pin|otp|secret|token|api.?key|signature|private|credential/i;

function names(value: unknown, out: Set<string>) {
  if (typeof value === 'string') for (const m of value.matchAll(VAR)) out.add(m[1]);
  else if (Array.isArray(value)) value.forEach((v) => names(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => names(v, out));
}

/** The {{names}} one flow uses (request, assertions, data queries). */
export function flowVariables(flow: QAFlow): Set<string> {
  const out = new Set<string>();
  for (const s of flow.steps) {
    names([s.request.path, s.request.headers, s.request.query, s.request.body], out);
    for (const a of s.assertions) names(a.type === 'db' ? [a.sql, a.expected] : 'expected' in a ? a.expected : undefined, out);
  }
  for (const q of flow.dataQueries ?? []) names(q.sql, out);
  return out;
}

export function e2eRequirements(flows: QAFlow[], env?: QAEnvironment): E2ERequirements {
  const builtins = new Set<string>(QA_BUILTIN_VARS);
  const secrets = new Set(env?.secretVariableNames ?? []);
  const envVars = env?.variables ?? {};
  const hasDb = Boolean(env?.databases?.length);
  const usedBy = new Map<string, string[]>();
  const examples = new Map<string, string>();
  const extracted = new Map<string, string>();
  const queried = new Map<string, string>();
  for (const f of flows) {
    for (const n of flowVariables(f)) if (!builtins.has(n)) usedBy.set(n, [...(usedBy.get(n) ?? []), f.name]);
    for (const [k, v] of Object.entries(f.variables ?? {})) if (v !== '' && !examples.has(k)) examples.set(k, v);
    for (const s of f.steps) for (const k of Object.keys(s.extract ?? {})) if (!extracted.has(k)) extracted.set(k, f.name);
    for (const q of f.dataQueries ?? []) if (!queried.has(q.name)) queried.set(q.name, f.name);
  }
  const rank: Record<VarStatus, number> = { missing: 0, example: 1, set: 2, secret: 3, auto: 4 };
  const variables: VarNeed[] = [...usedBy]
    .map(([name, used]): VarNeed => {
      const base = { name, flows: [...new Set(used)], sensitive: SENSITIVE.test(name), ...(examples.has(name) ? { example: examples.get(name) } : {}) };
      if (secrets.has(name)) return { ...base, status: 'secret' };
      if (extracted.has(name)) return { ...base, status: 'auto', source: `diambil dari response di flow "${extracted.get(name)}"` };
      if (envVars[name] !== undefined && envVars[name] !== '') return { ...base, status: 'set' };
      if (queried.has(name) && hasDb) return { ...base, status: 'auto', source: `query database di flow "${queried.get(name)}"` };
      // An example built from a built-in (E2E-{{$timestamp}}) is a fresh value each run, not test data.
      if (/\{\{\s*\$/.test(examples.get(name) ?? '')) return { ...base, status: 'auto', source: `dibuat tiap run: ${examples.get(name)}` };
      return { ...base, status: examples.has(name) ? 'example' : 'missing' };
    })
    .sort((a, b) => rank[a.status] - rank[b.status] || Number(b.sensitive) - Number(a.sensitive) || a.name.localeCompare(b.name));

  const byService = new Map<string, string[]>();
  let usesAuth = false;
  for (const f of flows)
    for (const s of f.steps) {
      const key = s.service?.trim() ?? '';
      byService.set(key, [...(byService.get(key) ?? []), f.name]);
      if (s.useEnvAuth !== false) usesAuth = true;
    }
  const ownUrl = (svc: string) => Object.entries(env?.services ?? {}).some(([k, v]) => k.toLowerCase() === svc.toLowerCase() && v.trim());
  const fallback = Boolean(env?.baseUrl?.trim());
  const services: ServiceNeed[] = [...byService]
    .map(([service, used]): ServiceNeed => ({ service, flows: [...new Set(used)], status: service && ownUrl(service) ? 'own' : fallback ? 'default' : 'missing' }))
    .sort((a, b) => Number(b.status === 'missing') - Number(a.status === 'missing') || a.service.localeCompare(b.service));

  const authMissing = Boolean(env && usesAuth && env.auth.type !== 'none' && !env.hasSecret);
  const todo = variables.filter((v) => v.status === 'missing' || v.status === 'example').length + services.filter((s) => s.status === 'missing').length + Number(authMissing);
  return { variables, services, authMissing, todo };
}
