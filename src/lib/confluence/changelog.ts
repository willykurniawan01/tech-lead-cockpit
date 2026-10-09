/** Helper functions for Confluence changelog / version notes and TAD Change History. */

/** Append a new row to the Change History table in markdown if present. */
export function appendChangeHistoryRow(markdown: string, description: string, author: string): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const authorStr = author ? `@${author}` : '@Tech Lead';
  const cleanDesc = description.replace(/\|/g, '-').trim();
  const newRow = `| ${cleanDesc} | ${dateStr} | ${authorStr} |`;

  // Matches Change History table up to the empty line or next heading
  const tableRegex = /(\|\s*(?:\*\*)?Change (?:History|Log)(?:\*\*)?\s*\|[\s\S]*?\|[-:\s|]+\|\n)([\s\S]*?)(?=\n\s*\n|\n#{1,6}\s|$)/i;
  const match = markdown.match(tableRegex);
  if (match) {
    const header = match[1];
    const rows = match[2].trimEnd();
    return markdown.replace(tableRegex, `${header}${rows}\n${newRow}\n`);
  }
  return markdown;
}
