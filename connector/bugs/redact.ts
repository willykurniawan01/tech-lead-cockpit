/**
 * Masks secrets and personal data in logs before an AI sees them. The original stays on disk
 * (0600) for the user; only the redacted copy goes into the AI's working folder.
 */

const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // Authorization headers and bearer/basic tokens.
  [/\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)(bearer|basic|token)?\s*[^\s"',}]+/gi, (_m, k, sep, scheme) => `${k}${sep}${scheme ? `${scheme} ` : ''}***`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // JSON/query/form secrets: "password":"x", token=x, api_key: x.
  [/(["']?(?:password|passwd|pwd|pin|otp|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|session[_-]?id|cookie|signature)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&}\]]+)/gi, (_m, k, v) => `${k}${v.startsWith('"') ? '"***"' : v.startsWith("'") ? "'***'" : '***'}`],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***JWT***'],
  // Card numbers (13–19 digits, optional separators) — keep the last 4.
  [/\b(?:\d[ -]?){9,15}(\d{4})\b/g, (m, last4) => (m.replace(/\D/g, '').length >= 13 ? `****${last4}` : m)],
  // NIK (16 digits) is covered above; Indonesian phone numbers: keep the last 3 digits.
  [/(?<![\d.])(?:\+?62|0)8\d{6,11}(?![\d.])/g, (m) => `${m.slice(0, 4)}****${m.slice(-3)}`],
  // Emails: keep the domain.
  [/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '***@$1'],
];

export function redactLog(text: string): string {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep as never);
  return out;
}

const SIGNAL = /\b(error|exception|panic|fatal|fail(?:ed|ure)?|timeout|timed out|refused|traceback|stack|caused by|nil pointer|undefined|cannot|unable|denied|rejected|invalid|5\d\d)\b/i;

/** The lines most likely to matter: errors and their neighbours, capped. */
export function logExcerpt(text: string, maxLines = 120, context = 2): string {
  const lines = text.split(/\r?\n/);
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (!SIGNAL.test(l)) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
  });
  const idx = [...keep].sort((a, b) => a - b);
  if (!idx.length) return lines.slice(-Math.min(maxLines, 40)).join('\n');
  const out: string[] = [];
  let prev = -2;
  for (const i of idx) {
    if (out.length >= maxLines) break;
    if (i !== prev + 1) out.push(`… (baris ${i + 1})`);
    out.push(lines[i].slice(0, 500));
    prev = i;
  }
  return out.join('\n');
}
