import { describe, it, expect } from 'vitest';
import { appendChangeHistoryRow, buildChangelogPrompt } from './confluence-changelog.ts';

describe('confluence-changelog', () => {
  describe('buildChangelogPrompt', () => {
    it('creates initialization prompt for new pages', () => {
      const prompt = buildChangelogPrompt({
        title: 'TAD — Order Service',
        isNewPage: true,
      });
      expect(prompt).toContain('Dokumen TAD baru: "TAD — Order Service"');
      expect(prompt).toContain('inisiasi dokumen');
    });

    it('creates diff analysis prompt when changes are present', () => {
      const prompt = buildChangelogPrompt({
        title: 'TAD — Order Service',
        isNewPage: false,
        sectionsChanged: ['Development Scope', 'Detail Task: Backend'],
        diffSnippet: '+ Endpoint POST /api/v1/orders\n- Endpoint deprecated /orders',
      });
      expect(prompt).toContain('Dokumen: "TAD — Order Service"');
      expect(prompt).toContain('Development Scope');
      expect(prompt).toContain('Detail Task: Backend');
      expect(prompt).toContain('+ Endpoint POST /api/v1/orders');
    });
  });

  describe('appendChangeHistoryRow', () => {
    it('appends a new row to the Change History table in markdown', () => {
      const md = `# TAD - Auth
| **Change History** | | |
|---|---|---|
| Inisiasi dokumen | 2026-10-01 | @Alice |

## 1. Document Information
Isi informasi dokumen...`;

      const result = appendChangeHistoryRow(md, 'Update skema database auth', 'Bob');
      expect(result).toContain('| Update skema database auth |');
      expect(result).toContain('| @Bob |');
      expect(result).toContain('## 1. Document Information');
    });

    it('returns original markdown unchanged if no Change History table exists', () => {
      const md = `# TAD - Auth\n\n## 1. Document Information\nTanpa tabel history.`;
      const result = appendChangeHistoryRow(md, 'Update skema', 'Bob');
      expect(result).toBe(md);
    });
  });
});
