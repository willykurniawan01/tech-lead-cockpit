import type { QAAssertion, QAFlow, QAStep, QASuspect } from './types';
import { QA_CATEGORY_LABELS } from './types';

/**
 * A reviewed change in words instead of JSON: rows of "label: before → after" for a test case's
 * fields and, per step, its request (endpoint, headers, query, body field by field),
 * expectations as sentences, extracted variables and DB setup. Also used for added and removed
 * test cases (every row added or removed). Pure, shared by both apps.
 */

export type RowKind = 'added' | 'removed' | 'changed' | 'same';

export interface ChangeRow {
  label: string;
  before?: string;
  after?: string;
  kind: RowKind;
}

export interface ChangeSection {
  title: string;
  rows: ChangeRow[];
}

export interface StepChange {
  title: string;
  /** "POST /v1/promo" (service), for the collapsed line. */
  endpoint: string;
  kind: RowKind;
  sections: ChangeSection[];
}

export interface FlowChange {
  fields: ChangeRow[];
  steps: StepChange[];
}

const OP_TEXT: Record<string, string> = {
  equals: '=',
  not_equals: '≠',
  contains: 'berisi',
  exists: 'ada',
  not_exists: 'tidak ada',
  matches: 'cocok dengan pola',
  type: 'bertipe',
  gt: '>',
  lt: '<',
};

/** A value as people read it: strings bare, the rest as compact JSON. */
export function show(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

const valueOp = (op: string, expected: unknown) => (op === 'exists' || op === 'not_exists' ? OP_TEXT[op] : `${OP_TEXT[op] ?? op} ${show(expected)}`);

export function assertionText(a: QAAssertion): string {
  switch (a.type) {
    case 'status':
      return Array.isArray(a.expected) ? `Status HTTP salah satu dari ${a.expected.join(', ')}` : `Status HTTP = ${a.expected}`;
    case 'json':
      return `Body ${a.path} ${valueOp(a.op, a.expected)}`;
    case 'header':
      return `Header ${a.name} ${valueOp(a.op, a.expected)}`;
    case 'latency':
      return `Waktu respons < ${a.expected} ms`;
    case 'db':
      return `Data di DB ${a.db}: ${a.column ?? 'jumlah baris'} ${valueOp(a.op, a.expected)} (${a.sql.replace(/\s+/g, ' ').trim()})`;
  }
}

/** Which expectation this is, so a changed value pairs with its old one. */
function assertionKey(a: QAAssertion): string {
  switch (a.type) {
    case 'json':
      return `json:${a.path}:${a.op}`;
    case 'header':
      return `header:${a.name.toLowerCase()}:${a.op}`;
    case 'db':
      return `db:${a.db}:${a.column ?? ''}:${a.sql}`;
    default:
      return a.type;
  }
}

/** A JSON body as field paths: { data: { amount: 1 } } → data.amount = 1. */
export function flatten(v: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (v && typeof v === 'object') {
    const entries = Array.isArray(v) ? v.map((x, i) => [`[${i}]`, x] as const) : Object.entries(v);
    if (!entries.length) out[prefix || '(isi)'] = Array.isArray(v) ? '[]' : '{}';
    for (const [k, x] of entries) flatten(x, Array.isArray(v) ? `${prefix}${k}` : prefix ? `${prefix}.${k}` : k, out);
  } else if (v !== undefined) out[prefix || '(isi)'] = show(v);
  return out;
}

/** Rows comparing two keyed lists of texts. */
function compare(before: Record<string, string>, after: Record<string, string>, label: (k: string) => string = (k) => k): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const [k, a] of Object.entries(after)) {
    const b = before[k];
    rows.push(b === undefined ? { label: label(k), after: a, kind: 'added' } : { label: label(k), before: b, after: a, kind: b === a ? 'same' : 'changed' });
  }
  for (const [k, b] of Object.entries(before)) if (!(k in after)) rows.push({ label: label(k), before: b, kind: 'removed' });
  return rows;
}

const one = (label: string, b: string | undefined, a: string | undefined): ChangeRow[] => {
  const before = b || undefined;
  const after = a || undefined;
  if (before === undefined && after === undefined) return [];
  return [{ label, before, after, kind: before === undefined ? 'added' : after === undefined ? 'removed' : before === after ? 'same' : 'changed' }];
};

const endpoint = (s: QAStep) => `${s.request.method} ${s.request.path}${s.service ? ` (${s.service})` : ''}`;

function body(v: unknown): Record<string, string> {
  if (v === undefined || v === null || v === '') return {};
  if (typeof v === 'string') {
    try {
      return flatten(JSON.parse(v));
    } catch {
      return { '(teks)': v };
    }
  }
  return flatten(v);
}

function stepSections(b: QAStep | undefined, a: QAStep | undefined): ChangeSection[] {
  // A whole step added or removed already shows its name and endpoint in its heading.
  const whole = !b || !a;
  const req = (s: QAStep | undefined) => ({
    endpoint: s ? endpoint(s) : undefined,
    headers: s?.request.headers ?? {},
    query: s?.request.query ?? {},
    body: body(s?.request.body),
  });
  const rb = req(b);
  const ra = req(a);
  const asserts = (s: QAStep | undefined) => Object.fromEntries((s?.assertions ?? []).map((x, i) => [`${assertionKey(x)}#${(s?.assertions ?? []).slice(0, i).filter((y) => assertionKey(y) === assertionKey(x)).length}`, assertionText(x)]));
  const setup = (s: QAStep | undefined) => ({
    ...Object.fromEntries((s?.setup ?? []).map((x, i) => [`Setup ${i + 1} (${x.db})`, x.sql.replace(/\s+/g, ' ').trim()])),
    ...Object.fromEntries((s?.redisDel ?? []).map((x, i) => [`Hapus key Redis ${i + 1} (${x.redis})`, x.keys.join(' ')])),
  });
  return [
    // Auth is on by default: only a step without it says so.
    { title: 'Step', rows: [...(whole ? [] : one('Nama', b?.name, a?.name)), ...one('Auth environment', b?.useEnvAuth === false ? 'tidak dipakai' : undefined, a?.useEnvAuth === false ? 'tidak dipakai' : undefined)] },
    {
      title: 'Request',
      rows: [
        ...(whole ? [] : one('Endpoint', rb.endpoint, ra.endpoint)),
        ...compare(rb.headers, ra.headers, (k) => `Header ${k}`),
        ...compare(rb.query, ra.query, (k) => `Query ${k}`),
        ...compare(rb.body, ra.body, (k) => `Body ${k}`),
      ],
    },
    // Expectations: one row each, the sentence itself (old one shown when its value changed).
    { title: 'Ekspektasi', rows: compare(asserts(b), asserts(a), () => '') },
    { title: 'Ambil variabel', rows: compare(b?.extract ?? {}, a?.extract ?? {}, (k) => `{{${k}}}`) },
    { title: 'Setup data DB/Redis', rows: compare(setup(b), setup(a)) },
  ].filter((s) => s.rows.length);
}

/** Readable rows for one test case: `before` absent = added, `after` absent = removed. */
export function flowChange(before: QAFlow | undefined, after: QAFlow | undefined): FlowChange {
  const cat = (f?: QAFlow) => (f ? (QA_CATEGORY_LABELS[f.category] ?? f.category) : undefined);
  const data = (f?: QAFlow) => Object.fromEntries((f?.dataQueries ?? []).map((q) => [`{{${q.name}}} dari ${q.db}`, `${q.sql.replace(/\s+/g, ' ').trim()}${q.column ? ` → kolom ${q.column}` : ''}`]));
  const fields: ChangeRow[] = [
    ...one('Nama', before?.name, after?.name),
    ...one('Deskripsi', before?.description, after?.description),
    ...one('Kategori', cat(before), cat(after)),
    ...one('Grup', before?.stage, after?.stage),
    ...one('Aktif', before ? (before.enabled ? 'ya' : 'tidak') : undefined, after ? (after.enabled ? 'ya' : 'tidak') : undefined),
    ...one('Detail task', before?.taskTitles.join(', '), after?.taskTitles.join(', ')),
    ...compare(before?.variables ?? {}, after?.variables ?? {}, (k) => `Variabel {{${k}}}`),
    ...compare(data(before), data(after), (k) => `Data uji ${k}`),
  ];

  const old = new Map((before?.steps ?? []).map((s) => [s.id, s]));
  const now = new Set((after?.steps ?? []).map((s) => s.id));
  const steps: StepChange[] = [];
  for (const s of after?.steps ?? []) {
    const was = old.get(s.id);
    const sections = stepSections(was, s);
    const changed = !was ? 'added' : sections.some((x) => x.rows.some((r) => r.kind !== 'same')) ? 'changed' : 'same';
    steps.push({ title: s.name, endpoint: endpoint(s), kind: changed, sections });
  }
  for (const s of before?.steps ?? []) if (!now.has(s.id)) steps.push({ title: s.name, endpoint: endpoint(s), kind: 'removed', sections: stepSections(s, undefined) });
  return { fields, steps };
}

/** Suite fields (notes, group order, suspected bugs) as rows. */
export function suiteFieldChange(field: string, before: unknown, after: unknown): ChangeRow[] {
  if (field === 'notes') return one('Catatan', show(before ?? ''), show(after ?? ''));
  if (field === 'groups') {
    const b = (before as string[] | undefined) ?? [];
    const a = (after as string[] | undefined) ?? [];
    const rows = compare(Object.fromEntries(b.map((g) => [g, g])), Object.fromEntries(a.map((g) => [g, g])), () => 'Grup').filter((r) => r.kind !== 'same');
    const order = (x: string[]) => x.filter((g) => b.includes(g) && a.includes(g)).join('\n');
    if (order(b) !== order(a)) rows.push({ label: 'Urutan', before: b.join(' → '), after: a.join(' → '), kind: 'changed' });
    return rows;
  }
  if (field === 'suspects') {
    const map = (x: unknown) => Object.fromEntries(((x as QASuspect[] | undefined) ?? []).map((s) => [`${s.flowName}: ${s.title}`, `${s.detail}${s.jiraKey ? ` (${s.jiraKey})` : ''}`]));
    return compare(map(before), map(after)).filter((r) => r.kind !== 'same');
  }
  return one(field, show(before), show(after));
}
