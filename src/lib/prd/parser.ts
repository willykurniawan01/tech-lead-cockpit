import type { PrdData, PrdFigmaLink, PrdMetadata, PrdMetric, PrdRequirement } from './types';

function cleanText(text: string): string {
  return text
    .replace(/^>\s*/gm, '') // remove blockquote markers
    // Confluence exports escape any Markdown punctuation, e.g. \- or \(Fase 1\)
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/^\s*\*\*|\*\*\s*$/g, '')
    .replace(/^\s*__|__\s*$/g, '')
    .trim();
}

function extractFigmaUrls(text: string): string[] {
  const urls: string[] = [];
  const regex = /https?:\/\/(?:www\.)?figma\.com\/[^\s)\]>"']+/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    urls.push(match[0].replace(/&amp;/g, '&'));
  }
  return [...new Set(urls)];
}

function parseMarkdownTable(tableText: string): string[][] {
  const lines = tableText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && l.endsWith('|'));
  if (lines.length < 2) return [];

  const rows: string[][] = [];
  for (const line of lines) {
    // Skip separator line (|---|---|...)
    if (/^\|(\s*:?-+:?\s*\|)+$/.test(line)) continue;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((c) => cleanText(c.trim()));
    rows.push(cells);
  }
  return rows;
}

export function parsePrd(markdown: string): PrdData {
  const lines = markdown.split('\n');

  // 1. Title
  let title = 'Untitled PRD';
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      title = cleanText(h1[1].replace(/^PRD\s*[-–—\\]*\s*/i, '').trim());
      break;
    }
  }

  // 2. Metadata
  const metadata: PrdMetadata = {
    title,
    tribe: '',
    targetRelease: '',
    epic: '',
    documentStatus: 'DRAFT',
    documentOwner: '',
    designer: '',
    techLead: '',
    qa: '',
    codeName: title.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  };

  // Find metadata key-value pairs (from table before ## Objective)
  const metaRegex = /\|\s*\*{0,2}(Tribe|Target release|Epic|Document status|Document owner|Designer|Tech lead|QA|Code name)\*{0,2}\s*\|\s*([^|]+)\s*\|/gi;
  let mMatch: RegExpExecArray | null;
  while ((mMatch = metaRegex.exec(markdown)) !== null) {
    const key = mMatch[1].toLowerCase().replace(/\s+/g, '');
    const val = cleanText(mMatch[2]);
    if (key.includes('tribe')) metadata.tribe = val;
    else if (key.includes('targetrelease')) metadata.targetRelease = val;
    else if (key.includes('epic')) metadata.epic = val;
    else if (key.includes('documentstatus')) metadata.documentStatus = val;
    else if (key.includes('documentowner')) metadata.documentOwner = val;
    else if (key.includes('designer')) metadata.designer = val;
    else if (key.includes('techlead')) metadata.techLead = val;
    else if (key.includes('qa')) metadata.qa = val;
    else if (key.includes('codename')) metadata.codeName = val;
  }

  // 3. Sections extraction
  const sections = new Map<string, string>();
  let currentHeading = '';
  let currentBuffer: string[] = [];

  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      if (currentHeading) {
        sections.set(currentHeading.toLowerCase().replace(/[^a-z0-9]+/g, ''), currentBuffer.join('\n').trim());
      }
      currentHeading = h[1].trim();
      currentBuffer = [];
    } else {
      currentBuffer.push(line);
    }
  }
  if (currentHeading) {
    sections.set(currentHeading.toLowerCase().replace(/[^a-z0-9]+/g, ''), currentBuffer.join('\n').trim());
  }

  // Objective
  const rawObjective = sections.get('objective') || '';
  const objective = cleanText(rawObjective);

  // Success Metrics
  const successMetrics: PrdMetric[] = [];
  const rawMetrics = sections.get('successmetrics') || '';
  if (rawMetrics) {
    const rows = parseMarkdownTable(rawMetrics);
    // Header is row 0: Goal, Metric
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length >= 2) {
        successMetrics.push({
          goal: row[0],
          metric: row[1],
        });
      }
    }
  }

  // Requirements
  const requirements: PrdRequirement[] = [];
  const rawReqs = sections.get('requirements') || '';
  if (rawReqs) {
    const rows = parseMarkdownTable(rawReqs);
    if (rows.length >= 2) {
      const header = rows[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
      const idIdx = header.findIndex((h) => h === '' || h === 'no' || h === 'id' || h === '#');
      const storyIdx = header.findIndex((h) => h.includes('story'));
      const keywordIdx = header.findIndex((h) => h.includes('keyword'));
      const reqIdx = header.findIndex((h) => h.includes('requirement'));
      const interfaceIdx = header.findIndex((h) => h.includes('interface') || h.includes('figma'));

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const id = (idIdx !== -1 && row[idIdx]) ? row[idIdx] : String(i);
        const userStory = (storyIdx !== -1 && row[storyIdx]) ? row[storyIdx] : '';
        const keyword = (keywordIdx !== -1 && row[keywordIdx]) ? row[keywordIdx] : '';
        const requirement = (reqIdx !== -1 && row[reqIdx]) ? row[reqIdx] : '';
        const ifaceCell = (interfaceIdx !== -1 && row[interfaceIdx]) ? row[interfaceIdx] : '';
        const interfaces = extractFigmaUrls(ifaceCell);

        if (keyword || requirement || userStory) {
          requirements.push({
            id,
            userStory,
            keyword,
            requirement,
            interfaces,
          });
        }
      }
    }
  }

  // Figma links throughout the PRD
  const allFigmaUrls = extractFigmaUrls(markdown);
  const figmaLinks: PrdFigmaLink[] = allFigmaUrls.map((url) => {
    // Try to find markdown label e.g. [Label](url)
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linkMatch = new RegExp(`\\[([^\\]]+)\\]\\(${escapedUrl}\\)`).exec(markdown);
    return {
      title: linkMatch ? linkMatch[1] : undefined,
      url,
    };
  });

  return {
    metadata,
    objective,
    successMetrics,
    requirements,
    figmaLinks,
    rawMarkdown: markdown,
  };
}
