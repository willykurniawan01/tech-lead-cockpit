import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { storageToMarkdown } from '../confluence/storage-to-markdown';
import { toConfluenceStorage } from '../confluence/storage';
import { renderPreview } from './preview';
import { htmlToMarkdown } from './html-to-markdown';
import { embeddedHtmlToStorage, normalizeEmbeddedHtml } from './embedded-html';

/** tadgen Detail Task layout as Confluence stores it: label column, nested lists, code with blank lines, inner table. */
const TASK = `<h2>[BACKEND][CORE-TCICO][TABUNGAN-MOTION] - Develop API Mobile Get Transfer Sof</h2>
<table data-table-width="1579" data-layout="center" ac:local-id="t1"><colgroup><col style="width: 272.0px;" /><col style="width: 1307.0px;" /></colgroup><tbody>
<tr><th data-highlight-colour="#f0f1f2"><h3><strong>Description</strong></h3></th><td>
<p>Endpoint <strong>&quot;Pilih Sumber Dana&quot;</strong> &rarr; SOF.</p>
<ul><li><p><strong>Routing:</strong></p></li></ul>
<ul><li><ul><li><p>Payload:</p><ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="wrap">true</ac:parameter><ac:plain-text-body><![CDATA[{
  "transaction_type": "TRANSFER"
}]]></ac:plain-text-body></ac:structured-macro></li></ul></li></ul>
</td></tr>
<tr><th><h3><strong>Endpoint</strong></h3></th><td><h4><code>/v1/internal/tcico/transfer/sof</code></h4></td></tr>
<tr><th><h3><strong>Response</strong></h3></th><td>
<table data-layout="default"><tbody><tr><th><p><strong>HTTP Status</strong></p></th><th><p><strong>Message</strong></p></th></tr>
<tr><td><p><code>200</code></p></td><td><p>OK <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">done</ac:parameter></ac:structured-macro></p></td></tr></tbody></table>
<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">json</ac:parameter><ac:parameter ac:name="wrap">false</ac:parameter><ac:plain-text-body><![CDATA[Response Success - 200
{ "a": "<x>" }

Response Unauthorized - 401
{ "b": 2 }]]></ac:plain-text-body></ac:structured-macro>
</td></tr></tbody></table>
<h2>[BACKEND][CORE-TCICO][TABUNGAN-MOTION] - Next Task</h2><p>after</p>`;

const TASK_MD = `# TAD - Sample

## [BACKEND][CORE-TCICO][TABUNGAN-MOTION] - Develop API Mobile Get Transfer Sof

<table data-table-width="1579" data-layout="center"><colgroup><col style="width: 272.0px;" /><col style="width: 1307.0px;" /></colgroup><tbody><tr><th data-highlight-colour="#f0f1f2"><h3><strong>Description</strong></h3></th><td><p>Endpoint <strong>&quot;Pilih Sumber Dana&quot;</strong> → SOF.</p><ul><li><p><strong>Routing:</strong></p></li></ul><ul><li><ul><li><p>Payload:</p><pre data-tlc-code="" data-tlc-params="wrap=true"><code>{&#10;  &quot;transaction_type&quot;: &quot;TRANSFER&quot;&#10;}</code></pre></li></ul></li></ul></td></tr><tr><th><h3><strong>Endpoint</strong></h3></th><td><h4><code>/v1/internal/tcico/transfer/sof</code></h4></td></tr><tr><th><h3><strong>Response</strong></h3></th><td><table data-layout="default"><tbody><tr><th><p><strong>HTTP Status</strong></p></th><th><p><strong>Message</strong></p></th></tr><tr><td><p><code>200</code></p></td><td><p>OK <span class="lozenge lozenge-green" data-tlc-status="Green">DONE</span></p></td></tr></tbody></table><pre data-tlc-code="json" data-tlc-params="wrap=false"><code>Response Success - 200&#10;{ &quot;a&quot;: &quot;&lt;x&gt;&quot; }&#10;&#10;Response Unauthorized - 401&#10;{ &quot;b&quot;: 2 }</code></pre></td></tr></tbody></table>

## [BACKEND][CORE-TCICO][TABUNGAN-MOTION] - Next Task

after
`;

const imported = () => TASK_MD;
const tableLine = (md: string) => md.split('\n').find((l) => l.startsWith('<table'))!;

describe('Detail Task tables imported from Confluence', () => {
  it('keep the whole table as one Markdown HTML block, even with blank lines in code', () => {
    const md = imported();
    const line = tableLine(md);
    expect(line).toContain('Response Unauthorized - 401');
    expect(line).not.toContain('<ac:');
    const section = md.slice(md.indexOf('## [BACKEND]'), md.indexOf('## [BACKEND]', md.indexOf('## [BACKEND]') + 5));
    expect(marked.lexer(section).filter((t) => t.type !== 'space').map((t) => t.type)).toEqual(['heading', 'html']);
  });

  it('preview shows the table once, with code, status and the inner table intact', () => {
    const div = document.createElement('div');
    div.innerHTML = renderPreview(imported()).html;
    // Not wrapped again in a generated task table; that is only built for the next, table-less task.
    expect(div.querySelectorAll('table.detail-task-table table')).toHaveLength(0);
    expect(div.querySelectorAll('table[data-table-width="1579"] table')).toHaveLength(1);
    const codes = [...div.querySelectorAll('pre[data-tlc-code] code')].map((c) => c.textContent);
    expect(codes).toEqual(['{\n  "transaction_type": "TRANSFER"\n}', 'Response Success - 200\n{ "a": "<x>" }\n\nResponse Unauthorized - 401\n{ "b": 2 }']);
    expect(div.querySelector('[data-tlc-status]')?.textContent).toBe('DONE');
    expect(div.textContent).not.toContain('wide');
    expect(div.querySelector('h2:last-of-type')?.textContent).toContain('Next Task');
  });

  it('converts rich editor detail task table to clean markdown #### sections', () => {
    const md = imported();
    const div = document.createElement('div');
    div.innerHTML = renderPreview(md).html;
    const converted = htmlToMarkdown(div);
    expect(converted).toContain('#### Description');
    expect(converted).toContain('#### Endpoint');
    expect(converted).toContain('#### Response');
    expect(converted).toContain('| **HTTP Status** | **Message** |');
    expect(converted).not.toContain('<table');
  });

  it('publishes the original code macros, parameters and status back to Confluence', () => {
    const { xhtml } = toConfluenceStorage(imported());
    expect(xhtml).not.toContain('data-tlc');
    expect(xhtml).toContain('<ac:parameter ac:name="wrap">true</ac:parameter><ac:plain-text-body><![CDATA[{\n  "transaction_type": "TRANSFER"\n}]]>');
    expect(xhtml).toContain('<ac:parameter ac:name="language">json</ac:parameter><ac:parameter ac:name="wrap">false</ac:parameter>');
    expect(xhtml).toContain('{ "a": "<x>" }\n\nResponse Unauthorized - 401');
    expect(xhtml).toContain('<ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">DONE</ac:parameter>');
    expect(xhtml).toContain('data-table-width="1579"');
  });
});

describe('normalizeEmbeddedHtml', () => {
  it('repairs drafts imported with the old format (macros + real newlines)', () => {
    const legacy = [
      '## [BACKEND] Task',
      '',
      '<table data-table-width="1579"><tbody><tr><th><h3>Description</h3></th><td><ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">json</ac:parameter><ac:plain-text-body><![CDATA[{',
      '',
      '  "a": 1',
      '}]]></ac:plain-text-body></ac:structured-macro><p><ac:link><ri:user ri:account-id="712020:abc" /></ac:link></p></td></tr></tbody></table>',
      '',
      'tail',
    ].join('\n');
    const fixed = normalizeEmbeddedHtml(legacy);
    expect(fixed.split('\n')).toHaveLength(5);
    expect(fixed).toContain('<pre data-tlc-code="json"><code>{&#10;&#10;  &quot;a&quot;: 1&#10;}</code></pre>');
    expect(fixed).toContain('<span data-tlc-user="712020:abc">@712020:abc</span>');
    expect(embeddedHtmlToStorage(fixed)).toContain('<ac:link><ri:user ri:account-id="712020:abc" /></ac:link>');
    expect(fixed.endsWith('\n\ntail')).toBe(true);
  });

  it('leaves Markdown without raw tables alone', () => {
    const md = '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(normalizeEmbeddedHtml(md)).toBe(md);
  });
});

describe('AI workspace form', () => {
  it('expands to one block per line and collapses back to exactly the same Markdown', async () => {
    const { expandEmbeddedHtml, collapseEmbeddedHtml } = await import('./embedded-html');
    const md = imported();
    const expanded = expandEmbeddedHtml(md);
    expect(expanded.split('\n').length).toBeGreaterThan(md.split('\n').length + 10);
    expect(expanded).toContain('Response Success - 200\n{ &quot;a&quot;: &quot;&lt;x&gt;&quot; }\n\nResponse Unauthorized - 401');
    expect(expanded).not.toContain('&#10;');
    expect(collapseEmbeddedHtml(expanded)).toBe(md);
  });

  it('accepts AI edits written across lines, with Confluence macros, and keeps code exact', async () => {
    const { collapseEmbeddedHtml } = await import('./embedded-html');
    const edited = [
      '## [BACKEND] New',
      '',
      '<table data-table-width="1579">',
      '  <tbody>',
      '    <tr><th><h3>Description</h3></th>',
      '      <td><p>Langkah',
      '      baru</p>',
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter><ac:plain-text-body><![CDATA[{',
      '  "x": 1',
      '}]]></ac:plain-text-body></ac:structured-macro>',
      '      </td></tr>',
      '  </tbody>',
      '</table>',
      '',
      'after',
    ].join('\n');
    const out = collapseEmbeddedHtml(edited);
    expect(out.split('\n')).toHaveLength(5);
    expect(out).toContain('<td><p>Langkah baru</p><pre data-tlc-code="json"><code>{&#10;  &quot;x&quot;: 1&#10;}</code></pre></td>');
  });
});
