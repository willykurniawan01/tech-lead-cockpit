import { bugTicketTitle, profileForRepo, type BugAnalysis, type BugCase, type BugEvidence, type BugSeverity, type BugTask, type BugTaskProposal, type Confidence } from '../../src/lib/bugs/types.ts';

/**
 * Prompt and parser for the bug trace. The AI reads the report, the redacted logs (in logs/ of
 * its working folder) and, when allowed, the Services codebase read-only; it answers with JSON
 * that is validated here. It proposes a cause and a plan, it does not change code.
 */

export function buildBugPrompt(c: BugCase, opts: { servicesRoot?: string; logExcerpts: { name: string; excerpt: string }[]; instructions?: string }): string {
  const field = (label: string, v: string) => (v.trim() ? `${label}:\n${v.trim().slice(0, 8_000)}` : '');
  return [
    'Kamu Tech Lead / senior engineer yang menelusuri bug di sistem produksi. Tugasmu: temukan akar masalah (root cause) dengan bukti, lalu susun rencana perbaikan. JANGAN mengubah kode apa pun.',
    '',
    'Cara kerja:',
    '- Baca laporan bug di bawah dan file log di folder logs/ (sudah disamarkan; *** = data sensitif).',
    opts.servicesRoot
      ? `- Codebase semua service ada di "${opts.servicesRoot}" (HANYA BACA, satu folder per service). Telusuri dari petunjuk di log (endpoint, nama fungsi, pesan error, stack trace, kode error) ke file dan baris yang relevan. Jangan memindai seluruh codebase; ikuti jejak yang ada.`
      : '- Codebase tidak tersedia: analisa hanya dari laporan dan log; turunkan confidence.',
    '- Bedakan fakta (terlihat di log/kode) dan dugaan. Jika bukti tidak cukup, katakan di openQuestions, jangan mengarang.',
    '- Rencana fix harus minimal dan spesifik (file/fungsi yang diubah), plus test reproduksi yang gagal sebelum fix dan lulus sesudahnya.',
    '- Pecah perbaikan menjadi "tasks": SATU task per service/repo yang perlu diubah (mis. fix di backend + penyesuaian di portal FE = 2 task). Bila hanya satu repo yang perlu diubah, cukup satu task. Tiap task punya rencana fix dan test sendiri, serta judul & deskripsi tiket Jira yang bisa berdiri sendiri.',
    '- Judul tiket (jiraSummary tiap task) WAJIB mengikuti format task tim: "[TYPE][SERVICE][TECH-DEBT] - Fix <ringkasan>". TYPE: BACKEND, WEB-FE (portal/CMS/web), atau MOBILE-FE (aplikasi mobile). SERVICE: nama folder repo task itu dalam huruf besar. CODENAME untuk bug fix selalu TECH-DEBT.',
    '- Tulis dalam Bahasa Indonesia.',
    '',
    'Jawab HANYA dengan satu objek JSON valid (tanpa markdown fence):',
    '{"summary":"ringkas 1-2 kalimat","rootCause":"penjelasan akar masalah","confidence":"high|medium|low","severity":"critical|high|medium|low","services":["folder-service"],"repo":"folder-service utama yang perlu diperbaiki","evidence":[{"file":"folder-service/path/file.go","line":123,"note":"apa yang salah di sini"}],"logSignals":["baris log kunci"],"fixPlan":"ringkasan perbaikan keseluruhan","testPlan":"ringkasan test","openQuestions":["hal yang perlu dikonfirmasi"],"jiraSummary":"judul bug keseluruhan (maks 120 karakter)","jiraDescription":"konteks bug keseluruhan","tasks":[{"title":"judul task singkat","repo":"folder-service","profile":"backend|frontend","fixPlan":"langkah perbaikan di repo ini","testPlan":"test reproduksi & regresi di repo ini","jiraSummary":"[TYPE][SERVICE][TECH-DEBT] - Fix ... (maks 120 karakter)","jiraDescription":"deskripsi tiket: konteks, langkah reproduksi, expected/actual, root cause, rencana fix & test untuk repo ini"}]}',
    '',
    '## Laporan bug',
    `Judul: ${c.title}`,
    field('Deskripsi', c.description),
    field('Langkah reproduksi', c.steps),
    field('Yang diharapkan', c.expected),
    field('Yang terjadi', c.actual),
    field('Environment', c.environment),
    c.serviceHint.trim() ? `Petunjuk service: ${c.serviceHint.trim()}` : '',
    '',
    opts.logExcerpts.length
      ? `## Cuplikan log (lengkapnya di logs/)\n${opts.logExcerpts.map((l) => `### ${l.name}\n${l.excerpt}`).join('\n\n')}`
      : '## Log\n(tidak ada log)',
    opts.instructions?.trim() ? `\n## Instruksi tambahan dari Tech Lead\n${opts.instructions.trim()}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max: number, each: number) => (Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);
const FOLDER = /^[A-Za-z0-9._-]{1,100}$/;

const MAX_TASKS = 8;

/** The AI's tasks, checked against the real service folders; one task from the overall plan when it gave none. */
function parseTasks(raw: unknown, known: Set<string>, fallback: BugTaskProposal | undefined): BugTaskProposal[] {
  const tasks: BugTaskProposal[] = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    const r = (t ?? {}) as Record<string, unknown>;
    const repo = str(r.repo, 100);
    if (!FOLDER.test(repo) || (known.size && !known.has(repo.toLowerCase()))) continue;
    const fixPlan = str(r.fixPlan, 6_000);
    if (!fixPlan) continue;
    const title = str(r.title, 160) || str(r.jiraSummary, 160) || `Perbaikan di ${repo}`;
    const profile = r.profile === 'frontend' || r.profile === 'backend' ? r.profile : profileForRepo(repo);
    tasks.push({
      title,
      repo,
      profile,
      fixPlan,
      testPlan: str(r.testPlan, 4_000),
      jiraSummary: bugTicketTitle(str(r.jiraSummary, 250) || title, repo, profile),
      jiraDescription: str(r.jiraDescription, 12_000),
    });
    if (tasks.length >= MAX_TASKS) break;
  }
  return tasks.length ? tasks : fallback ? [fallback] : [];
}

export function parseBugReply(reply: string, knownServices: string[]): Omit<BugAnalysis, 'at' | 'ai' | 'touchedRepos'> {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = (fenced ?? reply).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Jawaban AI tidak berisi JSON.');
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text.slice(start, end + 1).replace(/,(\s*[}\]])/g, '$1'));
  } catch (e) {
    throw new Error(`JSON dari AI tidak valid: ${(e as Error).message}`);
  }
  const rootCause = str(j.rootCause, 6_000);
  if (!rootCause) throw new Error('AI tidak menyebutkan root cause.');
  const known = new Set(knownServices.map((s) => s.toLowerCase()));
  // Services must be real folders when we know them; otherwise keep plausible names.
  const services = list(j.services, 10, 100).filter((s) => FOLDER.test(s) && (!known.size || known.has(s.toLowerCase())));
  const repo = str(j.repo, 100);
  const evidence: BugEvidence[] = (Array.isArray(j.evidence) ? j.evidence : [])
    .map((e) => {
      const r = (e ?? {}) as Record<string, unknown>;
      const file = str(r.file, 300).replace(/^\/+/, '');
      const line = Number(r.line);
      return { file, line: Number.isInteger(line) && line > 0 ? line : undefined, note: str(r.note, 600) };
    })
    .filter((e) => e.file && !e.file.includes('..'))
    .slice(0, 20);
  const mainRepo = FOLDER.test(repo) && (!known.size || known.has(repo.toLowerCase())) ? repo : services[0];
  const fixPlan = str(j.fixPlan, 6_000);
  const testPlan = str(j.testPlan, 4_000);
  const jiraSummary = str(j.jiraSummary, 120) || str(j.summary, 120);
  const jiraDescription = str(j.jiraDescription, 12_000);
  const fallback =
    mainRepo && fixPlan
      ? { title: jiraSummary || `Perbaikan di ${mainRepo}`, repo: mainRepo, profile: profileForRepo(mainRepo), fixPlan, testPlan, jiraSummary: bugTicketTitle(jiraSummary || `Perbaikan di ${mainRepo}`, mainRepo, profileForRepo(mainRepo)), jiraDescription }
      : undefined;
  return {
    summary: str(j.summary, 600) || rootCause.slice(0, 200),
    rootCause,
    confidence: oneOf<Confidence>(j.confidence, ['high', 'medium', 'low'], 'medium'),
    severity: oneOf<BugSeverity>(j.severity, ['critical', 'high', 'medium', 'low'], 'medium'),
    services,
    repo: mainRepo,
    evidence,
    logSignals: list(j.logSignals, 15, 500),
    fixPlan,
    testPlan,
    openQuestions: list(j.openQuestions, 10, 400),
    jiraSummary,
    jiraDescription,
    tasks: parseTasks(j.tasks, known, fallback),
  };
}

/** What the coding agent gets for one fix task: the report, the analysis and this task's plan. */
export function bugFixSpec(c: BugCase, task: BugTask): string {
  const a = c.analysis;
  const others = c.tasks.filter((t) => t.id !== task.id);
  const lines = [
    `Bug: ${c.title}`,
    `Task: ${task.title} (repo ${task.repo})${task.jira ? ` · Jira ${task.jira.key}` : ''}`,
    c.environment ? `Environment: ${c.environment}` : '',
    c.description ? `\nDeskripsi:\n${c.description}` : '',
    c.steps ? `\nLangkah reproduksi:\n${c.steps}` : '',
    c.expected ? `\nYang diharapkan:\n${c.expected}` : '',
    c.actual ? `\nYang terjadi:\n${c.actual}` : '',
  ];
  if (a) {
    lines.push(
      `\nRoot cause (hasil tracing, confidence ${a.confidence}):\n${a.rootCause}`,
      a.evidence.length ? `\nBukti di kode:\n${a.evidence.map((e) => `- ${e.file}${e.line ? `:${e.line}` : ''}: ${e.note}`).join('\n')}` : '',
      a.logSignals.length ? `\nSinyal di log:\n${a.logSignals.map((l) => `- ${l}`).join('\n')}` : '',
    );
  }
  lines.push(
    task.fixPlan ? `\nRencana perbaikan untuk task ini:\n${task.fixPlan}` : '',
    task.testPlan ? `\nRencana test untuk task ini:\n${task.testPlan}` : '',
    others.length ? `\nTask lain untuk bug ini (dikerjakan terpisah, JANGAN dikerjakan di sini):\n${others.map((t) => `- ${t.title} (repo ${t.repo})`).join('\n')}` : '',
    a?.openQuestions.length ? `\nBelum terkonfirmasi (cek dulu, jangan berasumsi):\n${a.openQuestions.map((q) => `- ${q}`).join('\n')}` : '',
  );
  return lines.filter(Boolean).join('\n').slice(0, 40_000);
}
