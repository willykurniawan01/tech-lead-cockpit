import { escapeXml } from './shared';

/**
 * Confluence tables whose cells hold lists, code, headings or nested tables (tadgen's Detail Task
 * layout) can't be Markdown pipe tables, so the TAD Markdown carries them as raw HTML. That HTML
 * has one canonical form, shared by import, preview, the rich editor and publish:
 *
 * - everything on ONE line: a newline inside text is written `&#10;`. A blank line would end the
 *   Markdown HTML block and spill the rest of the table out as text;
 * - plain HTML only, so the preview can show it. Confluence macros become marked elements:
 *     code     → <pre data-tlc-code="lang" data-tlc-params="wrap=true"><code>…</code></pre>
 *     status   → <span data-tlc-status="Colour">TITLE</span>
 *     jira     → <span data-tlc-jira="KEY">KEY</span>
 *     mention  → <span data-tlc-user="accountId">@Name</span>
 *   and publish turns them back into the macros.
 */

/** Escapes text for the canonical form; newlines become `&#10;` so the block stays on one line. */
export function encodeText(text: string): string {
  return escapeXml(text.replace(/ /g, ' ')).replace(/\r?\n/g, '&#10;');
}

/** Code macro parameters besides the language (wrap, title, linenumbers…), kept so publish matches Confluence. */
export type CodeParams = Record<string, string>;

function encodeParams(params: CodeParams): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function decodeParams(s: string): CodeParams {
  const out: CodeParams = {};
  for (const pair of s.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

export function codeHtml(text: string, lang = '', params: CodeParams = {}): string {
  const rest = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'language'));
  const paramAttr = Object.keys(rest).length ? ` data-tlc-params="${escapeXml(encodeParams(rest))}"` : '';
  return `<pre data-tlc-code="${escapeXml(lang)}"${paramAttr}><code>${encodeText(text.replace(/\n$/, ''))}</code></pre>`;
}

const LOZENGE = new Set(['grey', 'red', 'yellow', 'green', 'blue', 'purple']);

export function statusHtml(title: string, colour = 'Grey'): string {
  const c = colour.toLowerCase();
  return `<span class="lozenge lozenge-${LOZENGE.has(c) ? c : 'grey'}" data-tlc-status="${escapeXml(colour)}">${encodeText(title.toUpperCase())}</span>`;
}

export function jiraHtml(key: string): string {
  return `<span data-tlc-jira="${escapeXml(key)}">${encodeText(key)}</span>`;
}

export function mentionHtml(accountId: string, name?: string): string {
  return `<span data-tlc-user="${escapeXml(accountId)}">@${encodeText(name || accountId)}</span>`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function cdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function acParam(name: string, value: string): string {
  return `<ac:parameter ac:name="${name}">${escapeXml(value)}</ac:parameter>`;
}

/** Canonical embedded HTML → Confluence storage XHTML (publish). */
export function embeddedHtmlToStorage(html: string): string {
  return html
    .replace(/<pre data-tlc-code="([^"]*)"(?: data-tlc-params="([^"]*)")?><code>([\s\S]*?)<\/code><\/pre>/g, (_, lang: string, rawParams: string | undefined, body: string) => {
      const language = decodeEntities(lang);
      // Imported code keeps its own parameters; code written in Cockpit gets the wide layout.
      const extra = rawParams ? decodeParams(decodeEntities(rawParams)) : { breakoutMode: 'wide' };
      const params = (language ? acParam('language', language) : '') + Object.entries(extra).map(([k, v]) => acParam(k, v)).join('');
      return `<ac:structured-macro ac:name="code" ac:schema-version="1">${params}<ac:plain-text-body>${cdata(decodeEntities(body))}</ac:plain-text-body></ac:structured-macro>`;
    })
    .replace(/<span(?: class="[^"]*")? data-tlc-status="([^"]*)">([\s\S]*?)<\/span>/g, (_, colour: string, title: string) =>
      `<ac:structured-macro ac:name="status" ac:schema-version="1">${acParam('colour', decodeEntities(colour))}${acParam('title', decodeEntities(title))}</ac:structured-macro>`,
    )
    .replace(/<span data-tlc-jira="([^"]*)">[\s\S]*?<\/span>/g, (_, key: string) =>
      `<ac:structured-macro ac:name="jira" ac:schema-version="1">${acParam('key', decodeEntities(key))}</ac:structured-macro>`,
    )
    .replace(/<span data-tlc-user="([^"]*)">[\s\S]*?<\/span>/g, (_, id: string) => `<ac:link><ri:user ri:account-id="${id}" /></ac:link>`);
}

/** Range of a raw `<table …>` block starting at `start`, matching nested tables. */
function tableEnd(md: string, start: number): number {
  const re = /<table\b|<\/table>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    depth += m[0] === '</table>' ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** Confluence macros (code with CDATA, status, jira, mentions) → canonical elements. */
function macrosToCanonical(block: string): string {
  return block
    .replace(
      /<ac:structured-macro ac:name="(?:code|noformat)"[^>]*>([\s\S]*?)<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body><\/ac:structured-macro>/g,
      (_, params: string, body: string) => {
        const all: CodeParams = {};
        for (const m of params.matchAll(/<ac:parameter ac:name="([^"]+)">([^<]*)<\/ac:parameter>/g)) all[m[1]] = decodeEntities(m[2]);
        return codeHtml(body, all.language ?? '', all);
      },
    )
    .replace(
      /<ac:structured-macro ac:name="status"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
      (_, params: string) =>
        statusHtml(
          decodeEntities(params.match(/ac:name="title">([^<]*)</)?.[1] ?? ''),
          decodeEntities(params.match(/ac:name="colour">([^<]*)</)?.[1] ?? 'Grey'),
        ),
    )
    .replace(/<ac:structured-macro ac:name="jira"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (_, params: string) =>
      jiraHtml(decodeEntities(params.match(/ac:name="key">([^<]*)</)?.[1] ?? '')),
    )
    .replace(/<ac:link\b[\s\S]*?<ri:user\b([^>]*?)\/?>[\s\S]*?<\/ac:link>/g, (fullLink, userAttrs) => {
      const idMatch = userAttrs.match(/ri:(?:account-id|userkey|username)="([^"]+)"/);
      if (!idMatch) return fullLink;
      const id = idMatch[1];
      const nameMatch = userAttrs.match(/data-display-name="([^"]+)"/);
      const bodyMatch = fullLink.match(/<ac:(?:plain-text-link-body|link-body)>([\s\S]*?)<\/ac:(?:plain-text-link-body|link-body)>/);
      let name = nameMatch ? decodeEntities(nameMatch[1]) : undefined;
      if (!name && bodyMatch) {
        name = bodyMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/^@/, '').trim();
      }
      return mentionHtml(id, name);
    });
}

/** Older imports kept Confluence macros (with CDATA) and real newlines inside the table HTML. */
function canonicalizeLegacy(block: string): string {
  return macrosToCanonical(block).replace(/\r?\n/g, '&#10;');
}

/**
 * Brings every raw `<table>` block in TAD Markdown to the canonical single-line form, so drafts
 * imported before this format existed render and publish correctly without re-importing.
 */
export function normalizeEmbeddedHtml(md: string): string {
  if (!md.includes('<table')) return md;
  let out = '';
  let pos = 0;
  const startRe = /(^|\n)(<!-- safe-xhtml -->)?<table\b/g;
  for (let m = startRe.exec(md); m; m = startRe.exec(md)) {
    const start = m.index + m[1].length + (m[2]?.length ?? 0);
    if (start < pos) continue;
    const end = tableEnd(md, start);
    if (end < 0) break;
    out += md.slice(pos, start) + canonicalizeLegacy(md.slice(start, end));
    pos = end;
    startRe.lastIndex = end;
  }
  return out + md.slice(pos);
}

// ---- AI workspace form -------------------------------------------------------------------------
// One 15 000-character line is hard for an AI to edit and easy to break. The generator workspace
// gets the same HTML spread over lines (one block tag per line, real newlines inside code), and
// the result is collapsed back to the canonical form before it reaches the draft.

const BLOCK_OPEN = /(?<=>)(?=<(?:table|thead|tbody|tfoot|colgroup|tr|th|td|p|ul|ol|li|h[1-6]|pre|blockquote|div)\b)/g;
const BLOCK_CLOSE = /(?<=>)(?=<\/(?:table|thead|tbody|tfoot|tr|ul|ol)>)/g;
const PRE = /<pre\b[\s\S]*?<\/pre>/g;

function mapOutsidePre(block: string, outside: (s: string) => string, inside: (s: string) => string): string {
  let out = '';
  let pos = 0;
  for (const m of block.matchAll(PRE)) {
    out += outside(block.slice(pos, m.index)) + inside(m[0]);
    pos = m.index + m[0].length;
  }
  return out + outside(block.slice(pos));
}

function mapTableBlocks(md: string, fn: (block: string) => string): string {
  let out = '';
  let pos = 0;
  const startRe = /(^|\n)(<!-- safe-xhtml -->)?<table\b/g;
  for (let m = startRe.exec(md); m; m = startRe.exec(md)) {
    const start = m.index + m[1].length + (m[2]?.length ?? 0);
    if (start < pos) continue;
    const end = tableEnd(md, start);
    if (end < 0) break;
    out += md.slice(pos, start) + fn(md.slice(start, end));
    pos = end;
    startRe.lastIndex = end;
  }
  return out + md.slice(pos);
}

/** Canonical single-line tables → one block tag per line, real newlines inside code (for the AI). */
export function expandEmbeddedHtml(md: string): string {
  if (!md.includes('<table')) return md;
  return mapTableBlocks(normalizeEmbeddedHtml(md), (block) =>
    mapOutsidePre(
      block,
      (s) => s.replace(BLOCK_OPEN, '\n').replace(BLOCK_CLOSE, '\n'),
      (pre) => pre.replace(/&#10;/g, '\n'),
    ),
  );
}

/**
 * Tables edited by the AI (any line layout, maybe even Confluence macros) → canonical form.
 * Line breaks between tags are layout and disappear; inside code they are content and are kept.
 */
export function collapseEmbeddedHtml(md: string): string {
  if (!md.includes('<table')) return md;
  const collapsed = mapTableBlocks(md, (block) =>
    mapOutsidePre(
      macrosToCanonical(block),
      (s) => s.replace(/(?<=>)[ \t]*\r?\n\s*/g, '').replace(/\s*\r?\n\s*(?=<)/g, '').replace(/\s*\r?\n\s*/g, ' '),
      (pre) => pre.replace(/\r?\n/g, '&#10;'),
    ),
  );
  return normalizeEmbeddedHtml(collapsed);
}
