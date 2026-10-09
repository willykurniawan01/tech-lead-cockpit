import { describe, expect, it } from 'vitest';
import { extractTadHeadings } from './headings';

describe('extractTadHeadings', () => {
  it('extracts standard headings with depth and line numbers', () => {
    const md = [
      '# TAD Title',
      '',
      'Some paragraph text here.',
      '',
      '## 1. Document Information',
      'Table content',
      '',
      '## 2. Objective',
      'Feature goals',
      '',
      '### 2.1 Scope Boundary',
      'What is out of scope',
      '',
      '## 3. Development Analysis',
      'Diagrams and domain context',
    ].join('\n');

    const headings = extractTadHeadings(md);
    expect(headings).toHaveLength(5);
    expect(headings[0]).toMatchObject({
      text: 'TAD Title',
      depth: 1,
      line: 1,
    });
    expect(headings[1]).toMatchObject({
      text: '1. Document Information',
      depth: 2,
      line: 5,
    });
    expect(headings[2]).toMatchObject({
      text: '2. Objective',
      depth: 2,
      line: 8,
    });
    expect(headings[3]).toMatchObject({
      text: '2.1 Scope Boundary',
      depth: 3,
      line: 11,
    });
    expect(headings[4]).toMatchObject({
      text: '3. Development Analysis',
      depth: 2,
      line: 14,
    });
  });

  it('ignores headings inside code fences and mermaid blocks', () => {
    const md = [
      '# Document Root',
      '',
      '```typescript',
      '# this is a comment inside code block',
      '## not a heading',
      '```',
      '',
      '```mermaid',
      'sequenceDiagram',
      '# mermaid comment',
      '```',
      '',
      '## Real Heading After Block',
    ].join('\n');

    const headings = extractTadHeadings(md);
    expect(headings).toHaveLength(2);
    expect(headings[0].text).toBe('Document Root');
    expect(headings[1].text).toBe('Real Heading After Block');
    expect(headings[1].line).toBe(13);
  });

  it('identifies task types like [BACKEND], [MOBILE-FE], and [WEB-FE]', () => {
    const md = [
      '## 6. Detail Task',
      '## [BACKEND][SVC-PAYMENT][PAY-01] - Create Payment Gateway API',
      '## [MOBILE-FE][APP-PAYMENT][PAY-02] - Slicing Payment Confirmation Screen',
      '## [WEB-FE][CMS-PORTAL][PAY-03] - CMS Transaction Settlement Table',
    ].join('\n');

    const headings = extractTadHeadings(md);
    expect(headings).toHaveLength(4);
    expect(headings[0].taskType).toBeUndefined();
    expect(headings[1].taskType).toBe('BACKEND');
    expect(headings[2].taskType).toBe('MOBILE-FE');
    expect(headings[3].taskType).toBe('WEB-FE');
  });

  it('handles empty input gracefully', () => {
    expect(extractTadHeadings('')).toEqual([]);
    expect(extractTadHeadings('   \n\n  ')).toEqual([]);
  });
});
