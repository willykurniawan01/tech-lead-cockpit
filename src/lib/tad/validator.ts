import type { PrdData } from '../prd/types';
import { findSection, normalizeTaskType, parseTaskTitle, TAD_SECTIONS, type TadSection } from './template';

export type Severity = 'error' | 'warning';

export type IssueCode =
  | 'missing-section'
  | 'empty-section'
  | 'missing-title'
  | 'duplicate-section'
  | 'placeholder'
  | 'invalid-task-name'
  | 'invalid-task-type'
  | 'task-missing-detail'
  | 'task-not-in-scope'
  | 'uncovered-requirement'
  | 'mermaid';

export interface Issue {
  severity: Severity;
  code: IssueCode;
  message: string;
  /** 1-based line in the Markdown source. */
  line: number;
  sectionId?: string;
}

export interface SectionStatus {
  section: TadSection;
  line?: number;
  status: 'ok' | 'warning' | 'error' | 'missing';
}

export interface ScopeTaskItem {
  id?: string;
  service?: string;
  taskTitle: string;
  line: number;
}

export interface DetailTaskItem {
  taskTitle: string;
  line: number;
  body: string;
}

export interface ValidationResult {
  issues: Issue[];
  sections: SectionStatus[];
  scopeTasks: ScopeTaskItem[];
  detailTasks: DetailTaskItem[];
  errorCount: number;
  warningCount: number;
}

export interface MermaidBlock {
  code: string;
  line: number;
}

const PLACEHOLDER = /\bTODO\b|\bTBD\b|<isi[^>]*>/;
const FENCE = /^\s*(```|~~~)/;

function cleanCell(cell: string): string {
  return cell.replace(/^\s*\*\*|\*\*\s*$/g, '').trim();
}

function normalizeTaskKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^##\s*/, '')
    .replace(/[^a-z0-9]+/g, '');
}

interface ScanData {
  hasTitle: boolean;
  sections: { section: TadSection; line: number; body: [number, string][] }[];
  mermaid: MermaidBlock[];
  scopeTasks: ScopeTaskItem[];
  detailTasks: DetailTaskItem[];
}

function scan(md: string): ScanData {
  const lines = md.split('\n');
  const sections: { section: TadSection; line: number; body: [number, string][] }[] = [];
  const mermaid: MermaidBlock[] = [];
  let hasTitle = false;
  let currentSection: { section: TadSection; line: number; body: [number, string][] } | null = null;
  let fence: { marker: string; lang: string; line: number; code: string[] } | null = null;

  lines.forEach((text, i) => {
    const line = i + 1;
    const fenceMatch = text.match(FENCE);
    if (fence) {
      if (fenceMatch && fenceMatch[1] === fence.marker) {
        if (fence.lang === 'mermaid') mermaid.push({ code: fence.code.join('\n'), line: fence.line });
        fence = null;
      } else {
        fence.code.push(text);
      }
      currentSection?.body.push([line, text]);
      return;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1], lang: text.trim().slice(3).trim().toLowerCase(), line, code: [] };
      currentSection?.body.push([line, text]);
      return;
    }

    if (/^#\s+\S/.test(text)) {
      hasTitle = true;
      const matched = findSection(text.replace(/^#\s+/, ''));
      if (matched) {
        currentSection = { section: matched, line, body: [] };
        sections.push(currentSection);
        return;
      }
    }

    // Check if table contains Document Information
    if (/\|\s*\*{0,2}Document Information\*{0,2}\s*\|/i.test(text)) {
      const docInfoSec = TAD_SECTIONS.find((s) => s.id === 'document-info')!;
      if (!sections.some((s) => s.section.id === 'document-info')) {
        currentSection = { section: docInfoSec, line, body: [] };
        sections.push(currentSection);
      }
    }

    const h2 = text.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h2) {
      const sec = findSection(h2[1]);
      // If this is a main section heading
      if (sec && sec.id !== 'detail-task') {
        currentSection = { section: sec, line, body: [] };
        sections.push(currentSection);
        return;
      }
    }

    currentSection?.body.push([line, text]);
  });

  // Extract Development Scope tasks and Detail tasks
  const scopeTasks: ScopeTaskItem[] = [];
  const detailTasks: DetailTaskItem[] = [];

  const scopeSec = sections.find((s) => s.section.id === 'development-scope');
  if (scopeSec) {
    let inTable = false;
    let taskColIdx = -1;
    let serviceColIdx = -1;

    for (const [line, text] of scopeSec.body) {
      const trimmed = text.trim();
      if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed
          .slice(1, -1)
          .split('|')
          .map((c) => cleanCell(c));
        // Check header row
        if (!inTable) {
          const norm = cells.map((c) => c.toLowerCase().replace(/[^a-z0-9]/g, ''));
          taskColIdx = norm.findIndex((c) => c.includes('taskname') || c === 'task');
          serviceColIdx = norm.findIndex((c) => c.includes('servicename') || c === 'service');
          if (taskColIdx !== -1) {
            inTable = true;
            continue;
          }
        } else {
          // Skip divider row
          if (/^(\s*:?-+:?\s*)+$/.test(cells.join(''))) continue;
          if (taskColIdx !== -1 && cells[taskColIdx]) {
            const rawTask = cells[taskColIdx].replace(/<[^>]+>/g, '').trim();
            if (rawTask && !rawTask.toLowerCase().includes('task name')) {
              scopeTasks.push({
                taskTitle: rawTask,
                service: serviceColIdx !== -1 ? cells[serviceColIdx] : undefined,
                line,
              });
            }
          }
        }
      } else {
        if (inTable && trimmed === '') {
          // Table ended
          inTable = false;
        }
      }
    }
  }

  // Find detail tasks (H2 headings under Detail Task or overall matching task format)
  const detailSec = sections.find((s) => s.section.id === 'detail-task');
  if (detailSec) {
    let currentTask: { taskTitle: string; line: number; bodyLines: string[] } | null = null;
    for (const [line, text] of detailSec.body) {
      const h2Match = text.match(/^##\s+(.+)$/);
      if (h2Match && (h2Match[1].startsWith('[') || parseTaskTitle(h2Match[1]))) {
        if (currentTask) {
          detailTasks.push({
            taskTitle: currentTask.taskTitle,
            line: currentTask.line,
            body: currentTask.bodyLines.join('\n'),
          });
        }
        currentTask = {
          taskTitle: h2Match[1].trim(),
          line,
          bodyLines: [],
        };
      } else {
        currentTask?.bodyLines.push(text);
      }
    }
    if (currentTask) {
      detailTasks.push({
        taskTitle: currentTask.taskTitle,
        line: currentTask.line,
        body: currentTask.bodyLines.join('\n'),
      });
    }
  }

  return { hasTitle, sections, mermaid, scopeTasks, detailTasks };
}

export function extractMermaidBlocks(md: string): MermaidBlock[] {
  return scan(md).mermaid;
}

export function validateTad(md: string, prd?: PrdData): ValidationResult {
  const { hasTitle, sections, scopeTasks, detailTasks } = scan(md);
  const issues: Issue[] = [];

  if (!hasTitle) {
    issues.push({
      severity: 'warning',
      code: 'missing-title',
      message: 'Tidak ada judul H1 (# Judul). Judul dipakai sebagai nama halaman Confluence.',
      line: 1,
    });
  }

  const seenSections = new Map<string, { section: TadSection; line: number; body: [number, string][] }>();
  for (const s of sections) {
    if (seenSections.has(s.section.id)) {
      issues.push({
        severity: 'warning',
        code: 'duplicate-section',
        message: `Section "${s.section.title}" muncul lebih dari sekali.`,
        line: s.line,
        sectionId: s.section.id,
      });
      continue;
    }
    seenSections.set(s.section.id, s);

    const content = s.body.filter(([, t]) => t.trim() && !/^<!--.*-->$/.test(t.trim()));
    if (!content.length) {
      issues.push({
        severity: 'error',
        code: 'empty-section',
        message: `Section "${s.section.title}" masih kosong.`,
        line: s.line,
        sectionId: s.section.id,
      });
    }

    for (const [line, text] of s.body) {
      if (PLACEHOLDER.test(text)) {
        issues.push({
          severity: 'warning',
          code: 'placeholder',
          message: `Placeholder belum diisi: ${text.trim().slice(0, 90)}`,
          line,
          sectionId: s.section.id,
        });
      }
    }
  }

  // Check required sections
  for (const s of TAD_SECTIONS) {
    if (!seenSections.has(s.id)) {
      issues.push({
        severity: 'error',
        code: 'missing-section',
        message: `Section wajib tidak ada: ${s.title}`,
        line: 1,
        sectionId: s.id,
      });
    }
  }

  // Validate tasks in Development Scope
  const detailKeyMap = new Map<string, DetailTaskItem>();
  for (const dt of detailTasks) {
    detailKeyMap.set(normalizeTaskKey(dt.taskTitle), dt);
  }

  const scopeKeyMap = new Map<string, ScopeTaskItem>();
  for (const st of scopeTasks) {
    const parsed = parseTaskTitle(st.taskTitle);
    if (!parsed) {
      issues.push({
        severity: 'warning',
        code: 'invalid-task-name',
        message: `Format nama task harus [TYPE][SERVICE][CODENAME] - Name: "${st.taskTitle}"`,
        line: st.line,
        sectionId: 'development-scope',
      });
    } else if (!parsed.normalizedType) {
      issues.push({
        severity: 'error',
        code: 'invalid-task-type',
        message: `Tipe task "${parsed.type}" tidak valid. Harus salah satu dari: BACKEND, MOBILE-FE, WEB-FE.`,
        line: st.line,
        sectionId: 'development-scope',
      });
    }

    const key = normalizeTaskKey(st.taskTitle);
    scopeKeyMap.set(key, st);

    // Rule: Every task in Development Scope MUST have a Detail Task
    if (!detailKeyMap.has(key)) {
      // Check partial match
      const matched = [...detailKeyMap.keys()].some((k) => k.includes(key) || key.includes(k));
      if (!matched) {
        issues.push({
          severity: 'error',
          code: 'task-missing-detail',
          message: `Task "${st.taskTitle}" di Development Scope belum memiliki Detail Task.`,
          line: st.line,
          sectionId: 'detail-task',
        });
      }
    }
  }

  // Rule: Check if any Detail Task is missing from Development Scope
  for (const dt of detailTasks) {
    const key = normalizeTaskKey(dt.taskTitle);
    if (!scopeKeyMap.has(key)) {
      const matched = [...scopeKeyMap.keys()].some((k) => k.includes(key) || key.includes(k));
      if (!matched) {
        issues.push({
          severity: 'warning',
          code: 'task-not-in-scope',
          message: `Detail Task "${dt.taskTitle}" tidak terdaftar di tabel Development Scope.`,
          line: dt.line,
          sectionId: 'development-scope',
        });
      }
    }
  }

  // Rule: Every PRD requirement must be covered by at least one task
  if (prd && prd.requirements.length > 0) {
    const allTaskTexts = [
      ...scopeTasks.map((t) => t.taskTitle),
      ...detailTasks.map((t) => `${t.taskTitle} ${t.body}`),
    ].join('\n').toLowerCase();

    for (const req of prd.requirements) {
      const idMatch = new RegExp(`\\b(req[-_ ]*0*${req.id}|requirement\\s*0*${req.id})\\b`, 'i');
      const kwMatch = req.keyword && req.keyword.length > 2
        ? allTaskTexts.includes(req.keyword.toLowerCase())
        : false;

      const isCovered = idMatch.test(allTaskTexts) || kwMatch;

      if (!isCovered) {
        issues.push({
          severity: 'warning',
          code: 'uncovered-requirement',
          message: `Requirement PRD #${req.id} ("${req.keyword || 'Req ' + req.id}") belum tercakup oleh task manapun di TAD.`,
          line: 1,
          sectionId: 'development-scope',
        });
      }
    }
  }

  return summarize(issues, sections, scopeTasks, detailTasks);
}

export async function validateMermaid(md: string, parse: (code: string) => Promise<void>): Promise<Issue[]> {
  const { mermaid, sections } = scan(md);
  const issues: Issue[] = [];
  for (const block of mermaid) {
    try {
      await parse(block.code);
    } catch (e) {
      const owner = [...sections].reverse().find((s) => s.line < block.line);
      const reason = e instanceof Error ? e.message.split('\n')[0] : String(e);
      issues.push({
        severity: 'error',
        code: 'mermaid',
        message: `Diagram Mermaid tidak valid: ${reason}`,
        line: block.line,
        sectionId: owner?.section.id,
      });
    }
  }
  return issues;
}

export function mergeIssues(base: ValidationResult, extra: Issue[]): ValidationResult {
  if (!extra.length) return base;
  const located = base.sections.filter((s) => s.line !== undefined);
  return summarize(
    [...base.issues, ...extra],
    located.map((s) => ({ section: s.section, line: s.line! })),
    base.scopeTasks,
    base.detailTasks
  );
}

function summarize(
  issues: Issue[],
  sections: { section: TadSection; line: number }[],
  scopeTasks: ScopeTaskItem[],
  detailTasks: DetailTaskItem[]
): ValidationResult {
  issues.sort((a, b) => a.line - b.line || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const lineOf = new Map<string, number>();
  for (const s of sections) if (!lineOf.has(s.section.id)) lineOf.set(s.section.id, s.line);

  const statuses: SectionStatus[] = TAD_SECTIONS.map((section) => {
    const line = lineOf.get(section.id);
    if (line === undefined) return { section, status: 'missing' };
    const own = issues.filter((i) => i.sectionId === section.id);
    const status = own.some((i) => i.severity === 'error') ? 'error' : own.length ? 'warning' : 'ok';
    return { section, line, status };
  });

  return {
    issues,
    sections: statuses,
    scopeTasks,
    detailTasks,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
  };
}
