import { lineDiff, type DiffHunk, type DiffLine } from './diff';

/**
 * Word-level "track changes" between two rendered HTML fragments, like Word's revision marks:
 * the result is the new document with inserted words in <ins> and removed words in <del>.
 * Tags come from the new version, so the structure stays valid; removed text appears in place.
 */

const TOKEN = /<[^>]+>|&[#\w]+;|\s+|[^\s<&]+/g;

function tokenize(html: string): string[] {
  return html.match(TOKEN) ?? [];
}

const isTag = (t: string) => t.startsWith('<');
const isSpace = (t: string) => /^\s+$/.test(t);

export function htmlDiff(before: string, after: string): string {
  const diff = lineDiff(tokenize(before), tokenize(after));
  let out = '';
  let run: { type: 'add' | 'del'; text: string; row?: boolean } | null = null;
  // Inside table structure but outside any cell, stray text would be foster-parented above the table.
  let cellDepth = 0;
  let tableDepth = 0;

  const flush = () => {
    if (!run) return;
    if (run.row) {
      // Text of a removed row sits between rows: show it as a struck-out row of its own.
      if (run.text.trim()) out += `<tr class="tc-row-del"><td colspan="100"><del class="tc-del">${run.text.trim()}</del></td></tr>`;
    } else if (run.text.trim()) {
      const tag = run.type === 'add' ? 'ins' : 'del';
      out += `<${tag} class="tc-${run.type}">${run.text}</${tag}>`;
    } else if (run.type === 'add') {
      out += run.text;
    }
    run = null;
  };

  const track = (tag: string) => {
    if (/^<(table)\b/i.test(tag)) tableDepth++;
    else if (/^<\/table>/i.test(tag)) tableDepth--;
    else if (/^<(td|th)\b/i.test(tag)) cellDepth++;
    else if (/^<\/(td|th)>/i.test(tag)) cellDepth--;
  };

  for (const { type, text } of diff) {
    if (isTag(text)) {
      // Removed tags are dropped: the new version's structure is shown. Their boundaries still
      // separate the removed text, so words from different cells/paragraphs don't run together.
      if (type === 'del') {
        if (run?.type === 'del' && run.text.trim()) {
          if (/^<\/(td|th)>/i.test(text)) run.text += ' │ ';
          else if (/^<\/(tr|p|li|h[1-6]|pre|div)>/i.test(text)) run.text += '<br>';
        }
        continue;
      }
      flush();
      track(text);
      out += text;
      continue;
    }
    if (type === 'same') {
      flush();
      out += text;
      continue;
    }
    // Between rows (inside a table, outside any cell) text can't be placed inline.
    const row = tableDepth > 0 && cellDepth < tableDepth;
    if (row && type === 'add') {
      out += text;
      continue;
    }
    if (run && (run.type !== type || Boolean(run.row) !== row) && !isSpace(text)) flush();
    if (!run) run = { type, text: '', row };
    run.text += text;
  }
  flush();
  return out;
}

/** True when the fragment only differs in markup (e.g. attributes), not in visible text. */
export function sameText(before: string, after: string): boolean {
  const text = (h: string) => tokenize(h).filter((t) => !isTag(t) && !isSpace(t)).join(' ');
  return text(before) === text(after);
}


/**
 * Word-level track changes for one hunk of a Markdown line diff: the hunk is widened to whole
 * blocks (up to the blank lines around it) so tables and lists render completely.
 * `render` turns Markdown into HTML (the TAD preview renderer).
 */
export function trackedHunk(diff: DiffLine[], h: Pick<DiffHunk, 'start' | 'end'>, render: (md: string) => string): { html: string; formatOnly: boolean } {
  let s = h.start;
  let e = h.end;
  const blank = (i: number) => diff[i].type === 'same' && !diff[i].text.trim();
  while (s > 0 && !blank(s - 1)) s--;
  while (e < diff.length && !blank(e)) e++;
  const lines = diff.slice(s, e);
  const before = render(lines.filter((l) => l.type !== 'add').map((l) => l.text).join('\n'));
  const after = render(lines.filter((l) => l.type !== 'del').map((l) => l.text).join('\n'));
  return { html: htmlDiff(before, after), formatOnly: sameText(before, after) };
}
