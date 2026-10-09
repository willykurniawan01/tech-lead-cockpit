import type { AiSelection } from '../lib/ai/types';
import type { PrdSource } from '../lib/prd/confluence-prd';
import type { GeneratorJob } from '../lib/generator/types';
import { blobToBase64 } from '../lib/markdown/mermaid';
import { api } from '../lib/api-base';
import { appSettings } from '../lib/settings/store.svelte';
import type { Draft } from './drafts.svelte';
import { askPdfPassword } from '../components/password-prompt.svelte';

const HEADERS = { 'Content-Type': 'application/json', 'X-TLC-Client': '1' };
const ROOT_KEY = 'tlc.servicesRoot';
export const DEFAULT_SERVICES_ROOT = '~/Code/Services';

/** The default first job after importing a PRD: let the AI work out scope from the real code. */
export const ANALYSIS_PROMPT = [
  'Analisa PRD.md, link Figma, dan seluruh dokumen pendukung di docs/, lalu telusuri codebase Services untuk menentukan service mana yang perlu diubah atau ditambah.',
  'Lengkapi TAD.md: Objective (daftar "perlu development" per service), Development Analysis (Architecture dengan diagram Mermaid, keputusan desain dan alasannya, status lifecycle bila ada, konvensi response, akses & identitas, Technology Stack sesuai service existing),',
  'Development Scope (satu baris per task dengan format [TYPE][SERVICE][CODENAME] - Nama Task), dan Detail Task untuk setiap task (Description dengan Technical Implementation yang merujuk file/fungsi existing, Service, Endpoint, Method, Header, Payload, Response untuk API; tabel kolom untuk model; Cron dan Langkah Proses untuk scheduler).',
  'Pastikan setiap requirement PRD tercakup minimal satu task, dan tandai asumsi yang perlu dikonfirmasi ke PM.',
].join(' ');

/** First brainstorming message: analyse, then propose a compact scope instead of a full TAD. */
export const BRAINSTORM_PROMPT =
  'Analisa PRD, link Figma, dokumen pendukung, dan codebase Services, lalu susun rencana scope di SCOPE.md: service terdampak beserta buktinya, usulan task, keputusan desain, di luar scope, asumsi, dan pertanyaan terbuka.';

/** Full TAD generation once the user has approved SCOPE.md. */
export const GENERATE_FROM_SCOPE_PROMPT = [
  'Scope di SCOPE.md sudah disetujui. Susun TAD lengkap sesuai SCOPE.md: Objective (daftar "perlu development" per service), Development Analysis (Architecture dengan diagram Mermaid, keputusan desain, status lifecycle bila ada, konvensi response, akses & identitas, Technology Stack),',
  'Development Scope persis sesuai daftar task di SCOPE.md, dan Detail Task untuk setiap task (Description dengan Technical Implementation yang merujuk file/fungsi existing, Service, Endpoint, Method, Header, Payload, Response untuk API; tabel kolom untuk model; Cron dan Langkah Proses untuk scheduler).',
].join(' ');

/** The codebase folder from the setup wizard; before settings load, the last one used here. */
export function loadServicesRoot(): string {
  if (appSettings.loaded && appSettings.value.workspace.servicesRoot) return appSettings.value.workspace.servicesRoot;
  try {
    return localStorage.getItem(ROOT_KEY) || DEFAULT_SERVICES_ROOT;
  } catch {
    return DEFAULT_SERVICES_ROOT;
  }
}

/**
 * Codebase folder the AI may read for a TAD: the TAD's own setting, else the Cockpit default.
 * TADs imported from Confluence (or made before the setting existed) have none of their own.
 */
export function servicesRootFor(draft: Pick<Draft, 'servicesRoot'>): string {
  return draft.servicesRoot?.trim() || loadServicesRoot();
}

export function saveServicesRoot(root: string) {
  if (root && root !== appSettings.value.workspace.servicesRoot) void appSettings.save({ workspace: { servicesRoot: root } }).catch(() => {});
  try {
    localStorage.setItem(ROOT_KEY, root);
  } catch {
    /* ignore */
  }
}

export interface ServicesInfo {
  root: string;
  exists: boolean;
  services: string[];
  error?: string;
  antigravity: { granted: boolean; settingsFile: string };
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function fetchServicesInfo(root: string): Promise<ServicesInfo> {
  return json(await fetch(api(`/api/connector/ai/services?root=${encodeURIComponent(root)}`), { headers: HEADERS }));
}

export async function grantAntigravityRead(root: string): Promise<{ granted: boolean; settingsFile: string }> {
  return json(await fetch(api('/api/connector/ai/antigravity/grant'), { method: 'POST', headers: HEADERS, body: JSON.stringify({ root }) }));
}

type DocList = { name: string; size: number; encrypted?: boolean }[];

/** A doc request the user can fix by entering the PDF password. */
export class PdfPasswordError extends Error {
  constructor(
    message: string,
    readonly invalid: boolean,
  ) {
    super(message);
  }
}

async function docsJson(res: Response): Promise<DocList> {
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (body.code === 'pdf-password-required' || body.code === 'pdf-password-invalid') {
      throw new PdfPasswordError(body.error ?? 'PDF diproteksi password.', body.code === 'pdf-password-invalid');
    }
  }
  return json(res);
}

export async function uploadDoc(draftId: string, file: File, password?: string): Promise<DocList> {
  const base64 = await blobToBase64(file);
  return docsJson(await fetch(api('/api/connector/chat/docs'), { method: 'POST', headers: HEADERS, body: JSON.stringify({ draftId, name: file.name, base64, password }) }));
}

export async function unlockDoc(draftId: string, name: string, password: string): Promise<DocList> {
  return docsJson(await fetch(api('/api/connector/chat/docs/unlock'), { method: 'POST', headers: HEADERS, body: JSON.stringify({ draftId, name, password }) }));
}

/**
 * Runs a doc request, asking for the PDF password (again after a wrong one) when needed.
 * Returns undefined when the user cancels the prompt.
 */
export async function withPdfPassword(name: string, send: (password?: string) => Promise<DocList>): Promise<DocList | undefined> {
  let password: string | undefined;
  for (;;) {
    try {
      return await send(password);
    } catch (e) {
      if (!(e instanceof PdfPasswordError)) throw e;
      password = await askPdfPassword(name, e.invalid);
      if (password === undefined) return undefined;
    }
  }
}

export async function deleteDoc(draftId: string, name: string): Promise<DocList> {
  return json(await fetch(api('/api/connector/chat/docs/delete'), { method: 'POST', headers: HEADERS, body: JSON.stringify({ draftId, name }) }));
}

export interface PrdImportResult {
  markdown: string;
  prdMarkdown?: string;
  /** Set when the PRD was pulled from Confluence, so later updates can be detected. */
  prdSource?: PrdSource;
  figmaLinks: { title?: string; url: string }[];
  files: File[];
  servicesRoot: string;
  ai: AiSelection;
  /** What to run right after the draft is created. */
  start: 'brainstorm' | 'generate' | 'none';
}

export type StartJobResult = { job: GeneratorJob; alreadyRunning: boolean };

export async function startGeneratorJob(
  draft: Draft,
  prompt: string,
  ai: AiSelection,
  kind: 'brainstorm' | 'edit' = 'edit',
  tadMarkdownOverride?: string,
): Promise<StartJobResult> {
  const res = await fetch(api('/api/connector/chat/jobs'), {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      draftId: draft.id,
      prompt,
      prdMarkdown: draft.prdMarkdown || '',
      tadMarkdown: tadMarkdownOverride ?? draft.markdown,
      ai,
      servicesRoot: servicesRootFor(draft),
      figmaLinks: draft.figmaLinks ?? [],
      resumeSession: draft.aiSessions?.[ai.provider],
      kind,
      scopeMarkdown: draft.scopePlan ?? '',
      existingTad: Boolean(draft.confluence?.pageId),
      scopeAgreed: draft.scopeStatus === 'agreed',
    }),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (res.status === 409 && body.job) return { job: body.job as GeneratorJob, alreadyRunning: true };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return { job: body as GeneratorJob, alreadyRunning: false };
}
