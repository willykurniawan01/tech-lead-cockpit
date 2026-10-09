import { Lexer, Marked, type Token, type Tokens } from 'marked';
import { embeddedHtmlToStorage, normalizeEmbeddedHtml } from '../markdown/embedded-html';
import { CALLOUTS, escapeXml, parseCallout, statusColour, isLineBreakTag } from '../markdown/shared';

/**
 * Converts TAD Markdown to Confluence storage format (XHTML + ac:/ri: macros)
 * with tadgen styling:
 * - Document Information table with headers and colgroup
 * - Change History table
 * - 2-column key-value table for Detail Tasks (kv_table)
 * - Code macro with breakoutMode="wide"
 * - Jira structured macro for Jira keys
 * - Native Confluence elements: panels, status lozenges, TOC, attachments.
 */

export type MermaidMode = 'attachment' | 'macro' | 'code';

export interface StorageOptions {
  /** attachment = render to PNG and attach (works everywhere); macro = Mermaid app on the instance; code = source only. */
  mermaid: MermaidMode;
  /** Macro name of the installed Mermaid app, used when mermaid = 'macro'. */
  mermaidMacro: string;
  toc: boolean;
  /**
   * Display name → account id, for `@Name` written as plain text (TADs imported before mentions
   * kept their ids). Only exact names are linked; anything else stays text.
   */
  knownUsers?: Record<string, string>;
}

export const DEFAULT_STORAGE_OPTIONS: StorageOptions = { mermaid: 'attachment', mermaidMacro: 'mermaid-cloud', toc: true };

export interface DiagramAttachment {
  filename: string;
  code: string;
}

export interface StorageResult {
  /** First H1, used as the Confluence page title (Confluence renders the title itself). */
  title: string | null;
  xhtml: string;
  diagrams: DiagramAttachment[];
}

export function diagramFilename(index: number): string {
  return `tad-diagram-${index + 1}.png`;
}

function cdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function param(name: string, value: string): string {
  return `<ac:parameter ac:name="${name}">${escapeXml(value)}</ac:parameter>`;
}

function macro(name: string, params: string, body = ''): string {
  return `<ac:structured-macro ac:name="${name}" ac:schema-version="1">${params}${body}</ac:structured-macro>`;
}

// Languages accepted by the code macro on both Cloud and Data Center.
const CODE_LANGS: Record<string, string> = {
  js: 'js', javascript: 'js', ts: 'js', typescript: 'js', json: 'js', jsx: 'js', tsx: 'js',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  py: 'py', python: 'py',
  java: 'java', kotlin: 'java', kt: 'java',
  go: 'text', golang: 'text',
  sql: 'sql', xml: 'xml', html: 'xml', yaml: 'yml', yml: 'yml',
  css: 'css', scss: 'sass', sass: 'sass', diff: 'diff', php: 'php', ruby: 'ruby', rb: 'ruby',
  cs: 'c#', csharp: 'c#', cpp: 'cpp', c: 'cpp', powershell: 'powershell', scala: 'scala',
};

function codeMacro(text: string, lang: string | undefined, title?: string): string {
  const language = CODE_LANGS[(lang ?? '').trim().toLowerCase()] ?? 'text';
  const params = param('language', language) + param('breakoutMode', 'wide') + (title ? param('title', title) : '');
  return macro('code', params, `<ac:plain-text-body>${cdata(text)}</ac:plain-text-body>`);
}

function jiraMacro(key: string): string {
  return macro('jira', param('key', key.toUpperCase()));
}

export function renderMentions(text: string): string {
  return text.replace(/@([a-f0-9]{24}|[0-9a-fA-F-]{36}|712020:[a-zA-Z0-9-]+)/g, '<ac:link><ri:user ri:account-id="$1" /></ac:link>');
}

export const CONFLUENCE_TOC_MACRO =
  '<ac:structured-macro ac:name="toc" ac:schema-version="1" data-layout="default"><ac:parameter ac:name="minLevel">1</ac:parameter><ac:parameter ac:name="maxLevel">2</ac:parameter><ac:parameter ac:name="outline">false</ac:parameter><ac:parameter ac:name="style">none</ac:parameter><ac:parameter ac:name="type">list</ac:parameter><ac:parameter ac:name="printable">true</ac:parameter></ac:structured-macro>';

// Mentions travel through Marked as an opaque placeholder: inline HTML would be escaped, and a
// mention may sit in a paragraph, list, heading or any table cell.
const MENTION_OPEN = '\u27E6user:';
const MENTION_CLOSE = '\u27E7';
const MENTION_SPAN = /<span data-tlc-user="([^"]*)">([\s\S]*?)<\/span>/g;

function decodeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Mention spans and known plain `@Name`s → placeholders (code spans and fences left alone). */
export function markMentions(md: string, knownUsers: Record<string, string> = {}): string {
  const names = new Map(Object.entries(knownUsers).filter(([n, id]) => n.trim() && id));
  for (const m of md.matchAll(MENTION_SPAN)) {
    const name = m[2].replace(/^@/, '').trim();
    if (name && m[1]) names.set(name, decodeAttr(m[1]));
  }
  const byLength = [...names.keys()].sort((a, b) => b.length - a.length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const plain = byLength.length ? new RegExp(`@(${byLength.map(escape).join('|')})(?![\\w\\u00C0-\\u024F])`, 'g') : null;
  // Split out fenced blocks and inline code so mentions inside code stay literal.
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = part.replace(MENTION_SPAN, (_, id: string) => `${MENTION_OPEN}${decodeAttr(id)}${MENTION_CLOSE}`);
      if (plain) out = out.replace(plain, (_, name: string) => `${MENTION_OPEN}${names.get(name)}${MENTION_CLOSE}`);
      return out;
    })
    .join('');
}

/**
 * Possible names behind plain `@…` text (no account id): every prefix of up to four words, since
 * where a name ends is unknown ("@Willy kurniawan hari ini"). The publish dialog asks Confluence
 * which of them are real people; only exact matches become mentions. Emails and code are skipped.
 */
export function plainMentionCandidates(md: string, known: Record<string, string> = {}): string[] {
  const text = md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .filter((_, i) => i % 2 === 0)
    .join(' ')
    .replace(MENTION_SPAN, ' ');
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w.])@([\p{L}][\p{L}\d.'-]*(?:[ \u00A0][\p{L}][\p{L}\d.'-]*){0,3})/gu)) {
    const words = m[1].split(/[ \u00A0]/);
    for (let n = 1; n <= words.length; n++) {
      const name = words.slice(0, n).join(' ').replace(/[.'-]+$/, '');
      if (name.length >= 2 && !known[name]) out.add(name);
    }
  }
  return [...out].slice(0, 40);
}

/** Placeholders → Confluence user links, outside CDATA (code macro bodies). */
function renderMentionPlaceholders(xhtml: string): string {
  return xhtml
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/g)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(new RegExp(`${MENTION_OPEN}([^${MENTION_CLOSE}]+)${MENTION_CLOSE}`, 'g'), (_, id: string) => `<ac:link><ri:user ri:account-id="${escapeXml(id)}" /></ac:link>`),
    )
    .join('');
}

export function toConfluenceStorage(md: string, opts: StorageOptions = DEFAULT_STORAGE_OPTIONS): StorageResult {
  const result = renderStorage(markMentions(md, opts.knownUsers), opts);
  return { ...result, xhtml: renderMentionPlaceholders(result.xhtml) };
}

function renderStorage(md: string, opts: StorageOptions): StorageResult {
  const diagrams: DiagramAttachment[] = [];

  const marked = new Marked({
    gfm: true,
    renderer: {
      code({ text, lang }: Tokens.Code) {
        if ((lang ?? '').trim().toLowerCase() !== 'mermaid') return codeMacro(text, lang);
        const filename = diagramFilename(diagrams.length);
        diagrams.push({ filename, code: text });
        if (opts.mermaid === 'macro') {
          return macro(opts.mermaidMacro, '', `<ac:plain-text-body>${cdata(text)}</ac:plain-text-body>`);
        }
        if (opts.mermaid === 'code') return codeMacro(text, undefined, 'Mermaid');
        // Keep the source next to the image so the diagram stays editable from Confluence.
        const image = `<p><ac:image ac:align="center" ac:layout="center"><ri:attachment ri:filename="${escapeXml(filename)}" /></ac:image></p>`;
        const source = macro('expand', param('title', 'Sumber diagram (Mermaid)'), `<ac:rich-text-body>${codeMacro(text, undefined)}</ac:rich-text-body>`);
        return image + source;
      },
      blockquote({ text, tokens }: Tokens.Blockquote) {
        const callout = parseCallout(text);
        if (!callout) return `<blockquote>${this.parser.parse(tokens)}</blockquote>`;
        const inner = this.parser.parse(Lexer.lex(callout.body, this.options));
        return macro(CALLOUTS[callout.kind].macro, '', `<ac:rich-text-body>${inner}</ac:rich-text-body>`);
      },
      heading({ tokens, depth, text }: Tokens.Heading) {
        if (depth === 2 && text.trim().startsWith('[')) {
          return `<h2><strong>${this.parser.parseInline(tokens)}</strong></h2>`;
        }
        return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>`;
      },
      paragraph({ tokens }: Tokens.Paragraph) {
        return `<p>${renderMentions(this.parser.parseInline(tokens))}</p>`;
      },
      list(token: Tokens.List) {
        const tag = token.ordered ? 'ol' : 'ul';
        const start = token.ordered && token.start !== '' && token.start !== 1 ? ` start="${token.start}"` : '';
        return `<${tag}${start}>${token.items.map((i) => this.listitem(i)).join('')}</${tag}>`;
      },
      listitem(item: Tokens.ListItem) {
        return `<li>${renderMentions(this.parser.parse(item.tokens))}</li>`;
      },
      checkbox({ checked }: Tokens.Checkbox) {
        return checked ? '☑ ' : '☐ ';
      },
      table(token: Tokens.Table) {
        const firstHeader = token.header[0]?.text.trim() || '';

        // 1. Document Information styling (tadgen format)
        if (firstHeader.includes('Document Information')) {
          const rowsHtml = token.rows
            .map((r) => {
              const label = renderMentions(this.parser.parseInline(r[0]?.tokens || []));
              const val = renderMentions(this.parser.parseInline(r[1]?.tokens || []));
              return `<tr><td><p>${label}</p></td><td><p>${val}</p></td></tr>`;
            })
            .join('');
          return (
            '<table data-table-width="1800" data-layout="center"><colgroup><col style="width: 604.0px;" />' +
            '<col style="width: 1196.0px;" /></colgroup><tbody>' +
            '<tr><th data-highlight-colour="#f0f1f2" colspan="2"><h1><strong>Document Information</strong></h1></th></tr>' +
            rowsHtml +
            '</tbody></table>'
          );
        }

        // 2. Change History styling (tadgen format)
        if (firstHeader.includes('Change History') || firstHeader.includes('Change Log')) {
          const isHeaderRow = token.rows[0]?.[0]?.text?.toLowerCase().includes('description');
          const dataRows = isHeaderRow ? token.rows.slice(1) : token.rows;
          const rowsHtml = dataRows
            .map((r) => {
              const desc = renderMentions(this.parser.parseInline(r[0]?.tokens || []));
              const date = renderMentions(this.parser.parseInline(r[1]?.tokens || []));
              const author = renderMentions(this.parser.parseInline(r[2]?.tokens || []));
              return `<tr><td><p>${desc}</p></td><td><p>${date}</p></td><td><p>${author}</p></td></tr>`;
            })
            .join('');
          return (
            '<table data-table-width="1800" data-layout="center"><tbody>' +
            '<tr><th data-highlight-colour="#f0f1f2" colspan="3"><h1><strong>Change History</strong></h1></th></tr>' +
            '<tr><td><p><strong>Description</strong></p></td><td><p><strong>Update Date</strong></p></td><td><p><strong>Updated By</strong></p></td></tr>' +
            rowsHtml +
            '</tbody></table>'
          );
        }

        const row = (cells: Tokens.TableCell[]) => `<tr>${cells.map((c) => this.tablecell(c)).join('')}</tr>`;
        return `<table data-layout="default"><tbody>${row(token.header)}${token.rows.map(row).join('')}</tbody></table>`;
      },
      tablecell(token: Tokens.TableCell) {
        const tag = token.header ? 'th' : 'td';
        const colour = token.header ? undefined : statusColour(token.text);
        let content: string;
        if (colour) {
          content = macro('status', param('colour', colour) + param('title', token.text.trim().toUpperCase()));
        } else {
          const trimmed = token.text.trim();
          if (/^[A-Z][A-Z0-9]+-\d+$/.test(trimmed)) {
            content = jiraMacro(trimmed);
          } else {
            content = renderMentions(this.parser.parseInline(token.tokens));
          }
        }
        const inner = tag === 'td' && !content.startsWith('<p') && !content.startsWith('<table') && !content.startsWith('<ac:structured-macro')
          ? `<p>${content}</p>`
          : content;
        return `<${tag}>${inner}</${tag}>`;
      },
      hr() {
        return '<hr />';
      },
      br() {
        return '<br />';
      },
      del({ tokens }: Tokens.Del) {
        return `<span style="text-decoration: line-through;">${this.parser.parseInline(tokens)}</span>`;
      },
      image({ href, text }: Tokens.Image) {
        return `<ac:image ac:alt="${escapeXml(text)}"><ri:url ri:value="${escapeXml(href)}" /></ac:image>`;
      },
      link({ href, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        // Detect Jira links
        const jiraMatch = href.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i) || text.match(/^([A-Z][A-Z0-9]+-\d+)$/);
        if (jiraMatch) {
          return jiraMacro(jiraMatch[1]);
        }
        return `<a href="${escapeXml(href)}">${text}</a>`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        if (text.trim() === '<!-- toc -->') {
          return '<!-- confluence-toc-marker -->';
        }
        if (text.startsWith('<!-- safe-xhtml -->') || text.startsWith('<table')) {
          return embeddedHtmlToStorage(text.replace(/^<!-- safe-xhtml -->/, ''));
        }
        if (isLineBreakTag(text)) return '<br />';
        // Arbitrary HTML is rejected by Confluence's storage parser; keep it as visible text.
        return escapeXml(text);
      },
      space() {
        return '';
      },
    },
  });

  const tokens = marked.lexer(normalizeEmbeddedHtml(md));

  // Extract page title from first H1
  let title: string | null = null;
  const titleIndex = tokens.findIndex((t: Token) => t.type === 'heading' && (t as Tokens.Heading).depth === 1);
  if (titleIndex !== -1) {
    title = (tokens[titleIndex] as Tokens.Heading).text.trim();
    tokens.splice(titleIndex, 1);
  }

  // Transform Detail Task subsections (depth 4 headings) into tadgen 2-column kv_tables
  const transformedTokens: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'heading' && (t as Tokens.Heading).depth === 2 && (t as Tokens.Heading).text.trim().startsWith('[')) {
      // Push the H2 task heading
      transformedTokens.push(t);
      i++;

      // Collect all tokens for this task until next H2 or H1
      const taskTokens: Token[] = [];
      while (i < tokens.length) {
        const next = tokens[i];
        if (next.type === 'heading' && ((next as Tokens.Heading).depth <= 2)) {
          break;
        }
        taskTokens.push(next);
        i++;
      }

      // If taskTokens already contains a task table (<table data-table-width=... or detail-task-table or any <table), keep it as is
      const alreadyHasTable = taskTokens.some((tok) => tok.type === 'html' && (tok.text.includes('data-table-width="1688"') || tok.text.includes('detail-task-table') || tok.text.includes('<table')));
      if (alreadyHasTable) {
        transformedTokens.push(...taskTokens);
        continue;
      }

      // Partition task tokens into key-value rows strictly by depth 4 headings (e.g. #### Description)
      const rows: { label: string; innerTokens: Token[] }[] = [];
      let currentLabel = 'Description';
      let currentInner: Token[] = [];

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

      // Render rows into tadgen 2-column table
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
        '<!-- safe-xhtml -->' +
        '<table data-table-width="1688" data-layout="center">' +
        '<colgroup><col style="width: 293.0px;" /><col style="width: 1395.0px;" /></colgroup>' +
        `<tbody>${rowsHtml}</tbody></table>`;

      transformedTokens.push({
        type: 'html',
        raw: kvTableHtml,
        text: kvTableHtml,
        block: true,
      } as Token);
    } else {
      transformedTokens.push(t);
      i++;
    }
  }

  let xhtml = marked.parser(transformedTokens as Tokens.Generic[]) as string;

  if (xhtml.includes('<!-- confluence-toc-marker -->')) {
    xhtml = xhtml.replace(/<!-- confluence-toc-marker -->/g, opts.toc ? CONFLUENCE_TOC_MACRO : '');
  } else if (opts.toc) {
    // If no TOC marker was in the markdown, insert TOC after metadata tables (Document Info & Change History)
    let inserted = false;
    const changeHistoryIdx = xhtml.indexOf('Change History');
    if (changeHistoryIdx !== -1) {
      const tableEnd = xhtml.indexOf('</table>', changeHistoryIdx);
      if (tableEnd !== -1) {
        const insertPos = tableEnd + '</table>'.length;
        xhtml = xhtml.slice(0, insertPos) + CONFLUENCE_TOC_MACRO + xhtml.slice(insertPos);
        inserted = true;
      }
    }
    if (!inserted) {
      const docInfoIdx = xhtml.indexOf('Document Information');
      if (docInfoIdx !== -1) {
        const tableEnd = xhtml.indexOf('</table>', docInfoIdx);
        if (tableEnd !== -1) {
          const insertPos = tableEnd + '</table>'.length;
          xhtml = xhtml.slice(0, insertPos) + CONFLUENCE_TOC_MACRO + xhtml.slice(insertPos);
          inserted = true;
        }
      }
    }
    if (!inserted) {
      const firstHeading = xhtml.search(/<h[12][ >]/);
      if (firstHeading !== -1) {
        xhtml = xhtml.slice(0, firstHeading) + CONFLUENCE_TOC_MACRO + xhtml.slice(firstHeading);
      } else {
        xhtml = CONFLUENCE_TOC_MACRO + xhtml;
      }
    }
  }

  return { title, xhtml, diagrams };
}
