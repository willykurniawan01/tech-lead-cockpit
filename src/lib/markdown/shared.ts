/**
 * Conventions shared by the in-app preview and the Confluence converter, so what the
 * user sees in the preview is what lands on the Confluence page.
 */

export type CalloutKind = 'note' | 'info' | 'tip' | 'important' | 'warning' | 'caution';

export interface CalloutStyle {
  label: string;
  /** Confluence panel macro with the matching colour. */
  macro: 'info' | 'tip' | 'note' | 'warning';
}

export const CALLOUTS: Record<CalloutKind, CalloutStyle> = {
  note: { label: 'Catatan', macro: 'info' },
  info: { label: 'Info', macro: 'info' },
  tip: { label: 'Tip', macro: 'tip' },
  important: { label: 'Penting', macro: 'note' },
  warning: { label: 'Perhatian', macro: 'note' },
  caution: { label: 'Bahaya', macro: 'warning' },
};

/** GitHub-style `> [!NOTE]` alerts. `text` is the blockquote's inner Markdown. */
export function parseCallout(text: string): { kind: CalloutKind; body: string } | null {
  const m = text.match(/^\s*\[!(\w+)\][ \t]*\n?/);
  if (!m) return null;
  const kind = m[1].toLowerCase() as CalloutKind;
  if (!(kind in CALLOUTS)) return null;
  return { kind, body: text.slice(m[0].length) };
}

export type LozengeColour = 'Grey' | 'Red' | 'Yellow' | 'Green' | 'Blue';

/** Table cells whose whole text is one of these render as a status lozenge. */
const STATUS: Record<string, LozengeColour> = {
  high: 'Red',
  medium: 'Yellow',
  low: 'Green',
  draft: 'Grey',
  'in review': 'Blue',
  approved: 'Green',
  rejected: 'Red',
  deprecated: 'Grey',
  'initiate document': 'Grey',
  'in development': 'Yellow',
  testing: 'Yellow',
  'in testing': 'Yellow',
  completed: 'Green',
  done: 'Green',
};

export function statusColour(cellText: string): LozengeColour | undefined {
  return STATUS[cellText.trim().toLowerCase()];
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `<br>` is the only raw HTML allowed: TAD tables use it for multi-line cells (e.g. reviewers). */
export function isLineBreakTag(html: string): boolean {
  return /^<br\s*\/?>$/i.test(html.trim());
}
