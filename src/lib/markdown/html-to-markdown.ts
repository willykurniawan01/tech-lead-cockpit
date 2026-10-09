/**
 * Converts rich text HTML (from ContentEditable Word-style editor) back to TAD Markdown.
 * Preserves tables, callouts, lists, code blocks, mermaid diagrams, and inline formatting.
 */

import { codeHtml, encodeText, jiraHtml, mentionHtml, statusHtml } from './embedded-html';
import { escapeXml } from './shared';

const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

function decodeHtmlEntities(str: string): string {
  if (typeof document === 'undefined') {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
  const txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}

const name = (el: Element) => el.localName.toLowerCase();
const kids = (el: Element) => Array.from(el.children);

const CALLOUT_MACRO_MAP: Record<string, string> = {
  info: 'INFO',
  tip: 'TIP',
  note: 'IMPORTANT',
  warning: 'CAUTION',
  caution: 'CAUTION',
  panel: 'NOTE',
};

// ---- inline formatting ----

function inline(node: Node, inTable = false): string {
  if (node.nodeType === Node.COMMENT_NODE) {
    const text = (node.textContent ?? '').trim();
    if (text === 'toc') return '<!-- toc -->';
    return `<!-- ${text} -->`;
  }

  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    const raw = (node.textContent ?? '').replace(/\u00a0/g, ' ');
    return raw.replace(/[\r\n\t]+/g, ' ');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const tag = name(el);

  // Skip callout titles or code-lang headers inside blocks if encountered inline
  if (el.classList.contains('code-lang') || el.classList.contains('callout-title')) {
    return '';
  }

  const inner = () => Array.from(el.childNodes).map((c) => inline(c, inTable)).join('');
  const wrap = (mark: string) => {
    const text = inner();
    const trimmed = text.trim();
    if (!trimmed) return text;
    // Keep outer spaces outside the mark
    const leading = text.match(/^\s*/)?.[0] ?? '';
    const trailing = text.match(/\s*$/)?.[0] ?? '';
    return `${leading}${mark}${trimmed}${mark}${trailing}`;
  };

  switch (tag) {
    case 'strong':
    case 'b':
      return wrap('**');
    case 'em':
    case 'i':
      return wrap('_');
    case 's':
    case 'del':
    case 'strike':
      return wrap('~~');
    case 'u':
      return wrap('<u>'); // or inner()
    case 'code':
      return `\`${(el.textContent ?? '').replace(/\u00a0/g, ' ')}\``;
    case 'br':
      return inTable ? '<br>' : '  \n';
    case 'a': {
      const text = inner().trim();
      const href = el.getAttribute('href') ?? '';
      return href ? `[${text || href}](${href})` : text;
    }
    case 'span': {
      if (el.classList.contains('lozenge')) {
        return (el.textContent ?? '').trim();
      }
      return inner();
    }
    default:
      return inner();
  }
}

function inlineChildren(el: Element, inTable = false): string {
  return Array.from(el.childNodes)
    .map((c) => inline(c, inTable))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// ---- list formatting ----

function formatList(el: Element, depth = 0): string[] {
  const ordered = name(el) === 'ol';
  const lines: string[] = [];
  kids(el).forEach((li, i) => {
    if (name(li) !== 'li') return;
    const marker = ordered ? `${i + 1}.` : '-';
    const pad = '  '.repeat(depth);
    const pLines: string[] = [];
    const nested: string[] = [];
    let inlineBuf = '';

    const flushInline = () => {
      const t = inlineBuf.trim();
      if (t) pLines.push(t);
      inlineBuf = '';
    };

    for (const c of Array.from(li.childNodes)) {
      if (c.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(name(c as Element))) {
        flushInline();
        nested.push(...formatList(c as Element, depth + 1));
      } else if (c.nodeType === Node.ELEMENT_NODE && name(c as Element) === 'p') {
        flushInline();
        const pText = inlineChildren(c as Element);
        if (pText) pLines.push(pText);
      } else {
        inlineBuf += inline(c);
      }
    }
    flushInline();

    const mainText = pLines.join(' ');
    lines.push(`${pad}${marker} ${mainText}`.trimEnd());
    lines.push(...nested);
  });
  return lines;
}

// ---- table formatting ----

function cellContent(cell: Element): string {
  const parts: string[] = [];
  let inlineBuf = '';

  const flushInline = () => {
    const trimmed = inlineBuf.trim();
    if (trimmed) parts.push(trimmed);
    inlineBuf = '';
  };

  for (const c of Array.from(cell.childNodes)) {
    if (c.nodeType !== Node.ELEMENT_NODE) {
      inlineBuf += inline(c, true);
      continue;
    }
    const e = c as Element;
    const tag = name(e);

    if (['ul', 'ol'].includes(tag)) {
      flushInline();
      parts.push(...formatList(e, 0).map((l) => l.trim()).filter(Boolean));
    } else if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
      flushInline();
      const t = inlineChildren(e, true);
      if (t) parts.push(t);
    } else if (tag === 'pre') {
      flushInline();
      const codeText = (e.textContent ?? '').trim().replace(/\n/g, ' ');
      parts.push(`\`${codeText}\``);
    } else {
      inlineBuf += inline(e, true);
    }
  }

  flushInline();
  return parts.join('<br>').replace(/\|/g, '\\|');
}

function tableRows(tableEl: Element): Element[] {
  const out: Element[] = [];
  for (const c of kids(tableEl)) {
    if (name(c) === 'tr') out.push(c);
    if (['tbody', 'thead', 'tfoot'].includes(name(c))) {
      out.push(...kids(c).filter((r) => name(r) === 'tr'));
    }
  }
  return out;
}

const tableCells = (tr: Element) => kids(tr).filter((c) => ['td', 'th'].includes(name(c)));

const isAc = (el: Element, local: string) => el.prefix === 'ac' && el.localName === local;
const param = (macro: Element, key: string): string =>
  kids(macro).find((c) => isAc(c, 'parameter') && c.getAttribute('ac:name') === key)?.textContent?.trim() ?? '';
const plainBody = (macro: Element): string =>
  kids(macro).find((c) => isAc(c, 'plain-text-body'))?.textContent ?? '';
const richBody = (macro: Element): Element | undefined =>
  kids(macro).find((c) => isAc(c, 'rich-text-body'));

/** Editor DOM inside a raw table → canonical embedded HTML (see embedded-html.ts). */
function serializeHtmlNode(node: Node): string {
  if (node.nodeType === Node.COMMENT_NODE) {
    const text = (node.textContent ?? '').trim().replace(/\s*\n\s*/g, ' ');
    return `<!-- ${text} -->`;
  }
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    return encodeText(node.textContent ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = name(el);

  if (el.classList.contains('code-block') || tag === 'pre') {
    const pre = tag === 'pre' ? el : (el.querySelector('pre') ?? el);
    const lang = pre.getAttribute('data-tlc-code') ?? el.querySelector('.code-lang')?.textContent?.trim() ?? '';
    const params = Object.fromEntries(new URLSearchParams(pre.getAttribute('data-tlc-params') ?? ''));
    return codeHtml(pre.querySelector('code')?.textContent ?? pre.textContent ?? '', lang, params);
  }

  if (el.hasAttribute('data-tlc-status')) {
    return statusHtml(el.textContent?.trim() ?? '', el.getAttribute('data-tlc-status') || 'Grey');
  }
  if (el.hasAttribute('data-tlc-jira')) return jiraHtml(el.getAttribute('data-tlc-jira') ?? '');
  if (el.hasAttribute('data-tlc-user')) {
    return mentionHtml(el.getAttribute('data-tlc-user') ?? '', el.textContent?.replace(/^@/, '').trim());
  }

  if (el.classList.contains('lozenge')) {
    const title = el.textContent?.trim() || '';
    return `<span class="lozenge">${escapeXml(title)}</span>`;
  }

  if (el.prefix === 'ac') {
    if (isAc(el, 'structured-macro')) {
      const macro = el.getAttribute('ac:name') ?? '';
      if (macro === 'code' || macro === 'noformat') {
        const lang = param(el, 'language');
        const langParam = lang ? `<ac:parameter ac:name="language">${escapeXml(lang)}</ac:parameter>` : '';
        const breakoutParam = '<ac:parameter ac:name="breakoutMode">wide</ac:parameter>';
        return `<ac:structured-macro ac:name="code" ac:schema-version="1">${langParam}${breakoutParam}<ac:plain-text-body><![CDATA[${plainBody(el)}]]></ac:plain-text-body></ac:structured-macro>`;
      }
      if (macro === 'status') {
        const title = param(el, 'title');
        const colour = param(el, 'colour') || 'grey';
        return `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">${escapeXml(colour)}</ac:parameter><ac:parameter ac:name="title">${escapeXml(title)}</ac:parameter></ac:structured-macro>`;
      }
      if (macro === 'jira') {
        const key = param(el, 'key');
        return `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">${escapeXml(key)}</ac:parameter></ac:structured-macro>`;
      }
      const body = richBody(el);
      return body ? Array.from(body.childNodes).map(serializeHtmlNode).join('') : escapeXml(plainBody(el));
    }
    if (isAc(el, 'link')) {
      const user = kids(el).find((c) => c.prefix === 'ri' && c.localName === 'user');
      if (user) {
        const accountId = user.getAttribute('ri:account-id') || user.getAttribute('ri:userkey');
        return accountId ? `<ac:link><ri:user ri:account-id="${escapeXml(accountId)}" /></ac:link>` : '@user';
      }
      const label = kids(el).find((c) => isAc(c, 'plain-text-link-body') || isAc(c, 'link-body'))?.textContent?.trim();
      return label ? escapeXml(label) : '';
    }
    return Array.from(el.childNodes).map(serializeHtmlNode).join('');
  }

  const inner = Array.from(el.childNodes).map(serializeHtmlNode).join('');
  const attrs: string[] = [];
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-') || attr.name === 'style' || attr.name === 'colspan' || attr.name === 'rowspan') {
      attrs.push(`${attr.name}="${escapeXml(attr.value)}"`);
    } else if (attr.name === 'class' && !attr.value.includes('detail-task-table')) {
      attrs.push(`${attr.name}="${escapeXml(attr.value)}"`);
    }
  }
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  if (['col', 'br', 'hr', 'img'].includes(tag) && !inner) {
    return `<${tag}${attrStr} />`;
  }
  return `<${tag}${attrStr}>${inner}</${tag}>`;
}

function formatTable(el: Element): string[] {
  const trs = tableRows(el);
  if (!trs.length) return [];

  // Check if it's a 2-column key-value task table or detail task table:
  // e.g. Row 1 has <th><h3>Description</h3></th><td>content</td>
  const isKv =
    trs.length > 0 &&
    trs.every((tr) => {
      const cs = tableCells(tr);
      return cs.length === 2 && name(cs[0]) === 'th' && (kids(cs[0]).some((k) => /^h[1-6]$/.test(name(k))) || Boolean(cs[0].textContent?.trim()));
    });

  // 2-column key-value task table or detail task table:
  // e.g. Row 1 has <th><h3>Description</h3></th><td>content</td>
  if (isKv) {
    const out: string[] = [];
    for (const tr of trs) {
      const [label, content] = tableCells(tr);
      const labelText = label.textContent?.trim() ?? '';
      out.push(`#### ${labelText}`, '', ...formatBlocks(content), '');
    }
    return out;
  }

  const hasNestedTable = el.querySelector('table') !== null;
  if (hasNestedTable) {
    return [serializeHtmlNode(el), ''];
  }

  const grid = trs.map((tr) => tableCells(tr));
  const colCount = Math.max(1, ...grid.map((r) => r.length));

  const formatLine = (row: Element[]) => {
    const texts: string[] = [];
    for (const cell of row) {
      texts.push(cellContent(cell) || ' ');
    }
    while (texts.length < colCount) {
      texts.push(' ');
    }
    return `| ${texts.join(' | ')} |`;
  };

  const headerRow = formatLine(grid[0]);
  const separator = `|${Array(colCount).fill('---').join('|')}|`;
  const bodyRows = grid.slice(1).map(formatLine);

  return [headerRow, separator, ...bodyRows];
}

// ---- callout & special block formatting ----

function formatCallout(el: Element): string[] {
  let kind = 'INFO';
  for (const cls of Array.from(el.classList)) {
    if (cls.startsWith('callout-')) {
      const k = cls.replace('callout-', '');
      kind = CALLOUT_MACRO_MAP[k] || k.toUpperCase();
      break;
    }
  }

  // Find inner content, omitting .callout-title
  const bodyNodes: Element[] = [];
  for (const c of kids(el)) {
    if (!c.classList.contains('callout-title')) {
      bodyNodes.push(c);
    }
  }

  const innerLines = bodyNodes.flatMap((b) => formatBlocks(b));
  // If no block children, take inline content
  if (!innerLines.length) {
    const text = inlineChildren(el);
    if (text) innerLines.push(text);
  }

  while (innerLines.length && !innerLines[innerLines.length - 1].trim()) {
    innerLines.pop();
  }

  return [`> [!${kind}]`, ...innerLines.map((l) => (l ? `> ${l}` : '>'))];
}

function formatCodeBlock(el: Element): string[] {
  const lang = el.querySelector('.code-lang')?.textContent?.trim() || '';
  const pre = el.querySelector('pre') || el;
  const code = (pre.querySelector('code')?.textContent ?? pre.textContent ?? '').replace(/\n$/, '');
  return [`\`\`\`${lang}`, code, '```'];
}

function formatMermaidBlock(el: Element): string[] {
  const pre = el.querySelector('pre');
  const code = (pre?.textContent ?? el.textContent ?? '').trim();
  return ['```mermaid', code, '```'];
}

// ---- block parser ----

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'pre', 'blockquote', 'hr', 'div', 'section', 'article']);

export function formatBlocks(container: Element): string[] {
  const out: string[] = [];
  let inlineBuf = '';

  const flush = () => {
    if (inlineBuf.trim()) {
      out.push(inlineBuf.trim(), '');
    }
    inlineBuf = '';
  };

  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE) {
      flush();
      const txt = (node.textContent ?? '').trim();
      if (txt === 'toc') out.push('<!-- toc -->', '');
      else out.push(`<!-- ${txt} -->`, '');
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      inlineBuf += inline(node);
      continue;
    }

    const el = node as Element;
    const tag = name(el);

    if (!BLOCK_TAGS.has(tag)) {
      inlineBuf += inline(el);
      continue;
    }

    flush();

    if (el.classList.contains('toc-placeholder')) {
      out.push('<!-- toc -->', '');
      continue;
    }

    if (/^h[1-6]$/.test(tag)) {
      const depth = Number(tag[1]);
      const headingText = inlineChildren(el).replace(/^\*\*(.*)\*\*$/, '$1').trim();
      out.push(`${'#'.repeat(depth)} ${headingText}`, '');
    } else if (tag === 'p') {
      const text = inlineChildren(el);
      if (text) out.push(text, '');
    } else if (tag === 'ul' || tag === 'ol') {
      out.push(...formatList(el, 0), '');
    } else if (tag === 'table') {
      out.push(...formatTable(el), '');
    } else if (el.classList.contains('mermaid-block') || el.getAttribute('data-mermaid') !== null) {
      out.push(...formatMermaidBlock(el), '');
    } else if (el.classList.contains('code-block') || tag === 'pre') {
      out.push(...formatCodeBlock(el), '');
    } else if (el.classList.contains('callout')) {
      out.push(...formatCallout(el), '');
    } else if (tag === 'blockquote') {
      const inner = formatBlocks(el);
      out.push(...inner.map((l) => (l ? `> ${l}` : '>')), '');
    } else if (tag === 'hr') {
      out.push('---', '');
    } else if (tag === 'div' || tag === 'section' || tag === 'article') {
      out.push(...formatBlocks(el));
    } else {
      const text = inlineChildren(el);
      if (text) out.push(text, '');
    }
  }

  flush();
  return out;
}

/**
 * Main export: parses an HTML string or element and returns formatted Markdown.
 */
export function htmlToMarkdown(htmlOrElement: string | Element): string {
  let root: Element;
  if (typeof htmlOrElement === 'string') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${htmlOrElement}</div>`, 'text/html');
    root = doc.body.firstElementChild || doc.body;
  } else {
    root = htmlOrElement;
  }

  const lines = formatBlocks(root);
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

/**
 * Scans markdown text for top-level balanced <table...>...</table> elements,
 * keeping any nested inner tables intact within the top-level block,
 * and calls `replacer` on each top-level table HTML string.
 */
export function replaceBalancedHtmlTables(
  markdown: string,
  replacer: (tableHtml: string) => string,
): string {
  let result = '';
  let pos = 0;
  while (pos < markdown.length) {
    const tableStart = markdown.toLowerCase().indexOf('<table', pos);
    if (tableStart === -1) {
      result += markdown.slice(pos);
      break;
    }
    result += markdown.slice(pos, tableStart);

    let depth = 0;
    let curr = tableStart;
    let tableEnd = -1;

    while (curr < markdown.length) {
      const nextOpen = markdown.toLowerCase().indexOf('<table', curr);
      const nextClose = markdown.toLowerCase().indexOf('</table', curr);
      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        curr = nextOpen + 6;
      } else {
        depth--;
        curr = nextClose + 8;
        if (depth === 0) {
          tableEnd = curr;
          break;
        }
      }
    }

    if (tableEnd !== -1) {
      const fullTableHtml = markdown.slice(tableStart, tableEnd);
      let replacement = fullTableHtml;
      try {
        replacement = replacer(fullTableHtml);
      } catch {
        replacement = fullTableHtml;
      }
      result += replacement;
      pos = tableEnd;
    } else {
      result += markdown.slice(tableStart, tableStart + 6);
      pos = tableStart + 6;
    }
  }
  return result;
}
