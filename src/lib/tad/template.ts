export interface TadSection {
  id: string;
  number?: number;
  title: string;
  guidance: string;
}

/**
 * Standard TAD sections (the team's TAD format).
 */
export const TAD_SECTIONS: TadSection[] = [
  { id: 'document-info', number: 1, title: 'Document Information', guidance: 'Metadata dokumen, Author, To Be Reviewed By, dan Change History.' },
  { id: 'objective', number: 2, title: 'Objective', guidance: 'Tujuan fitur, poin perubahan per service/komponen, dan batasan scope.' },
  { id: 'development-analysis', number: 3, title: 'Development Analysis', guidance: 'Architecture diagram, domain context, lifecycle status, konvensi response, dan SOP branching.' },
  { id: 'documentation', number: 4, title: 'Documentation', guidance: 'Tabel link dokumen acuan: Test Cases, PRD, dan Figma.' },
  { id: 'development-scope', number: 5, title: 'Development Scope', guidance: 'Tabel daftar seluruh task: Service Name, Task Name ([TYPE][SERVICE][CODENAME] - Name), dan Jira Task.' },
  { id: 'detail-task', number: 6, title: 'Detail Task', guidance: 'Detail tiap task (H2) dengan tabel 2 kolom: Description, Service, Endpoint, Method, Header, Payload, Response, atau UI Slicing.' },
];

export const TASK_TYPES = ['BACKEND', 'MOBILE-FE', 'WEB-FE'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export function normalizeTitle(title: string): string {
  return title
    .replace(/^\s*\d+[.)]?\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

const byNormalized = new Map(TAD_SECTIONS.map((s) => [normalizeTitle(s.title), s]));

export function findSection(headingText: string): TadSection | undefined {
  const norm = normalizeTitle(headingText);
  if (byNormalized.has(norm)) return byNormalized.get(norm);
  if (norm === 'documentinformation' || norm === 'changehistory') return TAD_SECTIONS[0];
  if (norm === 'objective') return TAD_SECTIONS[1];
  if (norm === 'developmentanalysis') return TAD_SECTIONS[2];
  if (norm === 'documentation') return TAD_SECTIONS[3];
  if (norm === 'developmentscope') return TAD_SECTIONS[4];
  if (norm === 'detailtask') return TAD_SECTIONS[5];
  return undefined;
}

export function normalizeTaskType(typeStr: string): TaskType | null {
  const t = typeStr.trim().toUpperCase().replace(/[\s/_-]+/g, '');
  if (t === 'BACKEND' || t === 'BE') return 'BACKEND';
  if (t === 'MOBILEFE' || t === 'FEMOBILE' || t === 'MOBILE') return 'MOBILE-FE';
  if (t === 'WEBFE' || t === 'CMSFE' || t === 'WEBCMSFE' || t === 'CMS' || t === 'FEWEB') return 'WEB-FE';
  return null;
}

export interface ParsedTaskTitle {
  raw: string;
  type: string;
  normalizedType: TaskType | null;
  service: string;
  codeName: string;
  name: string;
}

export function parseTaskTitle(title: string): ParsedTaskTitle | null {
  const clean = title.replace(/^\s*##\s*/, '').trim();
  const m = clean.match(/^\[([^\]]+)\]\[([^\]]+)\]\[([^\]]+)\]\s*[-–—]\s*(.+)$/);
  if (!m) return null;
  return {
    raw: clean,
    type: m[1].trim(),
    normalizedType: normalizeTaskType(m[1]),
    service: m[2].trim(),
    codeName: m[3].trim(),
    name: m[4].trim(),
  };
}

export function formatTaskTitle(type: TaskType, service: string, codeName: string, name: string): string {
  return `[${type}][${service}][${codeName}] - ${name}`;
}
