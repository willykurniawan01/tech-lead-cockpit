/**
 * Three-way merge of a TAD draft with edits made directly in Confluence, per section.
 *
 * base   = the page at the version the draft was last imported from / published as,
 * local  = the draft in Cockpit,
 * remote = the page now.
 * Sections are cut at `#` and `##` headings (outside code fences), so a task changed in
 * Confluence and another changed in Cockpit merge on their own; only a section changed on both
 * sides needs a decision.
 */

export interface Section {
  key: string;
  title: string;
  text: string;
}

export type SectionStatus =
  | 'same'
  /** Changed only in Confluence: taken from Confluence. */
  | 'remote'
  /** Changed only in Cockpit: kept. */
  | 'local'
  /** Changed on both sides differently: the user picks. */
  | 'conflict'
  /** New in Confluence. */
  | 'added-remote'
  /** New in Cockpit. */
  | 'added-local'
  /** Deleted in Confluence (unchanged in Cockpit): dropped. */
  | 'removed-remote'
  /** Deleted in Cockpit (unchanged in Confluence): stays deleted. */
  | 'removed-local';

export interface MergeSection {
  key: string;
  title: string;
  base?: string;
  local?: string;
  remote?: string;
  status: SectionStatus;
  choice: 'local' | 'remote';
}

const PREAMBLE = '(awal dokumen)';

/** Splits Markdown at `#`/`##` headings that are not inside code fences. */
export function splitSections(md: string): Section[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: Section[] = [];
  const seen = new Map<string, number>();
  let title = PREAMBLE;
  let buf: string[] = [];
  let fence = false;
  const push = () => {
    const text = buf.join('\n').replace(/\s+$/, '');
    if (title === PREAMBLE && !text.trim()) return;
    const base = normKey(title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: n > 1 ? `${base}#${n}` : base, title, text });
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (h) {
      push();
      title = h[2];
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  push();
  return out;
}

const normKey = (title: string) =>
  title
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Text compared for equality: mention spans become their names and whitespace is collapsed, so a
 * section only counts as changed when its content changed (not because of how it was converted).
 */
export function normalizeForCompare(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text
    .replace(/<span data-tlc-user="[^"]*">([\s\S]*?)<\/span>/g, '$1')
    .replace(/&nbsp;| /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function threeWayMerge(baseMd: string, localMd: string, remoteMd: string): MergeSection[] {
  const index = (md: string) => new Map(splitSections(md).map((s) => [s.key, s]));
  const base = index(baseMd);
  const local = index(localMd);
  const remote = index(remoteMd);

  // Confluence's order, with sections that only exist in Cockpit placed after their local predecessor.
  const order = [...remote.keys()];
  let prev: string | undefined;
  for (const k of local.keys()) {
    if (!order.includes(k)) {
      const at = prev === undefined ? 0 : order.indexOf(prev) + 1;
      order.splice(at, 0, k);
    }
    prev = k;
  }
  for (const k of base.keys()) if (!order.includes(k)) order.push(k);

  const out: MergeSection[] = [];
  for (const key of order) {
    const b = base.get(key)?.text;
    const l = local.get(key)?.text;
    const r = remote.get(key)?.text;
    const nb = normalizeForCompare(b);
    const nl = normalizeForCompare(l);
    const nr = normalizeForCompare(r);
    const title = remote.get(key)?.title ?? local.get(key)?.title ?? base.get(key)?.title ?? key;
    let status: SectionStatus;
    let choice: MergeSection['choice'];
    if (nl === nr) {
      if (l === undefined) continue; // deleted on both sides
      status = 'same';
      choice = 'local';
    } else if (nl === nb) {
      status = r === undefined ? 'removed-remote' : b === undefined ? 'added-remote' : 'remote';
      choice = 'remote';
    } else if (nr === nb) {
      status = l === undefined ? 'removed-local' : b === undefined ? 'added-local' : 'local';
      choice = 'local';
    } else {
      // Changed differently on both sides (or added on both): keep Cockpit's until the user picks.
      status = 'conflict';
      choice = 'local';
    }
    out.push({ key, title, base: b, local: l, remote: r, status, choice });
  }
  return out;
}

/** The merged Markdown from each section's choice. */
export function buildMerged(sections: MergeSection[]): string {
  return (
    sections
      .map((s) => (s.choice === 'local' ? s.local : s.remote))
      .filter((t): t is string => t !== undefined && t.trim() !== '')
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

export function mergeSummary(sections: MergeSection[]) {
  const count = (...st: SectionStatus[]) => sections.filter((s) => st.includes(s.status)).length;
  return {
    fromRemote: count('remote', 'added-remote', 'removed-remote'),
    keptLocal: count('local', 'added-local', 'removed-local'),
    conflicts: count('conflict'),
    same: count('same'),
  };
}
