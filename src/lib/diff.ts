export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

const MAX_CELLS = 30_000_000;

/**
 * Line-level LCS diff. The common prefix and suffix are skipped first (AI edits usually touch a
 * few sections of a long TAD), so only the changed middle needs the quadratic table.
 */
export function lineDiff(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const head = before.slice(0, start).map((text) => ({ type: 'same' as const, text }));
  const tail = before.slice(endB).map((text) => ({ type: 'same' as const, text }));
  return [...head, ...middleDiff(before.slice(start, endB), after.slice(start, endA)), ...tail];
}

function middleDiff(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  if (n * m > MAX_CELLS || n >= 65_535 || m >= 65_535) {
    return [...before.map((text) => ({ type: 'del' as const, text })), ...after.map((text) => ({ type: 'add' as const, text }))];
  }
  // Uint16 rows keep a 3000×3000 table around 18 MB.
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ type: 'same', text: before[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: before[i++] });
    } else {
      out.push({ type: 'add', text: after[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: before[i++] });
  while (j < m) out.push({ type: 'add', text: after[j++] });
  return out;
}

export interface DiffHunk {
  id: number;
  /** Index range [start, end) into the diff, including unchanged lines merged between close changes. */
  start: number;
  end: number;
  /** Nearest Markdown heading at or before the change, for orientation. */
  section: string;
  added: number;
  removed: number;
}

/** Changes separated by fewer than `joinGap` unchanged lines form one reviewable block. */
export function buildHunks(diff: DiffLine[], joinGap = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let lastHeading = '(awal dokumen)';
  let current: DiffHunk | null = null;
  let gap = 0;
  diff.forEach((line, idx) => {
    const isHeading = /^#{1,6}\s/.test(line.text);
    if (line.type === 'same') {
      if (isHeading) lastHeading = line.text.replace(/^#+\s*/, '');
      if (current) {
        gap++;
        if (gap >= joinGap) {
          current.end = idx - gap + 1;
          current = null;
        }
      }
      return;
    }
    if (!current) {
      current = { id: hunks.length, start: idx, end: idx + 1, section: isHeading && line.type === 'add' ? line.text.replace(/^#+\s*/, '') : lastHeading, added: 0, removed: 0 };
      hunks.push(current);
    }
    gap = 0;
    current.end = idx + 1;
    if (line.type === 'add') current.added++;
    else current.removed++;
    if (isHeading && line.type !== 'del') lastHeading = line.text.replace(/^#+\s*/, '');
  });
  return hunks;
}

/** Rebuilds the document taking the proposed side only for accepted hunks. */
export function applyHunks(diff: DiffLine[], hunks: DiffHunk[], accepted: ReadonlySet<number>): string {
  const owner = new Int32Array(diff.length).fill(-1);
  for (const h of hunks) for (let i = h.start; i < h.end; i++) owner[i] = h.id;
  const out: string[] = [];
  diff.forEach((line, i) => {
    if (line.type === 'same') return out.push(line.text);
    const take = owner[i] >= 0 && accepted.has(owner[i]);
    if ((line.type === 'add' && take) || (line.type === 'del' && !take)) out.push(line.text);
  });
  return out.join('\n');
}

/** Readable text lines from Confluence storage XHTML, for a content-level comparison. */
export function storageToLines(xhtml: string): string[] {
  const text = xhtml
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '\n$1\n')
    .replace(/<ri:user[^>]*ri:account-id="([^"]+)"[^>]*\/?>/g, '@$1')
    .replace(/<\/(p|div)>(?=\s*<\/t[dh]>)/gi, '')
    .replace(/<\/(p|h[1-6]|li|tr|blockquote|pre)>|<br\s*\/?>/g, '\n')
    .replace(/<\/t[dh]>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  return text
    .split('\n')
    .map((l) => l.replace(/\s*\|\s*$/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
