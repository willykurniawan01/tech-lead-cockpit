/**
 * A heading written right after a table row on the same line ("| 13 | … | TBD |### Pemetaan …")
 * is not a heading to Markdown: the next table then reads as more rows of this one. AI output
 * does this now and then; the heading gets its own line back (with a blank line before it).
 */
export function separateGluedHeadings(markdown: string): string {
  return markdown.replace(/^(\|[^\n]*\|)[ \t]*(#{1,6}[ \t]+[^\n|]+)$/gm, '$1\n\n$2');
}
