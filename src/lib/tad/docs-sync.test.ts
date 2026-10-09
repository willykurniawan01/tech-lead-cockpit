import { describe, it, expect } from 'vitest';
import { syncDocumentationSection } from './docs-sync';

describe('syncDocumentationSection', () => {
  it('updates existing # Documentation section', () => {
    const md = `# TAD - Feature X

# Documentation

|   | **Document Name** | **Attachment File** |
|---|---|---|
| 1 | Test Cases | TBD |

# Development Scope

| No | Service | Task |
|---|---|---|
| 1 | Svc | Task 1 |
`;

    const updated = syncDocumentationSection(md, {
      prdTitle: 'Feature X',
      figmaLinks: [{ title: 'Figma UI', url: 'https://figma.com/file/123' }],
      supportingDocs: [{ name: 'partner-spec.yaml' }],
    });

    expect(updated).toContain('[Figma UI](https://figma.com/file/123)');
    expect(updated).toContain('partner-spec.yaml');
    expect(updated).toContain('# Development Scope');
  });

  it('inserts # Documentation before # Development Scope if missing', () => {
    const md = `# TAD - Feature Y

# Objective

Fitur baru

# Development Scope

| No | Service | Task |
`;

    const updated = syncDocumentationSection(md, {
      prdTitle: 'Feature Y',
      figmaLinks: [{ url: 'https://figma.com/file/abc' }],
    });

    expect(updated).toContain('# Documentation');
    expect(updated).toContain('https://figma.com/file/abc');
    expect(updated.indexOf('# Documentation')).toBeLessThan(updated.indexOf('# Development Scope'));
  });
});
