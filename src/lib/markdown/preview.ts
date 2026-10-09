import DOMPurify from 'dompurify';
import { Lexer, Marked, type Tokens } from 'marked';
import { findSection } from '../tad/template';
import { CALLOUTS, escapeXml, parseCallout, slugify, statusColour, isLineBreakTag } from './shared';
import { normalizeEmbeddedHtml } from './embedded-html';

export interface PreviewResult {
  html: string;
  /** Mermaid sources in document order; `data-mermaid="i"` placeholders reference them. */
  diagrams: string[];
}

export function renderPreview(md: string): PreviewResult {
  const diagrams: string[] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        const section = depth === 2 ? findSection(text) : undefined;
        const id = section ? `sec-${section.id}` : slugify(text);
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      code({ text, lang }: Tokens.Code) {
        if ((lang ?? '').trim().toLowerCase() === 'mermaid') {
          diagrams.push(text);
          return `<div class="mermaid-block" data-mermaid="${diagrams.length - 1}"><pre>${escapeXml(text)}</pre></div>\n`;
        }
        const label = lang ? `<span class="code-lang">${escapeXml(lang)}</span>` : '';
        return `<div class="code-block">${label}<pre><code>${escapeXml(text)}</code></pre></div>\n`;
      },
      blockquote({ text, tokens }: Tokens.Blockquote) {
        const callout = parseCallout(text);
        if (!callout) return `<blockquote>${this.parser.parse(tokens)}</blockquote>\n`;
        const style = CALLOUTS[callout.kind];
        const inner = this.parser.parse(Lexer.lex(callout.body, this.options));
        return `<div class="callout callout-${style.macro}"><div class="callout-title">${style.label}</div>${inner}</div>\n`;
      },
      tablecell(token: Tokens.TableCell) {
        const tag = token.header ? 'th' : 'td';
        const colour = token.header ? undefined : statusColour(token.text);
        const content = colour
          ? `<span class="lozenge lozenge-${colour.toLowerCase()}">${escapeXml(token.text.trim().toUpperCase())}</span>`
          : this.parser.parseInline(token.tokens);
        return `<${tag}>${content}</${tag}>\n`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        if (text.includes('<!-- toc -->')) {
          return '<div class="toc-placeholder" contenteditable="false"><span class="toc-icon">📑</span> <strong>Daftar Isi (TOC)</strong> <span class="toc-sub">— Otomatis Confluence</span></div>\n';
        }
        if (text.startsWith('<table') || text.startsWith('<!-- safe-xhtml -->')) {
          return text.replace(/^<!-- safe-xhtml -->/, '') + '\n';
        }
        if (isLineBreakTag(text)) return '<br />';
        // Raw HTML is not carried over to Confluence either; show it as text.
        return escapeXml(text);
      },
    },
  });

  const tokens = marked.lexer(normalizeEmbeddedHtml(md));
  const transformedTokens: any[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'heading' && (t as Tokens.Heading).depth === 2 && (t as Tokens.Heading).text.trim().startsWith('[')) {
      transformedTokens.push(t);
      i++;

      const taskTokens: any[] = [];
      while (i < tokens.length) {
        const next = tokens[i];
        if (next.type === 'heading' && ((next as Tokens.Heading).depth <= 2)) break;
        taskTokens.push(next);
        i++;
      }

      // An imported task keeps its own table (any width); only `#### Label` sections get one built.
      const alreadyHasTable = taskTokens.some((tok) => tok.type === 'html' && /^\s*(<!-- safe-xhtml -->)?<table\b/.test(tok.text));
      if (alreadyHasTable) {
        transformedTokens.push(...taskTokens);
        continue;
      }

      const rows: { label: string; innerTokens: any[] }[] = [];
      let currentLabel = 'Description';
      let currentInner: any[] = [];
      for (const tok of taskTokens) {
        if (tok.type === 'heading' && (tok as Tokens.Heading).depth === 4) {
          const hasContent = currentInner.some((tk) => tk.type !== 'space');
          if (hasContent) {
            rows.push({ label: currentLabel, innerTokens: currentInner });
          }
          currentInner = [];
          currentLabel = (tok as Tokens.Heading).text.trim();
        } else {
          currentInner.push(tok);
        }
      }
      const hasContent = currentInner.some((tk) => tk.type !== 'space');
      if (hasContent || rows.length === 0) {
        rows.push({ label: currentLabel, innerTokens: currentInner });
      }

      const rowsHtml = rows
        .map((r) => {
          const renderedInner = marked.parser(r.innerTokens as Tokens.Generic[]);
          return (
            `<tr><th data-highlight-colour="#f0f1f2"><h3>${escapeXml(r.label)}</h3></th>` +
            `<td>${renderedInner}</td></tr>`
          );
        })
        .join('');

      const kvTableHtml =
        '<table class="detail-task-table" data-table-width="1688" data-layout="center">' +
        '<colgroup><col style="width: 293.0px;" /><col style="width: 1395.0px;" /></colgroup>' +
        `<tbody>${rowsHtml}</tbody></table>\n`;

      transformedTokens.push({
        type: 'html',
        raw: kvTableHtml,
        text: kvTableHtml,
        block: true,
      });
    } else {
      transformedTokens.push(t);
      i++;
    }
  }

  const raw = marked.parser(transformedTokens as Tokens.Generic[]) as string;
  const html = DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'data-table-width', 'data-layout', 'data-highlight-colour'] });
  return { html, diagrams };
}
