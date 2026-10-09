/**
 * Confluence storage format (XHTML + ac:/ri: macros) → TAD Markdown, the reverse of storage.ts.
 * tadgen-style task tables (a label column of <th><h3>Description</h3></th>) become
 * `#### Description` sections again, so imported TADs validate and edit like generated ones.
 */

import { codeHtml, encodeText, jiraHtml, mentionHtml, statusHtml } from '../markdown/embedded-html';
import { escapeXml } from '../markdown/shared';

const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/** Named HTML entities (&nbsp;, &rsquo;…) are not valid XML; turn them into numeric references. */
function numericEntities(xhtml: string): string {
  return xhtml.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name: string) => {
    if (XML_ENTITIES.has(name)) return m;
    const el = document.createElement('textarea');
    el.innerHTML = m;
    const ch = el.value;
    return ch === m ? '' : `&#${ch.codePointAt(0)};`;
  });
}

/** Atlassian-only emoji have no Unicode form; their fallback is a `:shortcode:`. */
const ATLASSIAN_EMOJI: Record<string, string> = {
  ':blue_star:': '⭐',
  ':check_mark:': '✅',
  ':tick:': '✅',
  ':cross_mark:': '❌',
  ':warning:': '⚠️',
  ':info:': 'ℹ️',
  ':light_bulb:': '💡',
  ':question_mark:': '❓',
  ':thumbs_up:': '👍',
  ':thumbs_down:': '👎',
};

/** Unicode emoji when there is one; a bare `:shortcode:` is dropped rather than shown as text. */
function emoticon(el: Element): string {
  const fallback = (el.getAttribute('ac:emoji-fallback') ?? '').trim();
  if (!/^:[\w+-]+:$/.test(fallback)) return fallback;
  return ATLASSIAN_EMOJI[fallback] ?? ATLASSIAN_EMOJI[el.getAttribute('ac:emoji-shortname') ?? ''] ?? '';
}

export function parseStorage(xhtml: string): Element {
  const doc = new DOMParser().parseFromString(
    `<root xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource/identifier">${numericEntities(xhtml)}</root>`,
    'application/xml',
  );
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`Format storage Confluence tidak bisa dibaca: ${err.textContent?.split('\n')[0] ?? ''}`);
  return doc.documentElement;
}

const name = (el: Element) => el.localName.toLowerCase();
const isAc = (el: Element, local: string) => el.prefix === 'ac' && el.localName === local;
const kids = (el: Element) => Array.from(el.children);

function param(macro: Element, key: string): string {
  return kids(macro).find((c) => isAc(c, 'parameter') && c.getAttribute('ac:name') === key)?.textContent?.trim() ?? '';
}

function plainBody(macro: Element): string {
  return kids(macro).find((c) => isAc(c, 'plain-text-body'))?.textContent ?? '';
}

function richBody(macro: Element): Element | undefined {
  return kids(macro).find((c) => isAc(c, 'rich-text-body'));
}

const CALLOUT: Record<string, string> = { info: 'INFO', note: 'IMPORTANT', warning: 'CAUTION', tip: 'TIP', panel: 'NOTE' };

// ---- inline ---------------------------------------------------------------------------------

function inline(node: Node, inTable = false): string {
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    return (node.textContent ?? '').replace(/\s+/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const inner = () => Array.from(el.childNodes).map((c) => inline(c, inTable)).join('');
  const wrap = (mark: string) => {
    const text = inner();
    const trimmed = text.trim();
    if (!trimmed) return text;
    return text.replace(trimmed, `${mark}${trimmed}${mark}`);
  };

  if (el.prefix === 'ri' && el.localName === 'user') {
    const accountId = el.getAttribute('ri:account-id') || el.getAttribute('ri:userkey') || el.getAttribute('ri:username') || '';
    const display = el.getAttribute('data-display-name') ?? undefined;
    return accountId ? mentionHtml(accountId, display) : `@${display ?? 'user'}`;
  }

  if (el.prefix === 'ac') {
    if (isAc(el, 'structured-macro')) {
      const macro = el.getAttribute('ac:name') ?? '';
      if (macro === 'jira') return param(el, 'key');
      if (macro === 'status') return param(el, 'title');
      if (macro === 'anchor') return '';
      const body = richBody(el);
      return body ? inline(body, inTable) : plainBody(el).trim();
    }
    if (isAc(el, 'link')) {
      const user = kids(el).find((c) => c.prefix === 'ri' && c.localName === 'user');
      if (user) {
        // Keep the account id (as Cockpit's mention span) so publishing turns it back into a mention.
        const accountId = user.getAttribute('ri:account-id') || user.getAttribute('ri:userkey') || user.getAttribute('ri:username') || '';
        const linkBody = kids(el).find((c) => isAc(c, 'plain-text-link-body') || isAc(c, 'link-body'))?.textContent?.trim();
        const cleanedBody = linkBody ? linkBody.replace(/^@/, '').trim() : undefined;
        const display = user.getAttribute('data-display-name') || cleanedBody || undefined;
        return accountId ? mentionHtml(accountId, display) : `@${display ?? 'user'}`;
      }
      const page = kids(el).find((c) => c.prefix === 'ri' && c.localName === 'page');
      const label = kids(el).find((c) => isAc(c, 'plain-text-link-body') || isAc(c, 'link-body'))?.textContent?.trim();
      return label || page?.getAttribute('ri:content-title') || '';
    }
    if (isAc(el, 'image')) {
      const att = kids(el).find((c) => c.prefix === 'ri' && c.localName === 'attachment');
      const url = kids(el).find((c) => c.prefix === 'ri' && c.localName === 'url');
      return url ? `![](${url.getAttribute('ri:value')})` : `![${att?.getAttribute('ri:filename') ?? 'gambar'}](attachment:${att?.getAttribute('ri:filename') ?? ''})`;
    }
    if (isAc(el, 'emoticon')) return emoticon(el);
    return inner();
  }

  switch (name(el)) {
    case 'strong':
    case 'b':
      return wrap('**');
    case 'em':
    case 'i':
      return wrap('_');
    case 's':
    case 'del':
      return wrap('~~');
    case 'code':
      return `\`${el.textContent ?? ''}\``;
    case 'br':
      return inTable ? '<br>' : '  \n';
    case 'a': {
      if (el.classList.contains('confluence-user-mention') || el.classList.contains('user-mention') || el.hasAttribute('data-account-id') || el.hasAttribute('data-tlc-user')) {
        const id = el.getAttribute('data-tlc-user') || el.getAttribute('data-account-id') || el.getAttribute('data-username') || '';
        const nameText = el.textContent?.replace(/^@/, '').trim() || undefined;
        if (id) return mentionHtml(id, nameText);
      }
      const text = inner().trim();
      const href = el.getAttribute('href') ?? '';
      return href ? `[${text || href}](${href})` : text;
    }
    case 'span':
      if (el.hasAttribute('data-tlc-user') || el.hasAttribute('data-account-id') || el.classList.contains('confluence-user-mention') || el.classList.contains('user-mention')) {
        const id = el.getAttribute('data-tlc-user') || el.getAttribute('data-account-id') || el.getAttribute('data-username') || '';
        return mentionHtml(id, el.textContent?.replace(/^@/, '').trim());
      }
      return inner();
    case 'u':
    case 'sub':
    case 'sup':
    case 'time':
      return name(el) === 'time' ? el.getAttribute('datetime') ?? inner() : inner();
    default:
      return inner();
  }
}

function inlineChildren(el: Element, inTable = false): string {
  return Array.from(el.childNodes).map((c) => inline(c, inTable)).join('').replace(/[ \t]+\n/g, '\n').trim();
}

// ---- blocks ---------------------------------------------------------------------------------

const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'pre', 'blockquote', 'hr', 'div', 'section']);

function list(el: Element, depth: number): string[] {
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
        nested.push(...list(c as Element, depth + 1));
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

/** Cell content on one Markdown table line: blocks joined with <br>, lists flattened. */
function cellText(cell: Element): string {
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
      parts.push(...list(e, 0).map((l) => l.trim()).filter(Boolean));
    } else if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'].includes(tag)) {
      flushInline();
      const t = inlineChildren(e, true);
      if (t) parts.push(t);
    } else if (isAc(e, 'structured-macro') && e.getAttribute('ac:name') === 'code') {
      inlineBuf += `\`${plainBody(e).trim().replace(/\n/g, ' ')}\``;
    } else {
      inlineBuf += inline(e, true);
    }
  }

  flushInline();
  return parts.join('<br>').replace(/\|/g, '\\|');
}

function rows(table: Element): Element[] {
  const out: Element[] = [];
  for (const c of kids(table)) {
    if (name(c) === 'tr') out.push(c);
    if (['tbody', 'thead', 'tfoot'].includes(name(c))) out.push(...kids(c).filter((r) => name(r) === 'tr'));
  }
  return out;
}

const cells = (tr: Element) => kids(tr).filter((c) => ['td', 'th'].includes(name(c)));

/** tadgen's task layout: every row is <th><h3>Label</h3></th><td>content</td>. */
function isKvTable(trs: Element[]): boolean {
  return (
    trs.length > 0 &&
    trs.every((tr) => {
      const cs = cells(tr);
      return cs.length === 2 && name(cs[0]) === 'th' && (kids(cs[0]).some((k) => /^h[1-6]$/.test(name(k))) || Boolean(cs[0].textContent?.trim()));
    })
  );
}

function macroParams(macro: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of kids(macro)) if (isAc(c, 'parameter')) out[c.getAttribute('ac:name') ?? ''] = c.textContent ?? '';
  return out;
}

/** Storage element → canonical embedded HTML (see lib/markdown/embedded-html.ts). */
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
    const text = node.textContent ?? '';
    // Line breaks between tags are only source formatting in storage.
    return /^\s*\n\s*$/.test(text) ? '' : encodeText(text);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = name(el);

  if (el.prefix === 'ri' && el.localName === 'user') {
    const accountId = el.getAttribute('ri:account-id') || el.getAttribute('ri:userkey') || el.getAttribute('ri:username') || '';
    const display = el.getAttribute('data-display-name') ?? undefined;
    return accountId ? mentionHtml(accountId, display) : `@${display ?? 'user'}`;
  }

  if (el.prefix === 'ac') {
    if (isAc(el, 'structured-macro')) {
      const macro = el.getAttribute('ac:name') ?? '';
      if (macro === 'code' || macro === 'noformat') return codeHtml(plainBody(el), param(el, 'language'), macroParams(el));
      if (macro === 'status') return statusHtml(param(el, 'title'), param(el, 'colour') || 'Grey');
      if (macro === 'jira') return jiraHtml(param(el, 'key'));
      if (macro === 'anchor') return '';
      const body = richBody(el);
      return body ? Array.from(body.childNodes).map(serializeNode).join('') : encodeText(plainBody(el));
    }
    if (isAc(el, 'link')) {
      const user = kids(el).find((c) => c.prefix === 'ri' && c.localName === 'user');
      if (user) {
        const accountId = user.getAttribute('ri:account-id') || user.getAttribute('ri:userkey') || user.getAttribute('ri:username') || '';
        const linkBody = kids(el).find((c) => isAc(c, 'plain-text-link-body') || isAc(c, 'link-body'))?.textContent?.trim();
        const cleanedBody = linkBody ? linkBody.replace(/^@/, '').trim() : undefined;
        const display = user.getAttribute('data-display-name') || cleanedBody || undefined;
        return accountId ? mentionHtml(accountId, display) : `@${display ?? 'user'}`;
      }
      const label = kids(el).find((c) => isAc(c, 'plain-text-link-body') || isAc(c, 'link-body'))?.textContent?.trim();
      return label ? encodeText(label) : '';
    }
    if (isAc(el, 'emoticon')) return encodeText(emoticon(el));
    return Array.from(el.childNodes).map(serializeNode).join('');
  }

  if (tag === 'span' && (el.hasAttribute('data-tlc-user') || el.hasAttribute('data-account-id') || el.classList.contains('confluence-user-mention') || el.classList.contains('user-mention'))) {
    const id = el.getAttribute('data-tlc-user') || el.getAttribute('data-account-id') || el.getAttribute('data-username') || '';
    return mentionHtml(id, el.textContent?.replace(/^@/, '').trim());
  }
  if (tag === 'a' && (el.classList.contains('confluence-user-mention') || el.classList.contains('user-mention') || el.hasAttribute('data-account-id') || el.hasAttribute('data-tlc-user'))) {
    const id = el.getAttribute('data-tlc-user') || el.getAttribute('data-account-id') || el.getAttribute('data-username') || '';
    const nameText = el.textContent?.replace(/^@/, '').trim() || undefined;
    if (id) return mentionHtml(id, nameText);
  }

  const inner = Array.from(el.childNodes).map(serializeNode).join('');
  const attrs: string[] = [];
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-') || attr.name === 'style' || attr.name === 'class' || attr.name === 'colspan' || attr.name === 'rowspan' || attr.name === 'href') {
      attrs.push(`${attr.name}="${escapeXml(attr.value)}"`);
    }
  }
  const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
  if (['col', 'br', 'hr', 'img'].includes(tag) && !inner) {
    return `<${tag}${attrStr} />`;
  }
  return `<${tag}${attrStr}>${inner}</${tag}>`;
}

function serializeKvTable(el: Element): string[] {
  return [serializeNode(el), ''];
}

function table(el: Element): string[] {
  const trs = rows(el);
  if (!trs.length) return [];
  if (isKvTable(trs)) {
    const out: string[] = [];
    for (const tr of trs) {
      const [label, content] = cells(tr);
      out.push(`#### ${label.textContent?.trim() ?? ''}`, '', ...blocks(content), '');
    }
    return out;
  }
  const grid = trs.map((tr) => cells(tr));
  const width = Math.max(...grid.map((r) => r.reduce((n, c) => n + Number(c.getAttribute('colspan') ?? 1), 0)));
  const line = (r: Element[]) => {
    const texts: string[] = [];
    for (const c of r) {
      texts.push(cellText(c) || ' ');
      for (let i = 1; i < Number(c.getAttribute('colspan') ?? 1); i++) texts.push(' ');
    }
    while (texts.length < width) texts.push(' ');
    return `| ${texts.join(' | ')} |`;
  };
  return [line(grid[0]), `|${Array(width).fill('---').join('|')}|`, ...grid.slice(1).map(line)];
}

function macroBlock(el: Element): string[] {
  const macro = el.getAttribute('ac:name') ?? '';
  if (macro === 'toc') return ['<!-- toc -->', ''];
  if (macro === 'anchor') return [];
  if (macro === 'code' || macro === 'noformat') {
    const lang = param(el, 'language');
    return ['```' + (lang === 'text' ? '' : lang), plainBody(el).replace(/\n$/, ''), '```'];
  }
  if (/mermaid/.test(macro)) return ['```mermaid', plainBody(el).trim() || richBody(el)?.textContent?.trim() || '', '```'];
  if (CALLOUT[macro]) {
    const body = richBody(el);
    const inner = body ? blocks(body) : [];
    while (inner.length && !inner[inner.length - 1].trim()) inner.pop();
    const title = param(el, 'title');
    return [`> [!${CALLOUT[macro]}]`, ...(title ? [`> **${title}**`] : []), ...inner.map((l) => (l ? `> ${l}` : '>'))];
  }
  if (macro === 'expand') {
    const title = param(el, 'title');
    const body = richBody(el);
    return [...(title ? [`**${title}**`, ''] : []), ...(body ? blocks(body) : [])];
  }
  const body = richBody(el);
  if (body) return blocks(body);
  const text = inline(el).trim();
  return text ? [text] : [];
}

/** Page layouts (sections and columns) only arrange content: their children are ordinary blocks. */
const LAYOUT = new Set(['layout', 'layout-section', 'layout-cell']);

function blocks(container: Element): string[] {
  const out: string[] = [];
  let inlineBuf = '';
  const flush = () => {
    if (inlineBuf.trim()) out.push(inlineBuf.trim(), '');
    inlineBuf = '';
  };
  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      inlineBuf += inline(node);
      continue;
    }
    const el = node as Element;
    const tag = name(el);
    if (el.prefix === 'ac' && LAYOUT.has(el.localName)) {
      flush();
      out.push(...blocks(el));
      continue;
    }
    const block = el.prefix === 'ac' ? isAc(el, 'structured-macro') && el.getAttribute('ac:name') !== 'status' && el.getAttribute('ac:name') !== 'jira' : BLOCK.has(tag) || tag === 'li';
    if (!block) {
      inlineBuf += inline(el);
      continue;
    }
    flush();
    if (/^h[1-6]$/.test(tag)) {
      // Headings carry no bold in TAD Markdown even when the storage wraps them in <strong>.
      out.push(`${'#'.repeat(Number(tag[1]))} ${inlineChildren(el).replace(/^\*\*(.*)\*\*$/, '$1')}`, '');
    } else if (tag === 'p') {
      const t = inlineChildren(el);
      if (t) out.push(t, '');
    } else if (tag === 'ul' || tag === 'ol') out.push(...list(el, 0), '');
    else if (tag === 'table') out.push(...table(el), '');
    else if (tag === 'pre') out.push('```', el.textContent ?? '', '```', '');
    else if (tag === 'hr') out.push('---', '');
    else if (tag === 'blockquote') out.push(...blocks(el).map((l) => (l ? `> ${l}` : '>')), '');
    else if (el.prefix === 'ac') out.push(...macroBlock(el), '');
    else out.push(...blocks(el));
  }
  flush();
  return out;
}

export interface ConvertedPage {
  markdown: string;
  /** Rough document type, to suggest importing as TAD or as PRD. */
  kind: 'tad' | 'prd' | 'other';
  hasToc: boolean;
}

export function storageToMarkdown(xhtml: string, title?: string): ConvertedPage {
  const hasToc = /<ac:structured-macro[^>]*ac:name="toc"/i.test(xhtml);
  const body = blocks(parseStorage(xhtml))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let markdown: string;
  if (title) {
    const cleanTitle = title.trim();
    const startsWithExactTitle = new RegExp(`^#\\s+${cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(body.slice(0, 300));
    if (startsWithExactTitle) {
      markdown = `${body}\n`;
    } else {
      markdown = `# ${cleanTitle}\n\n${body}\n`;
    }
  } else {
    markdown = `${body}\n`;
  }
  const kind = /#\s*Development Scope/i.test(markdown) || /#\s*Detail Task/i.test(markdown) ? 'tad' : /##?\s*Requirements/i.test(markdown) && /User Story/i.test(markdown) ? 'prd' : 'other';
  return { markdown, kind, hasToc };
}
