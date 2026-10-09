import type { PrdData } from '../prd/types';

export interface GenerateTadOptions {
  author?: string;
  codeName?: string;
  /** Figma links; defaults to the ones detected in the PRD. */
  figmaLinks?: { title?: string; url: string }[];
  /** File names of supporting documents (partner API docs, Figma exports…). */
  supportingDocs?: string[];
}

/** Placeholder marking sections the AI fills after analysing the codebase. */
export const AI_PENDING = 'TODO: diisi AI setelah menganalisa PRD, Figma, dokumen pendukung, dan codebase Services.';

function todayJakarta(): string {
  const d = new Date();
  const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

const DEVELOPMENT_SCHEMA = [
  'Branch utama yang digunakan adalah development, staging dan master. Development dan Staging akan auto deploy ke server dev dan staging. Sedangkan master akan manual deploy ke server production. Ketika akan develop task, branching dilakukan dari branch staging, buat branch baru dengan format: feature/[jira-number]- nama task',
  '',
  '**Example**: feature/[MU-01] – Initiate Project Krakend Ultimate',
  '',
  'Setelah developer mengerjakan task, PR wajib dilakukan dari branch feature developer ke development untuk di review TL. **Task di testing dan di done-kan di development environment**.',
  '',
  'Setelah task done dan masuk ke release list, code di push ke staging oleh TL dan QA melakukan integration/full cycle test di staging. Penemuan bugs di level ini, akan menciptakan Bugs Task di Jira pada sprint berjalan dan developer wajib menyelesaikan bugs task ini as high priority',
  '',
  'Jika proses fct di staging tidak ditemukan bugs, code di push ke master dan siap di deploy mengikuti Deployment SOP',
];

/** Escapes characters that would break a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/**
 * The parts of the TAD that follow directly from the PRD. Which services change, the
 * analysis, scope and task details are left to the AI, which reads the actual codebase:
 * guessing tasks from requirement titles produced fake APIs.
 */
export function generateTadSkeleton(prd: PrdData, opts: GenerateTadOptions = {}): string {
  const title = prd.metadata.title || 'Untitled';
  const codeName = opts.codeName || prd.metadata.codeName || title.toUpperCase().replace(/[^A-Z0-9]+/g, '-');
  const author = opts.author || prd.metadata.techLead || '@TechLead';
  const dateStr = todayJakarta();
  const figmaLinks = opts.figmaLinks ?? prd.figmaLinks;

  const reviewers = [
    prd.metadata.documentOwner ? `${prd.metadata.documentOwner} (Document Owner)` : null,
    prd.metadata.designer ? `${prd.metadata.designer} (Designer)` : null,
    prd.metadata.qa ? `${prd.metadata.qa} (QA)` : null,
  ].filter(Boolean).join('<br>') || 'TBD (Reviewer)';

  const lines: string[] = [];
  lines.push(`# TAD - ${title}`, '');

  lines.push('| **Document Information** |   |', '|---|---|');
  lines.push(`| Author | ${cell(author)} |`);
  lines.push(`| To Be Reviewed By | ${reviewers} |`);
  lines.push('| To Be Informed to | Developer<br>QA Engineer |');
  lines.push(`| Last Update | ${dateStr} |`);
  lines.push('| State | Initiate Document |');
  lines.push(`| Code Name | ${codeName} |`, '');

  lines.push('| **Change History** |   |   |', '|---|---|---|', '| **Description** | **Update Date** | **Updated By** |');
  lines.push(`| Inisiasi dokumen TAD berdasarkan PRD ${cell(title)} | ${dateStr} | ${cell(author)} |`, '');

  lines.push('# Objective', '');
  lines.push(prd.objective || `Membangun fitur ${title}.`, '');
  lines.push('Berdasarkan Objective di atas, perlu development:', '');
  lines.push(`1. ${AI_PENDING}`, '');

  lines.push('# Development Analysis', '');
  lines.push('## Architecture', '', AI_PENDING, '');
  lines.push('## Technology Stack', '', AI_PENDING, '');
  lines.push('## Development Schema', '', ...DEVELOPMENT_SCHEMA, '');

  lines.push('# Documentation', '');
  lines.push('|   | **Document Name** | **Attachment File** |', '|---|---|---|');
  let n = 1;
  lines.push(`| ${n++} | Test Cases Documentation | TBD |`);
  lines.push(`| ${n++} | PRD | PRD - ${cell(title)} |`);
  for (const f of figmaLinks) {
    const label = cell(f.title || `Figma - ${title}`);
    lines.push(`| ${n++} | ${label} | [${label}](${f.url}) |`);
  }
  for (const doc of opts.supportingDocs ?? []) lines.push(`| ${n++} | Dokumen pendukung | ${cell(doc)} |`);
  lines.push('');

  lines.push('# Development Scope', '', AI_PENDING, '');
  lines.push('# Detail Task', '', AI_PENDING, '');
  return lines.join('\n');
}

export function blankTad(title = 'Untitled'): string {
  const dummyPrd: PrdData = {
    metadata: {
      title,
      tribe: 'GLOBAL',
      targetRelease: '',
      epic: '',
      documentStatus: 'DRAFT',
      documentOwner: '',
      designer: '',
      techLead: '',
      qa: '',
      codeName: title.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'APP',
    },
    objective: `Membangun arsitektur teknis untuk ${title}.`,
    successMetrics: [],
    requirements: [
      {
        id: '1',
        userStory: `Sebagai pengguna, saya ingin menggunakan fitur ${title}`,
        keyword: title,
        requirement: `Fungsi utama ${title}`,
        interfaces: [],
      },
    ],
    figmaLinks: [],
    rawMarkdown: '',
  };
  return generateTadSkeleton(dummyPrd);
}
