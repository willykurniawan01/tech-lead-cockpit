import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateTad } from '../tad/validator';
import { toConfluenceStorage } from './storage';
import { storageToMarkdown } from './storage-to-markdown';

describe('storageToMarkdown', () => {
  it('keeps tables, headings and lists inside page layouts (sections/columns)', () => {
    const xhtml =
      '<ac:layout><ac:layout-section ac:type="fixed-width" ac:breakout-mode="default"><ac:layout-cell>' +
      '<table data-table-width="1800"><ac:adf-fragment-mark><ac:adf-fragment-mark-detail name="Table 1" local-id="x" /></ac:adf-fragment-mark>' +
      '<colgroup><col style="width: 604.0px;" /><col style="width: 1196.0px;" /></colgroup><tbody>' +
      '<tr><th colspan="2"><h1><strong>Document Information</strong></h1></th></tr>' +
      '<tr><td><p>Author</p></td><td><p>Willy</p></td></tr>' +
      '<tr><td><p>Code Name</p></td><td><p>ENHANCE-KYC</p></td></tr>' +
      '</tbody></table></ac:layout-cell></ac:layout-section>' +
      '<ac:layout-section ac:type="two_equal"><ac:layout-cell><h1>Objective</h1><ul><li><p>Sentralisasi konfigurasi</p></li></ul></ac:layout-cell>' +
      '<ac:layout-cell><h2>[BACKEND][CORE][KYC] - API Status</h2><p>Teks <code>REJECTED</code>.</p></ac:layout-cell></ac:layout-section></ac:layout>';
    const md = storageToMarkdown(xhtml, 'TAD - KYC').markdown;
    expect(md).toContain('| Author | Willy |');
    expect(md).toContain('| Code Name | ENHANCE-KYC |');
    expect(md).toMatch(/^# Objective$/m);
    expect(md).toContain('- Sentralisasi konfigurasi');
    expect(md).toMatch(/^## \[BACKEND\]\[CORE\]\[KYC\] - API Status$/m);
    expect(md).toContain('Teks `REJECTED`.');
    // Nothing from different blocks ends up glued on one line.
    expect(md).not.toMatch(/AuthorWilly|ENHANCE-KYCObjective/);
  });

  it('turns tadgen task tables back into #### sections', () => {
    const xhtml =
      '<h2><strong>[BACKEND][CORE-A][X] - Develop API Foo</strong></h2>' +
      '<table><tbody><tr><th data-highlight-colour="#f0f1f2"><h3>Description</h3></th><td><p>Endpoint <strong>foo</strong> &amp; <code>bar</code>.</p><ul><li><p>Langkah 1</p><ul><li><p>Sub</p></li></ul></li></ul></td></tr>' +
      '<tr><th><h3>Service</h3></th><td><p><code>CORE-A</code></p></td></tr>' +
      '<tr><th><h3>Response</h3></th><td><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter><ac:plain-text-body><![CDATA[{"ok": true}]]></ac:plain-text-body></ac:structured-macro></td></tr></tbody></table>';
    const { markdown } = storageToMarkdown(xhtml);
    expect(markdown).toContain('## [BACKEND][CORE-A][X] - Develop API Foo');
    expect(markdown).toContain('#### Description\n\nEndpoint **foo** & `bar`.\n\n- Langkah 1\n  - Sub');
    expect(markdown).toContain('#### Service\n\n`CORE-A`');
    expect(markdown).toContain('```json\n{"ok": true}\n```');
    expect(markdown).not.toContain('<table');
  });

  it('converts grid tables, panels, status/jira macros, mentions and named entities', () => {
    const xhtml =
      '<table><tbody><tr><td data-highlight-colour="#f4f5f7"><p><strong>Field</strong></p></td><td><p><strong>Value</strong></p></td></tr>' +
      '<tr><td><p>Level</p></td><td><ac:structured-macro ac:name="status"><ac:parameter ac:name="title">HIGH</ac:parameter></ac:structured-macro></td></tr>' +
      '<tr><td><p>Jira</p></td><td><p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">MC-12</ac:parameter></ac:structured-macro></p></td></tr>' +
      '<tr><td><p>Author</p></td><td><p><ac:link><ri:user ri:account-id="abc" data-display-name="Willy" /></ac:link></p></td></tr></tbody></table>' +
      '<ac:structured-macro ac:name="note"><ac:rich-text-body><p>Scope hanya backend&nbsp;saja.</p></ac:rich-text-body></ac:structured-macro>' +
      '<ac:structured-macro ac:name="toc"></ac:structured-macro>';
    const { markdown } = storageToMarkdown(xhtml, 'TAD - Judul');
    expect(markdown.startsWith('# TAD - Judul\n')).toBe(true);
    // Mentions keep their account id so publishing restores them as real mentions.
    expect(markdown).toContain('| **Field** | **Value** |\n|---|---|\n| Level | HIGH |\n| Jira | MC-12 |\n| Author | <span data-tlc-user="abc">@Willy</span> |');
    expect(markdown).toContain('> [!IMPORTANT]\n> Scope hanya backend saja.\n');
    expect(markdown).not.toMatch(/saja\.\n>/);
    expect(markdown).toContain('<!-- toc -->');
  });

  it('round-trips a TAD published by this app', () => {
    const md = ['# TAD - X', '', '# Development Scope', '', '|   | **Service Name** | **Task Name** | **Jira Task** |', '|---|---|---|---|', '| 1 | CORE-A | [BACKEND][CORE-A][X] - Task | Belum dibuat |', '', '# Detail Task', '', '## [BACKEND][CORE-A][X] - Task', '', '#### Description', '', 'Isi.'].join('\n');
    const { xhtml, title } = toConfluenceStorage(md, { mermaid: 'code', mermaidMacro: '', toc: false });
    const back = storageToMarkdown(xhtml, title ?? undefined);
    const r = validateTad(back.markdown);
    expect(back.kind).toBe('tad');
    expect(r.scopeTasks.map((t) => t.taskTitle)).toEqual(['[BACKEND][CORE-A][X] - Task']);
    expect(r.detailTasks.map((t) => t.taskTitle)).toEqual(['[BACKEND][CORE-A][X] - Task']);
  });

  it('imports the real Motion Circle TAD pages from tadgen without losing tasks', () => {
    const dir = '/Users/willykurniawan/Documents/MTN & FM/Motion Circle/output';
    if (!fs.existsSync(dir)) return;
    const storage = [1, 2, 3, 4, 5].map((n) => fs.readFileSync(`${dir}/mc-batch${n}.storage.xml`, 'utf8')).join('');
    const { markdown, kind } = storageToMarkdown(storage, 'TAD - Motion Circle');
    const r = validateTad(markdown);
    expect(kind).toBe('tad');
    expect(r.scopeTasks.length).toBe(30);
    expect(r.detailTasks.length).toBeGreaterThanOrEqual(29);
    expect(markdown).toContain('Endpoint');
    expect(markdown).toContain('| **Document Information** |');
  });

  it('roundtrips mc-batch1 without unexpected line differences or TOC displacement', async () => {
    const file = '/Users/willykurniawan/Documents/MTN & FM/Motion Circle/output/mc-batch1.storage.xml';
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    const { markdown } = storageToMarkdown(raw, 'TAD - Motion Circle');
    const res = toConfluenceStorage(markdown, { mermaid: 'attachment', mermaidMacro: 'mermaid-cloud', toc: true });

    // Verify TOC is NOT at the top (must be after Document Information and Change History)
    const tocIdx = res.xhtml.indexOf('<ac:structured-macro ac:name="toc"');
    const docInfoIdx = res.xhtml.indexOf('Document Information');
    const changeHistIdx = res.xhtml.indexOf('Change History');
    expect(tocIdx).toBeGreaterThan(docInfoIdx);
    expect(tocIdx).toBeGreaterThan(changeHistIdx);

    const { lineDiff, storageToLines } = await import('../diff');
    const rawLines = storageToLines(raw);
    const resLines = storageToLines(res.xhtml);
    const diff = lineDiff(rawLines, resLines);
    const changes = diff.filter((d) => d.type !== 'same');
    expect(changes.length).toBe(0);
  });

  it('preserves line breaks and spacing stably across editor roundtrips without multiplying <br>', async () => {
    const { renderPreview } = await import('../markdown/preview');
    const { htmlToMarkdown } = await import('../markdown/html-to-markdown');

    const md = [
      '# TAD - Spacing Test',
      '',
      '| Field | Value |',
      '|---|---|',
      '| Reviewers | User A<br>User B<br>User C |',
      '| Notes | `code_a` and `code_b`: status OK |',
      '',
      '1. Step 1: run `command` and check (result).',
      '2. Step 2: verify `status` is **ACTIVE**.',
    ].join('\n') + '\n';

    const html1 = renderPreview(md).html;
    const md1 = htmlToMarkdown(html1);
    expect(md1).toBe(md);

    const html2 = renderPreview(md1).html;
    const md2 = htmlToMarkdown(html2);
    expect(md2).toBe(md);
  });

  it('correctly converts various Confluence mention formats into human-readable mention spans', () => {
    const xhtml = [
      '<p>1. Link body CDATA: <ac:link><ri:user ri:account-id="acc-1" /><ac:plain-text-link-body><![CDATA[@Ridwan Dev]]></ac:plain-text-link-body></ac:link></p>',
      '<p>2. Local-id first: <ac:link><ri:user ri:local-id="loc-123" ri:account-id="acc-2" /><ac:link-body>@Willy K</ac:link-body></ac:link></p>',
      '<p>3. Data display name: <ac:link><ri:user ri:account-id="acc-3" data-display-name="Guntur" /></ac:link></p>',
      '<p>4. DC username: <ac:link><ri:user ri:username="johndoe" /><ac:plain-text-link-body>@John Doe</ac:plain-text-link-body></ac:link></p>',
      '<p>5. Bare ri:user: <ri:user ri:account-id="acc-5" data-display-name="Alice" /></p>',
      '<p>6. Confluence user mention span: <span class="confluence-user-mention" data-account-id="acc-6">@Bob</span></p>',
      '<p>7. Confluence user mention link: <a class="confluence-user-mention" data-account-id="acc-7" href="#">@Charlie</a></p>',
    ].join('\n');

    const { markdown } = storageToMarkdown(xhtml, 'Test Mentions');
    expect(markdown).toContain('1. Link body CDATA: <span data-tlc-user="acc-1">@Ridwan Dev</span>');
    expect(markdown).toContain('2. Local-id first: <span data-tlc-user="acc-2">@Willy K</span>');
    expect(markdown).toContain('3. Data display name: <span data-tlc-user="acc-3">@Guntur</span>');
    expect(markdown).toContain('4. DC username: <span data-tlc-user="johndoe">@John Doe</span>');
    expect(markdown).toContain('5. Bare ri:user: <span data-tlc-user="acc-5">@Alice</span>');
    expect(markdown).toContain('6. Confluence user mention span: <span data-tlc-user="acc-6">@Bob</span>');
    expect(markdown).toContain('7. Confluence user mention link: <span data-tlc-user="acc-7">@Charlie</span>');
  });
});


