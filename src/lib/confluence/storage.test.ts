import { describe, expect, it } from 'vitest';
import { blankTad, generateTadSkeleton } from '../tad/generator';
import { parsePrd } from '../prd/parser';
import { plainMentionCandidates, toConfluenceStorage } from './storage';
import { storageToMarkdown } from './storage-to-markdown';

/** Confluence storage must be well-formed XML once the ac:/ri: namespaces are declared. */
function assertWellFormed(xhtml: string) {
  const doc = new DOMParser().parseFromString(
    `<root xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource/identifier">${xhtml}</root>`,
    'application/xml',
  );
  const err = doc.querySelector('parsererror');
  expect(err?.textContent ?? null).toBeNull();
}

describe('toConfluenceStorage', () => {
  it('uses the H1 as page title and removes it from the body', () => {
    const r = toConfluenceStorage('# TAD — Login\n\n## 1. Intro\n\nHalo');
    expect(r.title).toBe('TAD — Login');
    expect(r.xhtml).not.toContain('<h1>TAD — Login</h1>');
    expect(r.xhtml).toContain('<h2>1. Intro</h2>');
  });

  it('maps callouts to panel macros', () => {
    const r = toConfluenceStorage('> [!WARNING]\n> Hati-hati **ini**', { mermaid: 'code', mermaidMacro: '', toc: false });
    expect(r.xhtml).toBe('<ac:structured-macro ac:name="note" ac:schema-version="1"><ac:rich-text-body><p>Hati-hati <strong>ini</strong></p></ac:rich-text-body></ac:structured-macro>');
  });

  it('renders wide code macro with breakoutMode wide and escapes CDATA terminators', () => {
    const r = toConfluenceStorage('```ts\nconst a = "]]>";\n```', { mermaid: 'code', mermaidMacro: '', toc: false });
    expect(r.xhtml).toContain('<ac:parameter ac:name="language">js</ac:parameter>');
    expect(r.xhtml).toContain('<ac:parameter ac:name="breakoutMode">wide</ac:parameter>');
    expect(r.xhtml).toContain(']]]]><![CDATA[>');
    assertWellFormed(r.xhtml);
  });

  it('renders tadgen Document Information table with width 1800 and colgroup', () => {
    const md = `| **Document Information** |   |\n|---|---|\n| Author | @Willy |\n| Code Name | MOTION-CIRCLE |`;
    const r = toConfluenceStorage(md, { mermaid: 'code', mermaidMacro: '', toc: false });
    expect(r.xhtml).toContain('data-table-width="1800"');
    expect(r.xhtml).toContain('colspan="2"><h1><strong>Document Information</strong></h1></th>');
    expect(r.xhtml).toContain('<p>Author</p>');
    assertWellFormed(r.xhtml);
  });

  it('renders tadgen Change History table', () => {
    const md = `| **Change History** |   |   |\n|---|---|---|\n| Inisiasi | 2026-10-01 | @Willy |`;
    const r = toConfluenceStorage(md, { mermaid: 'code', mermaidMacro: '', toc: false });
    expect(r.xhtml).toContain('colspan="3"><h1><strong>Change History</strong></h1></th>');
    expect(r.xhtml).toContain('Description');
    assertWellFormed(r.xhtml);
  });

  it('renders tadgen 2-column kv_table for Detail Tasks', () => {
    const md = [
      '# Detail Task',
      '',
      '## [BACKEND][CORE-AUTH][PROJ] - Develop API Login',
      '',
      '#### Description',
      '',
      'Endpoint login untuk user.',
      '',
      '#### Service',
      '',
      '`CORE-AUTH`',
      '',
      '#### Method',
      '',
      '`POST`',
    ].join('\n');

    const r = toConfluenceStorage(md, { mermaid: 'code', mermaidMacro: '', toc: false });
    expect(r.xhtml).toContain('<h2><strong>[BACKEND][CORE-AUTH][PROJ] - Develop API Login</strong></h2>');
    expect(r.xhtml).toContain('data-table-width="1688"');
    expect(r.xhtml).toContain('<th data-highlight-colour="#f0f1f2"><h3>Description</h3></th>');
    expect(r.xhtml).toContain('<th data-highlight-colour="#f0f1f2"><h3>Service</h3></th>');
    expect(r.xhtml).toContain('<th data-highlight-colour="#f0f1f2"><h3>Method</h3></th>');
    expect(r.xhtml).toContain('<code>CORE-AUTH</code>');
    assertWellFormed(r.xhtml);
  });

  it('renders Jira macros for Jira issue keys and links', () => {
    const md = '| Task | Jira |\n|---|---|\n| Feature 1 | PROJ-123 |\n| Feature 2 | [LINK-456](https://jira.company.com/browse/LINK-456) |';
    const r = toConfluenceStorage(md, { mermaid: 'code', mermaidMacro: '', toc: false });
    expect(r.xhtml).toContain('<ac:structured-macro ac:name="jira" ac:schema-version="1"><ac:parameter ac:name="key">PROJ-123</ac:parameter></ac:structured-macro>');
    expect(r.xhtml).toContain('<ac:structured-macro ac:name="jira" ac:schema-version="1"><ac:parameter ac:name="key">LINK-456</ac:parameter></ac:structured-macro>');
    assertWellFormed(r.xhtml);
  });

  it('produces well-formed XML for a full generated TAD from PRD', () => {
    const prd = parsePrd('# PRD - Circle\n\n## Objective\n\nFitur circle.\n\n## Requirements\n\n| | Keyword | Requirement |\n|---|---|---|\n| 1 | Invite | Kirim invite |');
    const md = `${generateTadSkeleton(prd)}\n\n\`\`\`mermaid\nflowchart LR\n  a --> b\n\`\`\`\n`;
    const r = toConfluenceStorage(md);
    expect(r.xhtml).toContain('<ac:structured-macro ac:name="toc"');
    expect(r.xhtml.indexOf('<ac:structured-macro ac:name="toc"')).toBeGreaterThan(r.xhtml.indexOf('Document Information'));
    expect(r.diagrams).toHaveLength(1);
    assertWellFormed(r.xhtml);
  });

  it('keeps <br> line breaks inside table cells but escapes other HTML', () => {
    const md = '| Field | Value |\n| --- | --- |\n| Reviewers | A (Owner)<br>B (QA)<BR/>C <b>x</b> |';
    const r = toConfluenceStorage(md, { mermaid: 'code', mermaidMacro: '', toc: false });
    expect(r.xhtml).toContain('A (Owner)<br />B (QA)<br />C');
    expect(r.xhtml).toContain('&lt;b&gt;x&lt;/b&gt;');
    assertWellFormed(r.xhtml);
  });
});

describe('mentions on publish', () => {
  const link = (id: string) => `<ac:link><ri:user ri:account-id="${id}" /></ac:link>`;

  it('turns mention spans into Confluence mentions in paragraphs, lists and table cells', () => {
    const md = [
      '# T',
      '',
      'Dibuat oleh <span data-tlc-user="712020:abc-1">@Willy kurniawan</span> hari ini.',
      '',
      '| Field | Value |',
      '|---|---|',
      '| Author | <span data-tlc-user="63632a2aa04e906250c9944b">@Willy kurniawan</span> |',
      '',
      '- PIC: <span data-tlc-user="60d1a073758a5d006a60f745">@Guntur</span>',
      '',
      '```',
      'email @Willy kurniawan tidak diubah',
      '```',
    ].join('\n');
    const x = toConfluenceStorage(md).xhtml;
    expect(x).toContain(`Dibuat oleh ${link('712020:abc-1')} hari ini.`);
    expect(x).toContain(link('63632a2aa04e906250c9944b'));
    expect(x).toContain(`PIC: ${link('60d1a073758a5d006a60f745')}`);
    expect(x).not.toContain('data-tlc-user');
    expect(x).not.toContain('&lt;span');
    // Code stays literal.
    expect(x).toContain('email @Willy kurniawan tidak diubah');
  });

  it('links plain @Name only for known people (exact names)', () => {
    const md = '# T\n\nReviewer: @Guntur Saputro dan @Orang Asing.\n\n| Author | @Eka Widiantara |\n|---|---|\n| x | y |';
    const x = toConfluenceStorage(md, { mermaid: 'attachment', mermaidMacro: 'mermaid-cloud', toc: false, knownUsers: { 'Guntur Saputro': 'g-1', 'Eka Widiantara': 'e-1', Guntur: 'wrong' } }).xhtml;
    expect(x).toContain(`Reviewer: ${link('g-1')} dan @Orang Asing.`);
    expect(x).toContain(link('e-1'));
    expect(x).not.toContain('wrong');
  });

  it('round-trips mentions from a Confluence import to publish', () => {
    const page =
      '<table><tbody><tr><td><p>Author</p></td><td><p><ac:link><ri:user ri:account-id="63632a2aa04e906250c9944b" data-display-name="Willy kurniawan" /></ac:link></p></td></tr>' +
      '<tr><td><p>Reviewer</p></td><td><p><ac:link><ri:user ri:account-id="712020:90891f9f" data-display-name="putu" /></ac:link></p></td></tr></tbody></table>' +
      '<p>Catatan dari <ac:link><ri:user ri:account-id="60d1a073758a5d006a60f745" data-display-name="Guntur Saputro" /></ac:link>.</p>';
    const md = storageToMarkdown(page, 'TAD - X').markdown;
    expect(md).toContain('<span data-tlc-user="63632a2aa04e906250c9944b">@Willy kurniawan</span>');
    const x = toConfluenceStorage(md).xhtml;
    for (const id of ['63632a2aa04e906250c9944b', '712020:90891f9f', '60d1a073758a5d006a60f745']) expect(x).toContain(link(id));
  });
});

describe('plain mention candidates', () => {
  it('lists name prefixes outside code, spans and emails', () => {
    const md = 'Author @Willy kurniawan hari ini. Mail user@example.com\n\n`@Kode Saja`\n\n<span data-tlc-user="x">@Sudah Ada</span> dan @Guntur';
    expect(plainMentionCandidates(md, { Guntur: 'g' })).toEqual(['Willy', 'Willy kurniawan', 'Willy kurniawan hari', 'Willy kurniawan hari ini']);
  });
});
