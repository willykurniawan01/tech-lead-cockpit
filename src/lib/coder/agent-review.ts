import type { MrFileChange, ReviewStrictness } from '../gitlab/types';
import { REVIEW_STRICTNESS_OPTIONS } from '../gitlab/types';
import type { ConformanceCheck } from '../tad/task-links';
import type { CoderAiReview, CoderReviewVerdict, CoderRun } from './types';

export interface BuildCoderReviewPromptOptions {
  run: CoderRun;
  diffFiles: MrFileChange[];
  spec?: string | { text?: string; fields?: Record<string, string> };
  conformanceChecks?: ConformanceCheck[];
  strictness?: ReviewStrictness;
  customInstruction?: string;
  maxDiffChars?: number;
}

/** Parses review verdict from the concluding section of the AI review output. */
export function extractReviewVerdict(reviewText: string): CoderReviewVerdict | undefined {
  if (!reviewText) return undefined;
  const tail = reviewText.slice(reviewText.search(/##\s*Kesimpulan/i) >= 0 ? reviewText.search(/##\s*Kesimpulan/i) : 0);
  
  if (/VERDICT:\s*REQUEST[_\s]+CHANGES/i.test(tail) || /\bREQUEST\s+CHANGES\b/i.test(tail)) {
    return 'REQUEST_CHANGES';
  }
  if (
    /VERDICT:\s*APPROVE[_\s]+WITH[_\s]+COMMENTS/i.test(tail) ||
    /\bAPPROVE\s+WITH\s+COMMENTS\b/i.test(tail)
  ) {
    return 'APPROVE_WITH_COMMENTS';
  }
  if (/VERDICT:\s*APPROVE\b/i.test(tail) || /\bAPPROVE\b/i.test(tail)) {
    return 'APPROVE';
  }
  return undefined;
}

/** Extracts actionable recommendations or changes requested to pre-fill the agent revise feedback. */
export function extractRecommendations(reviewText: string): string {
  if (!reviewText) return '';
  
  // Look for "## Rekomendasi Perbaikan" or "## Temuan Bug" section
  const recMatch = reviewText.match(/##\s*Rekomendasi\s+Perbaikan([\s\S]*?)(?=##\s*Kesimpulan|$)/i);
  if (recMatch && recMatch[1]?.trim()) {
    return recMatch[1].trim();
  }

  const bugMatch = reviewText.match(/##\s*Temuan\s+(?:Bug|Masalah)([\s\S]*?)(?=##\s*Kualitas|##\s*Rekomendasi|##\s*Kesimpulan|$)/i);
  if (bugMatch && bugMatch[1]?.trim()) {
    return bugMatch[1].trim();
  }

  // Fallback: take conclusion or last 800 chars
  const conclusionMatch = reviewText.match(/##\s*Kesimpulan([\s\S]*?)$/i);
  if (conclusionMatch && conclusionMatch[1]?.trim()) {
    return conclusionMatch[1].trim();
  }

  return reviewText.trim();
}

/** Builds prompt and context for reviewing AI agent code changes against TAD spec. */
export function buildCoderReviewPrompt(options: BuildCoderReviewPromptOptions): { prompt: string; context: string } {
  const {
    run,
    diffFiles,
    spec,
    conformanceChecks,
    strictness = 'standard',
    customInstruction,
    maxDiffChars = 150_000,
  } = options;

  const strictnessOpt =
    REVIEW_STRICTNESS_OPTIONS.find((s) => s.id === strictness) ?? REVIEW_STRICTNESS_OPTIONS[1];

  const totalAdditions = diffFiles.reduce((s, f) => s + (f.additions || 0), 0);
  const totalDeletions = diffFiles.reduce((s, f) => s + (f.deletions || 0), 0);

  const testStatus = run.test
    ? run.test.exitCode === 0
      ? `LULUS (exit 0) — ${run.test.command}`
      : `GAGAL (exit ${run.test.exitCode}) — ${run.test.command}\nOutput: ${run.test.output?.slice(-400) ?? '-'}`
    : 'Belum diuji';

  const promptLines = [
    `Lakukan Code Review mendalam terhadap perubahan kode (git diff) yang dikerjakan oleh AI Coding Agent untuk task ini.`,
    `Tugasmu adalah bertindak sebagai Staff Software Engineer & Tech Lead yang kritis, objektif, dan teliti.`,
    '',
    `INFORMASI TASK:`,
    `- Judul Task: ${run.taskTitle}`,
    `- Repository: ${run.repo}`,
    `- Branch: ${run.branch} (dari ${run.baseBranch} ➔ target MR ke ${run.targetBranch})`,
    `- Jira: ${run.jiraKey || '-'}`,
    `- Status Unit Test: ${testStatus}`,
    `- Total File Berubah: ${diffFiles.length} file (+${totalAdditions} / -${totalDeletions})`,
    '',
    `PEDOMAN KETELITIAN: ${strictnessOpt.instructions}`,
    customInstruction?.trim() ? `\nINSTRUKSI KHUSUS TECH LEAD:\n${customInstruction.trim()}\n` : '',
    '',
    'STRUKTUR LAPORAN REVIEW (Wajib dalam Bahasa Indonesia profesional):',
    '1. ## Ringkasan Perubahan: Gambaran fungsional singkat tentang apa yang dikerjakan agent dan apakah sesuai objektif task.',
    '2. ## Kesesuaian Spesifikasi TAD: Evaluasi apakah acceptance criteria, contracts/API, dan detail teknis di TAD telah dipenuhi dengan benar.',
    '3. ## Temuan Bug & Security: Logika cacat, null/nil pointer, missing error handling, validasi input, SQL injection, bypass otentikasi/otorisasi, race condition, atau kebocoran secret.',
    '4. ## Kualitas Kode & Best Practices: Clean code, penamaan, struktur arsitektur/SOLID, pemisahan layer, duplikasi (DRY), dan idiom bahasa/framework.',
    '5. ## Rekomendasi Perbaikan: Berikan instruksi perbaikan konkrit atau code snippet jika ada hal yang perlu diperbaiki.',
    '6. ## Kesimpulan & Verdict:',
    'Wajib cantumkan salah satu verdict tegas berikut di akhir kesimpulan:',
    '- VERDICT: APPROVE (Jika kode aman, memenuhi spesifikasi TAD, dan siap dipush ke MR)',
    '- VERDICT: APPROVE WITH COMMENTS (Jika kode aman untuk dipush, namun ada saran perbaikan minor non-blocking)',
    '- VERDICT: REQUEST CHANGES (Jika ada bug, celah security, kegagalan test, atau spesifikasi penting yang belum dipenuhi dan WAJIB direvisi oleh agent)',
  ];

  const prompt = promptLines.filter(Boolean).join('\n');

  // Context: TAD spec + Conformance + Agent reply + Diffs
  const contextParts: string[] = [];

  const specText =
    typeof spec === 'string'
      ? spec
      : spec?.text || (spec?.fields ? Object.entries(spec.fields).map(([k, v]) => `${k}: ${v}`).join('\n') : '');

  if (specText.trim()) {
    contextParts.push(`### SPESIFIKASI TASK DARI DOKUMEN TAD:\n${specText.trim().slice(0, 15_000)}`);
  }

  if (conformanceChecks && conformanceChecks.length > 0) {
    const checksList = conformanceChecks
      .map((c) => `- [${c.status.toUpperCase()}] ${c.label}: ${c.detail}`)
      .join('\n');
    contextParts.push(`### HASIL CEK KESESUAIAN OTOMATIS:\n${checksList}`);
  }

  if (run.reply?.trim()) {
    contextParts.push(`### CATATAN / RINGKASAN AGENT:\n${run.reply.trim().slice(0, 4_000)}`);
  }

  const fileSummary = diffFiles
    .map((f) => `- ${f.newPath} (+${f.additions || 0} -${f.deletions || 0})`)
    .join('\n');
  contextParts.push(`### DAFTAR FILE YANG DIUBAH:\n${fileSummary}`);

  let diffBody = '';
  let skipped = 0;
  for (const f of diffFiles) {
    if (!f.diff || f.truncated) continue;
    const block = `\n### File: ${f.newPath} (+${f.additions || 0} -${f.deletions || 0})\n\`\`\`diff\n${f.diff}\n\`\`\`\n`;
    if (diffBody.length + block.length > maxDiffChars) {
      skipped++;
      continue;
    }
    diffBody += block;
  }

  if (skipped > 0) {
    diffBody += `\n(${skipped} file diff lainnya tidak disertakan agar sesuai kapasitas context window)\n`;
  }

  contextParts.push(`### DIFF KODE:\n${diffBody || '(Tidak ada diff konten)'}`);

  const context = contextParts.join('\n\n');

  return { prompt, context };
}
