import type { QAFlow, QASuite } from './types';

/**
 * Groups of test cases in the Skenario tab. A flow's group is its `stage` (the journey stage the
 * planner gave it, or one the user picked); flows without one are "Tanpa grup". `QASuite.groups`
 * keeps the order of the groups and the ones that are still empty.
 *
 * Flows run in the order shown: group by group, and within a group in suite order, so every change
 * here also re-arranges `flows` (arrangeFlows) to keep the two the same.
 */

export const MAX_GROUP_NAME = 120;
export const MAX_GROUPS = 100;
export const UNGROUPED_LABEL = 'Tanpa grup';

/** A group name as stored: trimmed, single-line, at most MAX_GROUP_NAME characters. */
export const cleanGroupName = (name: unknown): string => (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME) : '');

/** Saved group names, cleaned and without repeats (also used to validate a suite in the connector). */
export function normalizeGroups(raw: unknown): string[] {
  const out: string[] = [];
  for (const g of Array.isArray(raw) ? raw : []) {
    const name = cleanGroupName(g);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

/** Group order: the saved groups, then groups that only exist on flows (first appearance). */
export function groupOrder(suite: Pick<QASuite, 'flows' | 'groups'>): string[] {
  const order = normalizeGroups(suite.groups);
  for (const f of suite.flows) {
    const g = cleanGroupName(f.stage);
    if (g && !order.includes(g)) order.push(g);
  }
  return order;
}

const groupOf = (f: Pick<QAFlow, 'stage'>) => cleanGroupName(f.stage);

/** Flows in display (and run) order: by group, ungrouped last; the order within a group is kept. */
export function arrangeFlows(flows: QAFlow[], order: string[]): QAFlow[] {
  const rank = (f: QAFlow) => {
    const i = order.indexOf(groupOf(f));
    return i < 0 ? order.length : i;
  };
  return flows.map((f, i) => ({ f, i, r: rank(f) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.f);
}

/** The suite with its groups saved in full and its flows in group order. */
export function withGroups(suite: QASuite, order = groupOrder(suite)): QASuite {
  return { ...suite, groups: order, flows: arrangeFlows(suite.flows, order) };
}

export interface FlowGroup {
  /** '' for "Tanpa grup". */
  name: string;
  flows: QAFlow[];
}

/**
 * Groups to show. `visible` (a search) limits the flows listed; then only groups with a match are
 * shown, while without a search empty groups are shown too (so one can fill them).
 */
export function groupFlows(suite: Pick<QASuite, 'flows' | 'groups'>, visible?: Set<string>): FlowGroup[] {
  const order = groupOrder(suite);
  const shown = (f: QAFlow) => !visible || visible.has(f.id);
  const groups: FlowGroup[] = order.map((name) => ({ name, flows: suite.flows.filter((f) => groupOf(f) === name && shown(f)) }));
  const loose = suite.flows.filter((f) => !groupOf(f) && shown(f));
  if (loose.length) groups.push({ name: '', flows: loose });
  return visible ? groups.filter((g) => g.flows.length) : groups;
}

export type CheckState = 'all' | 'some' | 'none';

/** How many flows of a group are checked to run (all of the group, not only a search's matches). */
export function groupCheck(flows: QAFlow[], group: string): { checked: number; total: number; state: CheckState } {
  const inGroup = flows.filter((f) => groupOf(f) === group);
  const checked = inGroup.filter((f) => f.enabled).length;
  return { checked, total: inGroup.length, state: !inGroup.length || !checked ? 'none' : checked === inGroup.length ? 'all' : 'some' };
}

/** Checks or unchecks every flow of a group. */
export const setGroupEnabled = (flows: QAFlow[], group: string, enabled: boolean): QAFlow[] => flows.map((f) => (groupOf(f) === group ? { ...f, enabled } : f));

/** Why a new or renamed group name can't be used; undefined when it can. */
export function groupNameError(suite: Pick<QASuite, 'flows' | 'groups'>, name: string, current?: string): string | undefined {
  const clean = cleanGroupName(name);
  if (!clean) return 'Nama grup kosong.';
  if (clean.toLowerCase() === UNGROUPED_LABEL.toLowerCase()) return `"${UNGROUPED_LABEL}" sudah dipakai untuk flow tanpa grup.`;
  if (clean !== current && groupOrder(suite).some((g) => g.toLowerCase() === clean.toLowerCase())) return `Grup "${clean}" sudah ada.`;
  if (current === undefined && groupOrder(suite).length >= MAX_GROUPS) return `Maksimal ${MAX_GROUPS} grup.`;
  return undefined;
}

function assertName(suite: QASuite, name: string, current?: string): string {
  const err = groupNameError(suite, name, current);
  if (err) throw new Error(err);
  return cleanGroupName(name);
}

/** Adds an empty group at the end. */
export function addGroup(suite: QASuite, name: string): QASuite {
  const clean = assertName(suite, name);
  return withGroups(suite, [...groupOrder(suite), clean]);
}

/** Renames a group in place: same position, its flows move along. */
export function renameGroup(suite: QASuite, from: string, to: string): QASuite {
  const clean = assertName(suite, to, from);
  if (clean === from) return withGroups(suite);
  const order = groupOrder(suite).map((g) => (g === from ? clean : g));
  return withGroups({ ...suite, flows: suite.flows.map((f) => (groupOf(f) === from ? { ...f, stage: clean } : f)) }, order);
}

/** Removes a group; its flows stay, in "Tanpa grup". */
export function removeGroup(suite: QASuite, name: string): QASuite {
  const flows = suite.flows.map((f) => {
    if (groupOf(f) !== name) return f;
    const { stage: _stage, ...rest } = f;
    return rest;
  });
  return withGroups({ ...suite, flows }, groupOrder(suite).filter((g) => g !== name));
}

/** Moves a group one place up (-1) or down (1); its flows move with it. */
export function moveGroup(suite: QASuite, name: string, d: -1 | 1): QASuite {
  const order = groupOrder(suite);
  const i = order.indexOf(name);
  const j = i + d;
  if (i < 0 || j < 0 || j >= order.length) return withGroups(suite, order);
  [order[i], order[j]] = [order[j], order[i]];
  return withGroups(suite, order);
}

/** Puts a flow at the end of a group ('' = Tanpa grup); a new group name is added at the end. */
export function moveFlowToGroup(suite: QASuite, flowId: string, group: string): QASuite {
  const clean = cleanGroupName(group);
  const order = groupOrder(suite);
  if (clean && !order.includes(clean)) order.push(assertName(suite, clean));
  const flow = suite.flows.find((f) => f.id === flowId);
  if (!flow) return withGroups(suite, order);
  const { stage: _stage, ...rest } = flow;
  const moved: QAFlow = clean ? { ...rest, stage: clean } : rest;
  return withGroups({ ...suite, flows: [...suite.flows.filter((f) => f.id !== flowId), moved] }, order);
}

/** Moves a flow one place within its own group (the order flows run and pass data in). */
export function moveFlowInGroup(suite: QASuite, flowId: string, d: -1 | 1): QASuite {
  const arranged = withGroups(suite);
  const flows = [...arranged.flows];
  const i = flows.findIndex((f) => f.id === flowId);
  if (i < 0) return arranged;
  const group = groupOf(flows[i]);
  let j = i + d;
  while (j >= 0 && j < flows.length && groupOf(flows[j]) !== group) j += d;
  if (j < 0 || j >= flows.length) return arranged;
  [flows[i], flows[j]] = [flows[j], flows[i]];
  return { ...arranged, flows };
}

/** First/last flow of its group, to disable the ↑/↓ buttons. */
export function edgeOfGroup(suite: Pick<QASuite, 'flows' | 'groups'>, flowId: string): { first: boolean; last: boolean } {
  const flow = suite.flows.find((f) => f.id === flowId);
  const same = flow ? suite.flows.filter((f) => groupOf(f) === groupOf(flow)) : [];
  return { first: same[0]?.id === flowId, last: same.at(-1)?.id === flowId };
}
