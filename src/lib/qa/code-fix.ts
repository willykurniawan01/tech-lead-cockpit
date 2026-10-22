import type { QAAssertion, QAFlow, QAFlowResult, QAStepResult } from './types';

/**
 * "Perbaiki kode" from a failed E2E test case: a bug-fix coder run (background, own clone, review +
 * Push as usual) whose spec is the failed request/response, without a Bug Tracing case or Jira ticket.
 * The runs are listed under one pseudo draft per project, like a bug's runs under `bug-<id>`.
 */

export const e2eDraftId = (projectId: string) => `e2e-${projectId}`;

const FAILED = new Set(['failed', 'error', 'blocked']);
const BODY_LIMIT = 3_000;
const TASK_SPEC_LIMIT = 8_000;

const clip = (text: string | undefined, max: number) => {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}\n… (dipotong)` : t;
};

/** The step that failed first: the one to fix. */
export const failedStep = (result: QAFlowResult): QAStepResult | undefined => result.steps.find((s) => FAILED.has(s.status));

/** Service of the failed step (as named in the test), to pick the repo. */
export function failingService(flow: QAFlow, result: QAFlowResult): string | undefined {
  const step = failedStep(result);
  return flow.steps.find((s) => s.id === step?.stepId)?.service ?? flow.steps.find((s) => s.service)?.service;
}

export interface CodeFixInput {
  flow: QAFlow;
  result: QAFlowResult;
  projectName: string;
  envName: string;
  runAt: string;
  repo: string;
  /** Detail Task specs of the flow's TAD tasks (title → spec). */
  taskSpecs?: { title: string; spec: string }[];
  note?: string;
}

/** Title for the coder run; the [..] tags are left out of its branch, which becomes fix/<test case name>. */
export const codeFixTitle = (flow: QAFlow, repo: string) => `[BUGFIX][${repo.toUpperCase()}][E2E] - ${flow.name}`.slice(0, 300);

/** An assertion as one readable line, for steps the run never got to check. */
export function describeAssertion(a: QAAssertion): string {
  const v = (x: unknown) => (x === undefined ? '' : ` ${JSON.stringify(x)}`);
  switch (a.type) {
    case 'status':
      return `status ${a.op === 'in' ? 'salah satu dari' : '='}${v(a.expected)}`;
    case 'json':
      return `${a.path} ${a.op}${v(a.expected)}`;
    case 'header':
      return `header ${a.name} ${a.op}${v(a.expected)}`;
    case 'latency':
      return `waktu respons < ${a.expected} ms`;
    case 'db':
      return `DB ${a.db}${a.column ? `.${a.column}` : ''} ${a.op}${v(a.expected)} (${clip(a.sql, 300)})`;
  }
}

/**
 * What one failed test case says: the failed step with its request/response and unmet checks, and
 * the steps after it that were skipped. Those were never checked, so they are just as likely to be
 * wrong in the code: the agent fixes them in the same run instead of one rerun per step.
 */
function failureLines(flow: QAFlow, result: QAFlowResult, withDefinition: boolean): string[] {
  const step = failedStep(result);
  const def = flow.steps.find((s) => s.id === step?.stepId);
  const at = step ? result.steps.indexOf(step) : -1;
  const passedBefore = result.steps.slice(0, Math.max(0, at)).filter((s) => s.status === 'passed');
  const unchecked = result.steps.slice(at + 1).filter((s) => s.status === 'skipped' || s.status === 'pending');
  const lines: string[] = [
    flow.stage ? `Grup/tahap journey: ${flow.stage}` : '',
    flow.taskTitles.length ? `Task TAD terkait: ${flow.taskTitles.join(' · ')}` : '',
    flow.description ? `Tujuan test case:\n${flow.description}` : '',
  ];
  if (step) {
    lines.push(
      `\nStep yang gagal: ${step.name}${def?.service ? ` (service ${def.service})` : ''}`,
      step.request ? `Request: ${step.request.method} ${step.request.url}` : def ? `Request: ${def.request.method} ${def.request.path}` : '',
      step.request?.body ? `Body request:\n${clip(step.request.body, BODY_LIMIT)}` : '',
      step.response ? `Response: HTTP ${step.response.status}\n${clip(step.response.body, BODY_LIMIT)}` : 'Response: tidak ada (request tidak sampai / error sebelum response).',
      step.error ? `Error: ${step.error}` : '',
    );
    const failedChecks = [...step.assertions.filter((a) => !a.passed).map((a) => a.message), ...(step.dbChecks ?? []).filter((d) => !d.ok).map((d) => `DB ${d.db} (${d.label}): ${d.error ?? 'hasil tidak sesuai'}`)];
    if (failedChecks.length) lines.push(`Yang diharapkan test tapi tidak terpenuhi:\n${failedChecks.map((m) => `- ${m}`).join('\n')}`);
  } else {
    lines.push(`\nStatus flow: ${result.status} (tidak ada step yang tercatat gagal).`);
  }
  if (unchecked.length) {
    lines.push(`\nStep berikut BELUM DIUJI (dilewati karena step di atas gagal). Periksa juga ekspektasinya di kode dan perbaiki sekaligus bila kodenya belum memenuhi:`);
    for (const r of unchecked) {
      const d = flow.steps.find((s) => s.id === r.stepId);
      if (!d) continue;
      lines.push(
        `- ${d.name}: ${d.request.method} ${d.request.path}${d.service ? ` (service ${d.service})` : ''}`,
        d.request.body !== undefined ? `  Body: ${clip(JSON.stringify(d.request.body), 1_500)}` : '',
        d.assertions.length ? `  Diharapkan: ${d.assertions.map(describeAssertion).join('; ')}` : '',
      );
    }
  }
  if (passedBefore.length) lines.push(`\nStep sebelumnya yang lulus: ${passedBefore.map((s) => s.name).join(' → ')}`);
  if (withDefinition) {
    lines.push(`\nDefinisi test case (urutan step dan assertion, JSON):\n${clip(JSON.stringify(flow.steps.map(({ id: _id, request: { headers: _h, ...request }, ...s }) => ({ ...s, request })), null, 2), 10_000)}`);
  }
  return lines;
}

const howToWork = (repo: string, many: boolean) => [
  '',
  'Cara kerja:',
  `1. Untuk ${many ? 'setiap test case dan setiap step' : 'setiap step'} di atas, pastikan dulu kegagalan/ekspektasinya memang soal kode ${repo} (bandingkan dengan Detail Task TAD, struct request, router, dan handler). Bila ternyata test-nya yang keliru (path, field, tipe, atau ekspektasi salah) atau masalah data/lingkungan, JANGAN mengubah kode untuk bagian itu: tulis "BUTUH KLARIFIKASI:" lalu jelaskan bagian test yang harus diubah.`,
  '2. Untuk yang memang bug: tulis dulu unit test yang mereproduksinya, lalu perbaiki seminimal mungkin di titik akar masalah tanpa mengubah perilaku lain. Kerjakan semuanya dalam satu kali kerja, jangan berhenti di yang pertama.',
  `3. Ringkas${many ? ' per test case' : ''}: akar masalah dan bukti file:baris, atau alasan bila tidak diubah.`,
];

const taskSpecLines = (specs: { title: string; spec: string }[] = []) => {
  const seen = new Set<string>();
  return specs.filter((t) => t.spec.trim() && !seen.has(t.title) && seen.add(t.title)).map((t) => `\nDetail Task TAD "${t.title}":\n${clip(t.spec, TASK_SPEC_LIMIT)}`);
};

/**
 * The coder run's spec. Headers are left out (they carry the environment's auth); bodies are cut to a
 * few KB. The agent is told to confirm the bug is in the code first: a wrong test is fixed in the
 * test (Perbaiki dengan AI), not by bending the service to it.
 */
export function buildCodeFixSpec(input: CodeFixInput): string {
  const lines = [`Test E2E gagal: ${input.flow.name}`, `Proyek: ${input.projectName} · Environment: ${input.envName} · Run: ${input.runAt}`, ...failureLines(input.flow, input.result, true)];
  lines.push(...taskSpecLines(input.taskSpecs));
  if (input.note?.trim()) lines.push(`\nCatatan Tech Lead:\n${input.note.trim().slice(0, 4_000)}`);
  lines.push(...howToWork(input.repo, false));
  return lines.filter(Boolean).join('\n').slice(0, 40_000);
}

/** Test cases per coder run when fixing several at once (a long spec gets cut). */
export const MAX_FLOWS_PER_FIX = 6;

export interface MultiCodeFixInput {
  items: { flow: QAFlow; result: QAFlowResult; runAt: string }[];
  projectName: string;
  envName: string;
  repo: string;
  taskSpecs?: { title: string; spec: string }[];
  note?: string;
}

/** One run for several failed test cases on the same repo: each failure, then the TAD specs once. */
export function buildMultiCodeFixSpec(input: MultiCodeFixInput): string {
  if (input.items.length === 1) {
    const [{ flow, result, runAt }] = input.items;
    return buildCodeFixSpec({ flow, result, runAt, projectName: input.projectName, envName: input.envName, repo: input.repo, taskSpecs: input.taskSpecs, note: input.note });
  }
  const lines = [`${input.items.length} test E2E gagal di ${input.repo} · Proyek: ${input.projectName} · Environment: ${input.envName}`];
  input.items.forEach(({ flow, result, runAt }, i) => lines.push(`\n=== Test case ${i + 1}: ${flow.name} (run ${runAt}) ===`, ...failureLines(flow, result, false)));
  lines.push(...taskSpecLines(input.taskSpecs));
  if (input.note?.trim()) lines.push(`\nCatatan Tech Lead:\n${input.note.trim().slice(0, 4_000)}`);
  lines.push(...howToWork(input.repo, true));
  return lines.filter(Boolean).join('\n').slice(0, 40_000);
}

/** Splits failed test cases into runs of at most MAX_FLOWS_PER_FIX. */
export function chunkFixes<T>(items: T[], size = MAX_FLOWS_PER_FIX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Title for a run fixing several test cases (its branch comes from the shared group, else a count). */
export function multiCodeFixTitle(flows: QAFlow[], repo: string): string {
  if (flows.length === 1) return codeFixTitle(flows[0], repo);
  const stages = [...new Set(flows.map((f) => f.stage ?? ''))];
  const what = stages.length === 1 && stages[0] ? stages[0].replace(/^\d+\.\s*/, '') : `${flows.length} test case`;
  return `[BUGFIX][${repo.toUpperCase()}][E2E] - Perbaikan ${what}`.slice(0, 300);
}
