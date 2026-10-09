import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './html-to-markdown';
import { renderPreview } from './preview';

describe('htmlToMarkdown', () => {
  it('converts basic paragraphs and headings', () => {
    const html = `
      <h1>TAD - Motion Circle</h1>
      <p>This is an introduction paragraph with <strong>bold</strong>, <em>italic</em>, and <code>code</code>.</p>
      <h2>Objective</h2>
      <p>Objective details here.</p>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain('# TAD - Motion Circle');
    expect(md).toContain('This is an introduction paragraph with **bold**, _italic_, and `code`.');
    expect(md).toContain('## Objective');
    expect(md).toContain('Objective details here.');
  });

  it('converts tables with headers and cells', () => {
    const html = `
      <table>
        <thead>
          <tr><th>Service</th><th>Task</th><th>Jira</th></tr>
        </thead>
        <tbody>
          <tr><td>circle-backend</td><td>Setup API</td><td>PROJ-123</td></tr>
          <tr><td>circle-mobile</td><td>UI Slicing</td><td>PROJ-124</td></tr>
        </tbody>
      </table>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain('| Service | Task | Jira |');
    expect(md).toContain('|---|---|---|');
    expect(md).toContain('| circle-backend | Setup API | PROJ-123 |');
    expect(md).toContain('| circle-mobile | UI Slicing | PROJ-124 |');
  });

  it('converts callouts', () => {
    const html = `
      <div class="callout callout-info">
        <div class="callout-title">INFO</div>
        <p>Mohon perhatikan konvensi response API.</p>
      </div>
      <div class="callout callout-warning">
        <div class="callout-title">CAUTION</div>
        <p>Jangan ubah kolom DB tanpa migrasi.</p>
      </div>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain('> [!INFO]');
    expect(md).toContain('> Mohon perhatikan konvensi response API.');
    expect(md).toContain('> [!CAUTION]');
    expect(md).toContain('> Jangan ubah kolom DB tanpa migrasi.');
  });

  it('converts code blocks and mermaid diagrams', () => {
    const html = `
      <div class="code-block">
        <span class="code-lang">json</span>
        <pre><code>{"success": true}</code></pre>
      </div>
      <div class="mermaid-block" data-mermaid="0">
        <pre>sequenceDiagram\nClient->>Server: Request</pre>
      </div>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain('```json');
    expect(md).toContain('{"success": true}');
    expect(md).toContain('```mermaid');
    expect(md).toContain('sequenceDiagram');
  });

  it('converts bulleted and numbered lists', () => {
    const html = `
      <ul>
        <li>Item 1</li>
        <li>Item 2</li>
      </ul>
      <ol>
        <li>Step 1</li>
        <li>Step 2</li>
      </ol>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain('- Item 1');
    expect(md).toContain('- Item 2');
    expect(md).toContain('1. Step 1');
    expect(md).toContain('2. Step 2');
  });

  it('roundtrips renderPreview output back to markdown', () => {
    const original = `# TAD - Motion Circle

## Objective
Tujuan fitur ini adalah integrasi payment.

- Point satu
- Point dua

## Development Scope
| Service | Task | Jira |
|---|---|---|
| circle-be | [BACKEND][circle-be][MC-01] - Setup | MC-101 |

> [!INFO]
> Catatan penting.
`;

    const { html } = renderPreview(original);
    const converted = htmlToMarkdown(html);

    expect(converted).toContain('# TAD - Motion Circle');
    expect(converted).toContain('## Objective');
    expect(converted).toContain('Tujuan fitur ini adalah integrasi payment.');
    expect(converted).toContain('- Point satu');
    expect(converted).toContain('- Point dua');
    expect(converted).toContain('## Development Scope');
    expect(converted).toContain('| Service | Task | Jira |');
    expect(converted).toContain('| circle-be | [BACKEND][circle-be][MC-01] - Setup | MC-101 |');
    expect(converted).toContain('> [!INFO]');
    expect(converted).toContain('> Catatan penting.');
  });

  it('converts detail task tables to #### sections and formats inner tables cleanly', () => {
    const html = `
      <h2>[BACKEND][CORE-A][X] - Develop Task</h2>
      <table data-table-width="1688" data-layout="center">
        <colgroup><col style="width: 293.0px;" /><col style="width: 1395.0px;" /></colgroup>
        <tbody>
          <tr>
            <th data-highlight-colour="#f0f1f2"><h3>Description</h3></th>
            <td>
              <h3>Table: circle_activity</h3>
              <p>Jejak log aktivitas.</p>
              <table data-layout="default">
                <thead>
                  <tr><th>Column</th><th>Type</th></tr>
                </thead>
                <tbody>
                  <tr><td>id</td><td>bigint</td></tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain('## [BACKEND][CORE-A][X] - Develop Task');
    expect(md).toContain('#### Description');
    expect(md).toContain('### Table: circle_activity');
    expect(md).toContain('| Column | Type |');
    expect(md).toContain('| id | bigint |');
    expect(md).not.toContain('<table');
  });
});
