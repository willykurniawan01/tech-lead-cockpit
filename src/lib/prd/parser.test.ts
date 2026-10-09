import { describe, expect, it } from 'vitest';
import { parsePrd } from './parser';
import * as fs from 'node:fs';

const SAMPLE_PRD = `# PRD - Motion Circle

| **Tribe** | GLOBAL |
| --- | --- |
| **Target release** | 2026-11-01 |
| **Epic** | PROJ-101 |
| **Document status** | DRAFT |
| **Document owner** | @Novskia |
| **Designer** | @Salman Faris Rifli |
| **Tech lead** | @Willy kurniawan |
| **QA** | @Reddy Kusuma Jaya |

## Objective

> Acme Circle menghubungkan 1 KTP dengan hingga 3 nomor handphone (1 Nomor Utama dan 2 Nomor Tambahan).
> Setiap Nomor Tambahan memiliki sub-wallet independen dalam satu ekosistem keluarga.

## Success Metrics

| **Goal** | **Metric** |
| --- | --- |
| Onboarding cepat | Nomor Utama dapat mengundang hingga 2 Nomor Tambahan |

## Requirements

|  | **User Story** | **Keyword** | **Requirement** | **Interface** |
| --- | --- | --- | --- | --- |
| 1 | as Nomor Utama | **Undang Account** | Sistem memvalidasi nomor | <https://www.figma.com/design/sample-invite> |
| 2 | as Nomor Utama | **Nomor Belum Terdaftar** | Modal error nomor belum terdaftar | |

## User interaction and design

<https://www.figma.com/design/sample-main>
`;

describe('parsePrd', () => {
  it('parses metadata, objective, and requirements correctly from sample', () => {
    const data = parsePrd(SAMPLE_PRD);
    expect(data.metadata.title).toBe('Motion Circle');
    expect(data.metadata.tribe).toBe('GLOBAL');
    expect(data.metadata.targetRelease).toBe('2026-11-01');
    expect(data.metadata.epic).toBe('PROJ-101');
    expect(data.metadata.documentOwner).toBe('@Novskia');
    expect(data.metadata.techLead).toBe('@Willy kurniawan');
    expect(data.metadata.codeName).toBe('MOTION-CIRCLE');

    expect(data.objective).toContain('Acme Circle menghubungkan 1 KTP');
    expect(data.successMetrics).toHaveLength(1);
    expect(data.successMetrics[0].goal).toBe('Onboarding cepat');

    expect(data.requirements).toHaveLength(2);
    expect(data.requirements[0].id).toBe('1');
    expect(data.requirements[0].keyword).toBe('Undang Account');
    expect(data.requirements[0].interfaces).toContain('https://www.figma.com/design/sample-invite');

    expect(data.figmaLinks.map((f) => f.url)).toContain('https://www.figma.com/design/sample-invite');
    expect(data.figmaLinks.map((f) => f.url)).toContain('https://www.figma.com/design/sample-main');
  });

  it('can parse actual PRD - Motion Circle.md if present', () => {
    const filePath = '/Users/willykurniawan/Documents/MTN & FM/Motion Circle/PRD - Motion Circle.md';
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = parsePrd(content);
      expect(data.metadata.title).toBe('Motion Circle');
      expect(data.metadata.tribe).toBe('GLOBAL');
      expect(data.metadata.documentOwner).toBe('@Novskia');
      expect(data.requirements.length).toBeGreaterThanOrEqual(15);
      expect(data.figmaLinks.length).toBeGreaterThan(0);
    }
  });

  it('unescapes Markdown punctuation from Confluence exports in the title and code name', () => {
    const data = parsePrd('# PRD \\- Promo Engine Core & CMS Acme \\(Fase 1\\)\n\n| **Tribe** | GLOBAL |\n| --- | --- |\n');
    expect(data.metadata.title).toBe('Promo Engine Core & CMS Acme (Fase 1)');
    expect(data.metadata.codeName).toBe('PROMO-ENGINE-CORE-CMS-ACME-FASE-1');
  });
});
