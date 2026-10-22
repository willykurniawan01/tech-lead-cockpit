import type { QAFlow, QAStep, QASuite, QASuiteChange } from './types';

/**
 * What changed between the published suite and a local draft, per test case, for the review
 * before sending to Confluence. `applyChanges` builds a suite with only some of those changes,
 * so a review can send (or throw away) part of a draft. Pure, shared by the connector and the UI.
 */

/** Suite fields shown in the review; the rest (undo, ai, generatedAt…) follow any send. */
const SUITE_FIELDS: Record<string, string> = { groups: 'Urutan grup', notes: 'Catatan suite', suspects: 'Daftar dugaan bug' };

const FLOW_FIELDS: [keyof QAFlow, string][] = [
  ['name', 'Nama'],
  ['description', 'Deskripsi'],
  ['category', 'Kategori'],
  ['stage', 'Grup'],
  ['enabled', 'Aktif'],
  ['taskTitles', 'Detail task'],
  ['variables', 'Variabel'],
  ['dataQueries', 'Data dari DB'],
];

const STEP_FIELDS: [keyof QAStep, string][] = [
  ['name', 'nama'],
  ['service', 'service'],
  ['request', 'request'],
  ['assertions', 'ekspektasi'],
  ['extract', 'ambil variabel'],
  ['useEnvAuth', 'auth environment'],
  ['setup', 'setup DB'],
];

/** JSON with sorted keys, to compare values whatever their key order. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/** Short text of a value for a review line. */
function short(v: unknown): string {
  if (v === undefined || v === null || v === '') return '(kosong)';
  if (typeof v === 'boolean') return v ? 'ya' : 'tidak';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function flowDetails(before: QAFlow, after: QAFlow): string[] {
  const out: string[] = [];
  for (const [key, label] of FLOW_FIELDS) {
    if (same(before[key], after[key])) continue;
    out.push(typeof after[key] === 'object' || typeof before[key] === 'object' ? `${label} diubah` : `${label}: ${short(before[key])} → ${short(after[key])}`);
  }
  const old = new Map(before.steps.map((s) => [s.id, s]));
  const now = new Set(after.steps.map((s) => s.id));
  for (const step of after.steps) {
    const was = old.get(step.id);
    if (!was) out.push(`Step "${step.name}" ditambah`);
    else {
      const fields = STEP_FIELDS.filter(([k]) => !same(was[k], step[k])).map(([, label]) => label);
      if (fields.length) out.push(`Step "${step.name}": ${fields.join(', ')} diubah`);
    }
  }
  for (const step of before.steps) if (!now.has(step.id)) out.push(`Step "${step.name}" dihapus`);
  const order = (s: QAStep[]) => s.map((x) => x.id).filter((id) => old.has(id) && now.has(id));
  if (!same(order(before.steps), order(after.steps))) out.push('Urutan step diubah');
  // What's left (warnings, repair notes): not worth a line of its own.
  if (!out.length && !same(before, after)) out.push('Catatan pemeriksaan diubah');
  return out;
}

/** Changes from `base` (published, null = nothing yet) to `next`, in `next`'s order. */
export function diffSuites(base: QASuite | null, next: QASuite): QASuiteChange[] {
  const before = new Map((base?.flows ?? []).map((f) => [f.id, f]));
  const after = new Map(next.flows.map((f) => [f.id, f]));
  const out: QASuiteChange[] = [];
  for (const f of next.flows) {
    const was = before.get(f.id);
    if (!was) out.push({ key: f.id, kind: 'added', title: f.name, group: f.stage, details: [`${f.steps.length} step`], after: f });
    else if (!same(was, f)) out.push({ key: f.id, kind: 'changed', title: f.name, group: f.stage, details: flowDetails(was, f), before: was, after: f });
  }
  for (const f of base?.flows ?? []) {
    if (!after.has(f.id)) out.push({ key: f.id, kind: 'removed', title: f.name, group: f.stage, details: [], before: f });
  }
  for (const [field, title] of Object.entries(SUITE_FIELDS)) {
    const b = (base as unknown as Record<string, unknown> | null)?.[field];
    const a = (next as unknown as Record<string, unknown>)[field];
    if (same(b ?? null, a ?? null) || (isEmpty(b) && isEmpty(a))) continue;
    out.push({ key: `suite:${field}`, kind: isEmpty(b) ? 'added' : isEmpty(a) ? 'removed' : 'changed', title, details: [], before: b, after: a });
  }
  return out;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/**
 * `from` with the changes `keys` (from diffSuites(from, to)) taken from `to`: a test case comes
 * from `to` (or goes, when `to` dropped it), a suite field takes `to`'s value. Order: `to`'s,
 * with test cases only `from` still has kept after the one they followed there.
 */
export function applyChanges(from: QASuite | null, to: QASuite, keys: Iterable<string>): QASuite {
  const pick = new Set(keys);
  const a = new Map((from?.flows ?? []).map((f) => [f.id, f]));
  const b = new Map(to.flows.map((f) => [f.id, f]));
  const kept = (id: string) => (pick.has(id) ? b.get(id) : a.get(id));

  const order = to.flows.map((f) => f.id);
  // Test cases `to` doesn't have, kept because not picked: back after their predecessor in `from`.
  let prev: string | undefined;
  for (const f of from?.flows ?? []) {
    if (!b.has(f.id)) order.splice(prev === undefined ? 0 : order.indexOf(prev) + 1, 0, f.id);
    prev = f.id;
  }
  const flows = order.map(kept).filter((f): f is QAFlow => Boolean(f));

  const out: Record<string, unknown> = { ...(from ?? {}), ...to, flows };
  for (const field of Object.keys(SUITE_FIELDS)) {
    const value = pick.has(`suite:${field}`) ? (to as unknown as Record<string, unknown>)[field] : (from as unknown as Record<string, unknown> | null)?.[field];
    if (value === undefined) delete out[field];
    else out[field] = value;
  }
  return out as unknown as QASuite;
}
