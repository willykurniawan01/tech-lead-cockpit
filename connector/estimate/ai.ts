import { roundEffort, ROLE_LABELS, type AiEffort, type Confidence, type EstimateRequest } from '../../src/lib/estimate/types.ts';

/**
 * Prompt and parser for the AI's effort proposal. The AI only suggests man-days, confidence and
 * dependencies; dates are computed by the scheduler, and the Tech Lead has the final say.
 */

const MAX_SPEC_CHARS = 80_000;
const MAX_CONTEXT_CHARS = 15_000;

export function buildEstimatePrompt(req: EstimateRequest, withCodebase: boolean): string {
  let budget = MAX_SPEC_CHARS;
  const tasks = req.tasks
    .map((t, i) => {
      const spec = t.spec.slice(0, Math.max(1_500, Math.floor(budget / Math.max(1, req.tasks.length - i))));
      budget -= spec.length;
      return `### ${i + 1}. ${t.title}\nTAD: ${t.tadTitle} · Role: ${ROLE_LABELS[t.role]} · Service: ${t.service || '-'}\n\n${spec || '(Detail Task belum ada)'}`;
    })
    .join('\n\n');
  return [
    `# Estimasi effort proyek: ${req.projectName}`,
    '',
    'Kamu Tech Lead senior. Estimasi effort setiap task di bawah dalam HARI KERJA (man-day) untuk satu developer dengan pengalaman menengah di stack tersebut. Task bisa berasal dari beberapa TAD dalam satu proyek; dependency boleh lintas TAD.',
    '',
    'Aturan:',
    '- Effort mencakup analisa kecil, coding, unit test, self-review, dan perbaikan dari code review untuk task itu. JANGAN memasukkan QA/UAT/deployment terpisah.',
    '- Gunakan kelipatan 0.5 hari. Task yang lebih dari 5 hari sebutkan alasannya dengan jelas.',
    withCodebase
      ? `- Codebase ada di folder "${req.servicesRoot}" (HANYA BACA, jangan mengubah apa pun). Periksa service/file yang relevan: apakah pola serupa sudah ada (lebih cepat) atau harus dibangun dari nol (lebih lama), kompleksitas integrasi, dan migrasi data. Jangan memindai seluruh codebase; baca yang relevan saja.`
      : '- Estimasi hanya dari isi TAD (codebase tidak tersedia); turunkan confidence bila detail kurang.',
    '- "confidence": high bila spesifikasi jelas dan pola sudah ada; medium bila ada sedikit ketidakpastian; low bila spesifikasi kurang atau ada integrasi/teknologi baru.',
    '- "dependsOn": nomor task lain yang harus selesai dulu sebelum task ini bisa dikerjakan, mis. FE integrasi API menunggu API backend, API menunggu model & migration. Hanya dependency nyata, bukan urutan preferensi.',
    '- "reason": 1–3 kalimat Bahasa Indonesia: komponen pekerjaan utama dan apa yang membuatnya lebih cepat/lambat.',
    '',
    'Jawab HANYA dengan satu objek JSON valid (tanpa teks lain, tanpa markdown fence):',
    '{"notes":"asumsi & risiko umum","tasks":[{"no":2,"title":"judul task","effortDays":2,"confidence":"medium","reason":"...","dependsOn":[1]}]}',
    '"no" dan "dependsOn" memakai NOMOR task dari daftar di bawah. Sertakan semua task.',
    '',
    req.context ? `## Konteks arsitektur (Development Analysis)\n${req.context.slice(0, MAX_CONTEXT_CHARS)}\n` : '',
    req.instructions?.trim() ? `## Instruksi tambahan dari Tech Lead\n${req.instructions.trim()}\n` : '',
    '## Task',
    tasks,
  ].join('\n');
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface ParsedEstimate {
  /** Keyed by task id; dependsOn holds task ids. */
  tasks: (AiEffort & { id: string; dependsOn: string[] })[];
  notes?: string;
}

/** Validates the AI's JSON against the requested tasks (in prompt order); unknown tasks and self-dependencies are dropped. */
export function parseEstimateReply(reply: string, tasks: { id: string; title: string }[]): ParsedEstimate {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = (fenced ?? reply).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Jawaban AI tidak berisi JSON.');
  let json: { tasks?: unknown; notes?: unknown };
  try {
    json = JSON.parse(text.slice(start, end + 1).replace(/,(\s*[}\]])/g, '$1'));
  } catch (e) {
    throw new Error(`JSON dari AI tidak valid: ${(e as Error).message}`);
  }
  // A title only identifies a task when no other task in the project has the same title.
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(norm(t.title), (counts.get(norm(t.title)) ?? 0) + 1);
  const byNorm = new Map(tasks.filter((t) => counts.get(norm(t.title)) === 1).map((t) => [norm(t.title), t.id]));
  // A task is referenced by its number in the prompt (1-based), or by title, possibly with the
  // number still in front ("7. [BACKEND]…").
  const resolve = (t: unknown): string | undefined => {
    if (typeof t === 'number') return Number.isInteger(t) ? tasks[t - 1]?.id : undefined;
    if (typeof t !== 'string') return undefined;
    if (/^\s*\d+\s*$/.test(t)) return tasks[Number(t) - 1]?.id;
    return byNorm.get(norm(t)) ?? byNorm.get(norm(t.replace(/^\s*(?:#+\s*)?\d+[.)]\s*/, '')));
  };
  const out: ParsedEstimate['tasks'] = [];
  for (const raw of Array.isArray(json.tasks) ? json.tasks : []) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = resolve(r.no) ?? resolve(r.title);
    const effort = Number(r.effortDays ?? r.effort ?? r.days);
    if (!id || !Number.isFinite(effort) || effort <= 0 || out.some((t) => t.id === id)) continue;
    const confidence: Confidence = r.confidence === 'high' || r.confidence === 'low' ? r.confidence : 'medium';
    const dependsOn = [...new Set((Array.isArray(r.dependsOn) ? r.dependsOn : []).map(resolve).filter((d): d is string => Boolean(d) && d !== id))];
    out.push({ id, effortDays: Math.min(60, roundEffort(effort)), confidence, reason: typeof r.reason === 'string' ? r.reason.trim().slice(0, 1_000) : '', dependsOn });
  }
  if (!out.length) throw new Error('AI tidak menghasilkan estimasi yang cocok dengan task di proyek.');
  return { tasks: out, notes: typeof json.notes === 'string' && json.notes.trim() ? json.notes.trim().slice(0, 5_000) : undefined };
}
