import type { QAFlow, QASuite } from './types';

/**
 * Three-way merge of a test suite, per test case: when someone saved the suite after `mine` was
 * loaded (`base`), changes to different test cases are combined instead of refusing the save.
 * Only the same test case changed differently on both sides (or edited on one side and deleted
 * on the other) is a real conflict. Pure, so the connector and its tests share it.
 */

/** `conflicts`: what changed on both sides, ready for a message ('test case "X"', 'catatan suite'). */
export type SuiteMerge = { suite: QASuite } | { conflicts: string[] };

const FIELD_LABEL: Record<string, string> = { notes: 'catatan suite', suspects: 'daftar dugaan bug', undo: 'perbaikan AI terakhir', projectName: 'nama proyek' };

/** JSON with sorted keys, to compare values whatever their key order (the database reorders jsonb). */
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

/** Fields the store sets on every save; never a reason for a conflict. */
const META = new Set(['version', 'updatedBy', 'updatedAt', 'flows', 'groups', 'draftRev', 'draft']);

export function mergeSuites(base: QASuite, mine: QASuite, theirs: QASuite): SuiteMerge {
  const index = (s: QASuite) => new Map(s.flows.map((f) => [f.id, f]));
  const b = index(base);
  const m = index(mine);
  const t = index(theirs);
  const conflicts: string[] = [];
  const merged = new Map<string, QAFlow>();

  for (const id of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const bf = b.get(id);
    const mf = m.get(id);
    const tf = t.get(id);
    const name = `test case "${(mf ?? tf ?? bf)!.name}"`;
    if (!bf) {
      // Added on one side (or the same id on both, which only happens with identical copies).
      if (mf && tf && !same(mf, tf)) conflicts.push(name);
      else merged.set(id, (mf ?? tf)!);
      continue;
    }
    if (!mf || !tf) {
      // Deleted on one side: fine when the other side left it as it was.
      const kept = mf ?? tf;
      if (kept && !same(kept, bf)) conflicts.push(name);
      continue;
    }
    if (same(mf, bf)) merged.set(id, tf);
    else if (same(tf, bf) || same(mf, tf)) merged.set(id, mf);
    else conflicts.push(name);
  }
  // Other fields (notes, suspects, undo, …): whoever changed it; both, differently → a conflict.
  const rest: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    if (META.has(key)) continue;
    const [mv, bv, tv] = [mine, base, theirs].map((x) => (x as unknown as Record<string, unknown>)[key]);
    if (same(mv, bv)) rest[key] = tv;
    else if (same(tv, bv) || same(mv, tv)) rest[key] = mv;
    else conflicts.push(FIELD_LABEL[key] ?? key);
  }
  if (conflicts.length) return { conflicts };

  // Order: mine when only I reordered, else theirs; flows only one side has go after, in its order.
  const ids = (s: QASuite) => s.flows.map((f) => f.id);
  const mineReordered = !same(ids(mine).filter((id) => b.has(id)), ids(base).filter((id) => m.has(id)));
  const theirsReordered = !same(ids(theirs).filter((id) => b.has(id)), ids(base).filter((id) => t.has(id)));
  const order = [...new Set([...(mineReordered && !theirsReordered ? ids(mine) : ids(theirs)), ...ids(mine), ...ids(theirs)])];
  const flows = order.filter((id) => merged.has(id)).map((id) => merged.get(id)!);

  // Group list: whoever changed it; both changed → mine, then theirs' extra groups.
  const groups = same(mine.groups, base.groups) ? theirs.groups : same(theirs.groups, base.groups) ? mine.groups : [...new Set([...(mine.groups ?? []), ...(theirs.groups ?? [])])];

  return { suite: { ...(rest as unknown as QASuite), flows, ...(groups ? { groups } : {}), version: theirs.version, updatedAt: mine.updatedAt } };
}
