import type { FindingKind, FindingSeverity, TraceConfidence, TraceEvidence, TraceFinding, TraceTurn } from '../../src/lib/trace/types.ts';

/**
 * Prompt and parser for a code trace. The AI answers a free question about existing code by
 * reading the Services codebase read-only and replies with JSON validated here. Evidence is
 * checked against the real files afterwards (verify.ts), so the parser keeps it unverified.
 */

const HISTORY_TURNS = 4;
const HISTORY_CHARS = 6_000;

export function buildTracePrompt(question: string, opts: { servicesRoot: string; history: TraceTurn[] }): string {
  const earlier = opts.history
    .filter((t) => t.status === 'done' && t.answer)
    .slice(-HISTORY_TURNS)
    .map((t) => `### Pertanyaan\n${t.question}\n### Jawaban\n${t.answer!.slice(0, HISTORY_CHARS)}`);
  return [
    'Kamu senior engineer yang menelusuri logic code yang SUDAH ADA untuk menjawab pertanyaan Tech Lead. JANGAN mengubah kode apa pun.',
    '',
    'Cara kerja:',
    `- Codebase semua service ada di "${opts.servicesRoot}" (HANYA BACA, satu folder per service). Cari titik masuk yang relevan (route/handler/consumer/cron), lalu ikuti alurnya ke service, repository/DB, dan panggilan eksternal. Jangan memindai seluruh codebase; ikuti jejaknya.`,
    '- Setiap klaim penting harus punya bukti file dan nomor baris yang benar-benar kamu baca. Path relatif terhadap folder Services (mis. core-payment/internal/refund/service.go). Bukti akan dicek ulang otomatis.',
    '- Bedakan fakta (terlihat di kode) dan dugaan. Jika tidak bisa dipastikan, tulis di openQuestions, jangan mengarang.',
    '- Kalau pertanyaannya tentang alur, buat diagram mermaid (sequenceDiagram atau flowchart) yang ringkas.',
    '- Kalau saat menelusuri kamu menemukan bug, risiko, atau celah logic, catat di findings walaupun tidak ditanyakan.',
    '- Tulis dalam Bahasa Indonesia. Jawaban (answer) dalam Markdown: mulai dengan ringkasan 1-3 kalimat, lalu penjelasan langkah demi langkah.',
    '',
    'Jawab HANYA dengan satu objek JSON valid (tanpa markdown fence):',
    '{"title":"judul singkat topik ini (maks 80 karakter)","answer":"markdown","confidence":"high|medium|low","services":["folder-service"],"diagram":"mermaid tanpa fence, atau string kosong","evidence":[{"file":"folder-service/path/file.go","line":123,"note":"apa yang terjadi di sini"}],"findings":[{"kind":"bug|risk|gap|question","severity":"critical|high|medium|low","title":"judul","detail":"penjelasan","file":"folder-service/path/file.go","line":45}],"openQuestions":["hal yang perlu dikonfirmasi"]}',
    '',
    earlier.length ? `## Percakapan sebelumnya di trace ini\n${earlier.join('\n\n')}\n` : '',
    '## Pertanyaan',
    question,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface ParsedTrace {
  title: string;
  answer: string;
  confidence: TraceConfidence;
  services: string[];
  diagram?: string;
  evidence: TraceEvidence[];
  findings: TraceFinding[];
  openQuestions: string[];
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max: number, each: number) => (Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max) : []);
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback);
const lineNo = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : undefined);
/** Relative path inside the Services root: no absolute paths, no `..`. */
export const SAFE_PATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[\w.@+-]+(\/[\w.@+-]+)*$/;

function jsonObject(reply: string): Record<string, unknown> {
  const text = reply.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Jawaban AI bukan JSON.');
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('Jawaban AI bukan JSON yang valid.');
  }
}

/** Strips the services root when the AI gave absolute paths anyway. */
function relPath(file: string, servicesRoot: string): string {
  const root = servicesRoot.replace(/\/+$/, '') + '/';
  return file.startsWith(root) ? file.slice(root.length) : file.replace(/^\.\//, '');
}

export function parseTraceReply(reply: string, servicesRoot: string): ParsedTrace {
  const o = jsonObject(reply);
  const answer = str(o.answer, 40_000);
  if (!answer) throw new Error('Jawaban AI tidak berisi penjelasan.');
  const evidence: TraceEvidence[] = [];
  for (const e of Array.isArray(o.evidence) ? o.evidence.slice(0, 40) : []) {
    const r = (e ?? {}) as Record<string, unknown>;
    const file = relPath(str(r.file, 400), servicesRoot);
    if (!SAFE_PATH.test(file)) continue;
    evidence.push({ file, line: lineNo(r.line), note: str(r.note, 1_000), verified: false });
  }
  const findings: TraceFinding[] = [];
  for (const f of Array.isArray(o.findings) ? o.findings.slice(0, 20) : []) {
    const r = (f ?? {}) as Record<string, unknown>;
    const title = str(r.title, 200);
    if (!title) continue;
    const file = relPath(str(r.file, 400), servicesRoot);
    findings.push({
      kind: oneOf<FindingKind>(r.kind, ['bug', 'risk', 'gap', 'question'], 'risk'),
      severity: oneOf<FindingSeverity>(r.severity, ['critical', 'high', 'medium', 'low'], 'medium'),
      title,
      detail: str(r.detail, 4_000),
      ...(file && SAFE_PATH.test(file) ? { file, line: lineNo(r.line) } : {}),
    });
  }
  const diagram = str(o.diagram, 8_000).replace(/^```(?:mermaid)?\s*/i, '').replace(/```$/, '').trim();
  return {
    title: str(o.title, 80),
    answer,
    confidence: oneOf<TraceConfidence>(o.confidence, ['high', 'medium', 'low'], 'medium'),
    services: list(o.services, 20, 100).filter((s) => /^[A-Za-z0-9._-]+$/.test(s)),
    ...(diagram ? { diagram } : {}),
    evidence,
    findings,
    openQuestions: list(o.openQuestions, 15, 1_000),
  };
}
