import type { QAFlow, QAFlowResult, QAStepResult } from './types';

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

/** Title for the coder run (its branch becomes fix/agent-<slug>; no Jira key). */
export const codeFixTitle = (flow: QAFlow, repo: string) => `[BUGFIX][${repo.toUpperCase()}] - E2E gagal: ${flow.name}`.slice(0, 300);

/**
 * The coder run's spec. Headers are left out (they carry the environment's auth); bodies are cut to a
 * few KB. The agent is told to confirm the bug is in the code first: a wrong test is fixed in the
 * test (Perbaiki dengan AI), not by bending the service to it.
 */
export function buildCodeFixSpec(input: CodeFixInput): string {
  const { flow, result, repo } = input;
  const step = failedStep(result);
  const def = flow.steps.find((s) => s.id === step?.stepId);
  const passedBefore = result.steps.slice(0, step ? result.steps.indexOf(step) : 0).filter((s) => s.status === 'passed');
  const lines: string[] = [
    `Test E2E gagal: ${flow.name}`,
    `Proyek: ${input.projectName} · Environment: ${input.envName} · Run: ${input.runAt}`,
    flow.stage ? `Grup/tahap journey: ${flow.stage}` : '',
    flow.taskTitles.length ? `Task TAD terkait: ${flow.taskTitles.join(' · ')}` : '',
    flow.description ? `\nTujuan test case:\n${flow.description}` : '',
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
  if (passedBefore.length) lines.push(`\nStep sebelumnya yang lulus: ${passedBefore.map((s) => s.name).join(' → ')}`);
  lines.push(
    `\nDefinisi test case (urutan step dan assertion, JSON):\n${clip(JSON.stringify(flow.steps.map(({ id: _id, request: { headers: _h, ...request }, ...s }) => ({ ...s, request })), null, 2), 10_000)}`,
  );
  for (const t of input.taskSpecs ?? []) if (t.spec.trim()) lines.push(`\nDetail Task TAD "${t.title}":\n${clip(t.spec, TASK_SPEC_LIMIT)}`);
  if (input.note?.trim()) lines.push(`\nCatatan Tech Lead:\n${input.note.trim().slice(0, 4_000)}`);
  lines.push(
    '',
    'Cara kerja:',
    `1. Pastikan dulu kegagalan ini memang di kode ${repo} (bandingkan dengan Detail Task TAD, struct request, router, dan handler). Bila ternyata test-nya yang keliru (path, field, tipe, atau ekspektasi salah) atau masalah data/lingkungan, JANGAN mengubah kode: tulis "BUTUH KLARIFIKASI:" lalu jelaskan bagian test yang harus diubah.`,
    '2. Bila memang bug: tulis dulu unit test yang mereproduksi kegagalan di atas, lalu perbaiki seminimal mungkin di titik akar masalah tanpa mengubah perilaku lain.',
    '3. Ringkas akar masalah dan bukti file:baris di akhir.',
  );
  return lines.filter(Boolean).join('\n').slice(0, 40_000);
}
