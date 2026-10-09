/**
 * Helper to synchronize Figma links and Partner/Supporting Documents
 * with the `# Documentation` table in a TAD markdown document.
 */

export interface DocSyncOptions {
  prdTitle?: string;
  figmaLinks?: { title?: string; url: string }[];
  supportingDocs?: { name: string; size?: number }[];
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/**
 * Updates or inserts the `# Documentation` section in the given TAD markdown.
 */
export function syncDocumentationSection(markdown: string, opts: DocSyncOptions): string {
  const prdTitle = opts.prdTitle || 'PRD';
  const figmaLinks = opts.figmaLinks ?? [];
  const supportingDocs = opts.supportingDocs ?? [];

  // Build the standardized table lines
  const tableLines: string[] = [
    '|   | **Document Name** | **Attachment File** |',
    '|---|---|---|',
    '| 1 | Test Cases Documentation | TBD |',
    `| 2 | PRD | PRD - ${escapeCell(prdTitle)} |`,
  ];

  let n = 3;
  for (const f of figmaLinks) {
    const label = escapeCell(f.title || `Figma - ${prdTitle}`);
    tableLines.push(`| ${n++} | ${label} | [${label}](${f.url}) |`);
  }

  for (const doc of supportingDocs) {
    const name = escapeCell(doc.name);
    tableLines.push(`| ${n++} | Dokumen Partner: ${name} | ${name} |`);
  }

  const newDocSection = `# Documentation\n\n${tableLines.join('\n')}\n`;

  // Look for existing # Documentation section (any heading level # or ##)
  const regex = /^#{1,3}\s+Documentation\b[^\n]*\n([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/im;
  if (regex.test(markdown)) {
    return markdown.replace(regex, `${newDocSection}\n`);
  }

  // If not found, insert before # Development Scope or at the end
  const scopeIdx = markdown.search(/^#{1,3}\s+Development Scope/im);
  if (scopeIdx >= 0) {
    return `${markdown.slice(0, scopeIdx)}${newDocSection}\n${markdown.slice(scopeIdx)}`;
  }

  return `${markdown.trimEnd()}\n\n${newDocSection}`;
}
