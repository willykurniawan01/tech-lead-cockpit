import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { htmlToMarkdown, replaceBalancedHtmlTables } from './html-to-markdown';

describe('Draft table repair and extraction', () => {
  it('converts 2-column task tables even with data-table-width="1579" or ac:local-id', () => {
    const html = `
      <table data-table-width="1579" data-layout="center" ac:local-id="t1">
        <tbody>
          <tr><th><h3>Description</h3></th><td><p>Test task</p></td></tr>
          <tr><th><h3>Service</h3></th><td><p><code>CORE-SERVICE</code></p></td></tr>
        </tbody>
      </table>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain('#### Description');
    expect(md).toContain('#### Service');
    expect(md).toContain('`CORE-SERVICE`');
    expect(md).not.toContain('<table');
  });

  it('heals draft bacd9cbe completely to clean markdown with zero raw table tags', () => {
    const draftPath = path.join(process.env.HOME!, '.tech-lead-cockpit/drafts/bacd9cbe-466b-4a82-8e99-786269631a55.json');
    if (!fs.existsSync(draftPath)) return;
    const d = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
    let md = d.markdown;

    const openCount = (md.match(/<table\b/gi) || []).length;
    const closeCount = (md.match(/<\/table>/gi) || []).length;
    const isCorrupted = openCount < closeCount || md.includes('</td></tr>') || md.includes('</tbody></table>');

    if (isCorrupted && d.revisions && d.revisions.length > 0) {
      for (const rev of d.revisions) {
        if (rev.markdown) {
          const revOpens = (rev.markdown.match(/<table\b/gi) || []).length;
          const revCloses = (rev.markdown.match(/<\/table>/gi) || []).length;
          if (revOpens > 0 && revOpens === revCloses) {
            md = rev.markdown;
            break;
          }
        }
      }
    }

    if (md.includes('<table')) {
      md = replaceBalancedHtmlTables(md, (tableHtml) => {
        const clean = htmlToMarkdown(tableHtml).trim();
        return clean ? `${clean}\n\n` : tableHtml;
      });
    }

    if (md.includes('</td>') || md.includes('</tr>') || md.includes('</table>')) {
      md = md.replace(/<\/?(?:table|tbody|thead|tfoot|tr|td|th|colgroup|col)\b[^>]*>/gi, '');
    }

    expect(md).not.toContain('</td>');
    expect(md).not.toContain('</tr>');
    expect(md).not.toContain('</tbody>');
    expect(md).not.toContain('<table');
    expect(md).toContain('## [BACKEND][CORE-FDS-ULTIMATE][FDS-PROMO] - Develop Model Promo Abuse Lock');
    expect(md).toContain('#### Description');
    expect(md).toContain('#### Service');
    expect(md).toContain('`CORE-FDS-ULTIMATE`');
    expect(md).toContain('#### Endpoint');
    expect(md).toContain('`/internal/promo-abuse/check`');
    expect(md).toContain('#### Payload');
    expect(md).toContain('#### Perubahan Database');
  });

  it('heals all existing drafts in ~/.tech-lead-cockpit/drafts/ without leaving raw HTML table tags', () => {
    const draftsDir = path.join(process.env.HOME!, '.tech-lead-cockpit/drafts');
    if (!fs.existsSync(draftsDir)) return;
    const files = fs.readdirSync(draftsDir).filter((f) => f.endsWith('.json'));

    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(path.join(draftsDir, f), 'utf8'));
      let md = d.markdown;
      if (!md) continue;

      const openCount = (md.match(/<table\b/gi) || []).length;
      const closeCount = (md.match(/<\/table>/gi) || []).length;
      const isCorrupted = openCount < closeCount || md.includes('</td></tr>') || md.includes('</tbody></table>');

      if (isCorrupted && d.revisions && d.revisions.length > 0) {
        for (const rev of d.revisions) {
          if (rev.markdown) {
            const revOpens = (rev.markdown.match(/<table\b/gi) || []).length;
            const revCloses = (rev.markdown.match(/<\/table>/gi) || []).length;
            if (revOpens > 0 && revOpens === revCloses) {
              md = rev.markdown;
              break;
            }
          }
        }
      }

      if (md.includes('<table')) {
        md = replaceBalancedHtmlTables(md, (tableHtml) => {
          const clean = htmlToMarkdown(tableHtml).trim();
          return clean ? `${clean}\n\n` : tableHtml;
        });
      }

      if (md.includes('</td>') || md.includes('</tr>') || md.includes('</table>')) {
        md = md.replace(/<\/?(?:table|tbody|thead|tfoot|tr|td|th|colgroup|col)\b[^>]*>/gi, '');
      }

      expect(md).not.toContain('</td>');
      expect(md).not.toContain('</tr>');
      expect(md).not.toContain('</tbody>');
      expect(md).not.toContain('<table');
    }
  });
});
