import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AI_SELECTION, isAiSelection, type AiSelection } from '../src/lib/ai/types.ts';
import { startProviderRun } from './ai-providers.ts';

const TIMEOUT_MS = 30_000;

export const CHANGELOG_SYSTEM_PROMPT = [
  'Kamu adalah asisten Tech Lead yang bertugas membuat Catatan Versi (version comment / changelog) singkat untuk Technical Architecture Document (TAD) yang dipublish/update ke Confluence.',
  'Tulis catatan versi yang padat, akurat, dan profesional dalam Bahasa Indonesia.',
  'Panjang catatan: 1-2 kalimat ringkas atau 2-3 poin singkat (maksimal 200 karakter).',
  'Fokus pada inti perubahan teknis: service yang terpengaruh, endpoint baru/diubah, perubahan skema database, arsitektur, atau task yang disesuaikan.',
  'Keluarkan HANYA teks catatan versi langsung tanpa pembuka ("Berikut catatan...", "Changelog:"), tanpa tanda kutip, dan tanpa penjelasan tambahan.',
].join('\n');

export interface ChangelogInput {
  title: string;
  isNewPage?: boolean;
  sectionsChanged?: string[];
  diffSnippet?: string;
  ai?: AiSelection;
}

export function buildChangelogPrompt(input: ChangelogInput): string {
  if (input.isNewPage) {
    return `Dokumen TAD baru: "${input.title}". Tulis catatan versi inisiasi dokumen arsitektur awal (1 kalimat).`;
  }
  const sections = input.sectionsChanged?.length ? `Section yang berubah:\n- ${input.sectionsChanged.join('\n- ')}` : '';
  const diff = input.diffSnippet?.trim() ? `Cuplikan baris yang berubah (+ ditambah, - dihapus):\n${input.diffSnippet.slice(0, 3000)}` : '';
  return [
    `Dokumen: "${input.title}"`,
    sections,
    diff,
    'Tulis catatan versi singkat (1-2 kalimat) yang merangkum poin penting perubahan di atas untuk riwayat Confluence.',
  ].filter(Boolean).join('\n\n');
}

export { appendChangeHistoryRow } from '../src/lib/confluence/changelog.ts';

export async function generateConfluenceChangelog(input: ChangelogInput): Promise<string> {
  const prompt = buildChangelogPrompt(input);
  const cwd = await mkdtemp(join(tmpdir(), 'tlc-changelog-'));
  const ai = isAiSelection(input.ai) ? input.ai : DEFAULT_AI_SELECTION;
  try {
    const { reply, error } = await startProviderRun(ai, 'text', prompt, {
      cwd,
      timeoutMs: TIMEOUT_MS,
      systemPrompt: CHANGELOG_SYSTEM_PROMPT,
    }).done;
    if (error) throw new Error(error);
    if (!reply) throw new Error('AI tidak mengembalikan teks catatan versi.');
    return reply.replace(/^["'`]+|["'`]+$/g, '').trim();
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
