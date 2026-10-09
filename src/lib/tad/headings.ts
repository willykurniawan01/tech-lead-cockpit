export interface TadHeading {
  id: string;
  text: string;
  depth: number;
  line: number;
  taskType?: string;
  sectionId?: string;
}

const TASK_TYPE_REGEX = /^\[(BACKEND|BE|MOBILE[-_]?FE|WEB[-_]?FE|CMS[-_]?FE|FE|DEVOPS|QA)\]/i;

/**
 * Extracts headings (H1 to H4) from a Markdown document.
 * Correctly ignores headings inside fenced code blocks and Mermaid diagrams.
 */
export function extractTadHeadings(markdown: string): TadHeading[] {
  if (!markdown) return [];

  const lines = markdown.split('\n');
  const headings: TadHeading[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Check code fences
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Heading format: # Heading, ## Heading, ### Heading, #### Heading
    const match = rawLine.match(/^(#{1,4})\s+(.+)$/);
    if (!match) continue;

    const depth = match[1].length;
    let text = match[2].trim();
    // Strip trailing markdown hashes e.g. "## Title ##"
    text = text.replace(/\s+#+$/, '').trim();
    if (!text) continue;

    // Detect task type if format is [BACKEND] or [MOBILE-FE], etc.
    let taskType: string | undefined;
    const taskMatch = text.match(TASK_TYPE_REGEX);
    if (taskMatch) {
      taskType = taskMatch[1].toUpperCase();
    }

    // Detect section slug
    const cleanId = text
      .toLowerCase()
      .replace(/^[0-9]+[.)]\s*/, '')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    headings.push({
      id: `hd-${i + 1}`,
      text,
      depth,
      line: i + 1,
      taskType,
      sectionId: cleanId,
    });
  }

  return headings;
}
