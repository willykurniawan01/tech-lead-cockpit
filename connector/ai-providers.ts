import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { AiModelOption, AiProviderInfo, AiSelection } from '../src/lib/ai/types.ts';
import type { GeneratorJobEvent } from '../src/lib/generator/types.ts';
import { DEFAULT_INFERHUB_MODELS, getInferHubConfig, listInferHubModels, startInferHubRun } from './inferhub.ts';
import { checkNineRouterStatus, getNineRouterConfig, startNineRouterRun } from './ninerouter.ts';

/**
 * Headless drivers for Claude CLI (`claude -p`) and Antigravity CLI (`agy -p`). Both stream
 * NDJSON progress, which is normalised here into GeneratorJobEvents plus a final result.
 * Neither is ever given blanket permission: prompts carry untrusted content (PRD, chats).
 */

export type ProviderEvent = Omit<GeneratorJobEvent, 'at'>;
export type RunPurpose = 'edit' | 'text';

const ENV_PATH = `${path.join(os.homedir(), '.local/bin')}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`;

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((c) => fs.existsSync(c));
}

export function findClaudeBinary(): string | undefined {
  return firstExisting(['/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.local/bin/claude')]);
}

/** The installer puts `agy` in ~/.local/bin (see antigravity.google/docs/cli/getting-started). */
export function findAgyBinary(): string | undefined {
  return firstExisting([path.join(os.homedir(), '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy']);
}

const CLAUDE_MODELS: AiModelOption[] = [
  { id: '', label: 'Default (setelan Claude CLI)' },
  { id: 'opus', label: 'Opus (terkuat)' },
  { id: 'sonnet', label: 'Sonnet (seimbang)' },
  { id: 'haiku', label: 'Haiku (tercepat)' },
];

/** `agy models` prints "slug<TAB>Label" per line. */
export function parseAgyModels(stdout: string): AiModelOption[] {
  const models: AiModelOption[] = [];
  for (const line of stdout.split('\n')) {
    // The real CLI separates slug and label with a tab; the docs show aligned spaces.
    const m = line.trim().match(/^([\w.:-]+)(?:\t+|\s{2,})(.+)$/);
    if (m) models.push({ id: m[1], label: m[2].trim() });
  }
  return models;
}

const MIN_CLAUDE_VERSION = [2, 1];
let claudeVersionCache: { at: number; version?: string } | undefined;

function claudeVersion(bin: string): Promise<string | undefined> {
  if (claudeVersionCache && Date.now() - claudeVersionCache.at < 10 * 60 * 1000) return Promise.resolve(claudeVersionCache.version);
  return new Promise((resolve) => {
    const child = execFile(bin, ['--version'], { timeout: 10_000, env: { ...process.env, PATH: ENV_PATH } }, (_err, stdout) => {
      const version = stdout.match(/\d+\.\d+\.\d+/)?.[0];
      claudeVersionCache = { at: Date.now(), version };
      resolve(version);
    });
    child.stdin?.end();
  });
}

export function isOutdated(version: string | undefined, min = MIN_CLAUDE_VERSION): boolean {
  if (!version) return false;
  const [major, minor] = version.split('.').map(Number);
  return major < min[0] || (major === min[0] && minor < min[1]);
}

let agyModelsCache: { at: number; models: AiModelOption[]; error?: string } | undefined;

function listAgyModels(bin: string): Promise<{ models: AiModelOption[]; error?: string }> {
  if (agyModelsCache && Date.now() - agyModelsCache.at < 10 * 60 * 1000) return Promise.resolve(agyModelsCache);
  return new Promise((resolve) => {
    const child = execFile(bin, ['models'], { timeout: 20_000, env: { ...process.env, PATH: ENV_PATH } }, (err, stdout, stderr) => {
      const models = parseAgyModels(stdout);
      const error = err || !models.length ? (stderr.trim() || err?.message || 'Tidak ada model.').slice(0, 300) : undefined;
      agyModelsCache = { at: Date.now(), models, error };
      resolve(agyModelsCache);
    });
    child.stdin?.end();
  });
}

export async function listProviders(): Promise<AiProviderInfo[]> {
  const claude = findClaudeBinary();
  const agy = findAgyBinary();
  const [agyModels, claudeVer, inferHubCfg, nineRouterCfg] = await Promise.all([
    agy ? listAgyModels(agy) : undefined,
    claude ? claudeVersion(claude) : undefined,
    getInferHubConfig(),
    getNineRouterConfig(),
  ]);
  const [inferHubModels, nineRouterStatus] = await Promise.all([
    inferHubCfg ? listInferHubModels(inferHubCfg) : DEFAULT_INFERHUB_MODELS,
    nineRouterCfg ? checkNineRouterStatus(nineRouterCfg) : Promise.resolve<{ available: boolean; models: AiModelOption[]; note?: string; warning?: string }>({ available: false, models: [], note: '9Router belum dikonfigurasi.' }),
  ]);

  return [
    {
      id: 'claude',
      label: 'Claude CLI',
      available: Boolean(claude),
      models: CLAUDE_MODELS,
      note: claude ? undefined : 'Claude CLI belum terpasang. Install Claude Code lalu login sekali dengan perintah `claude`.',
      version: claudeVer,
      warning: isOutdated(claudeVer)
        ? `Claude CLI versi ${claudeVer} terlalu lama dan bisa menggantung. Perbarui: brew upgrade --cask claude-code, lalu jalankan \`claude\` sekali di Terminal.`
        : undefined,
    },
    {
      id: 'antigravity',
      label: 'Antigravity CLI',
      available: Boolean(agy && agyModels?.models.length),
      models: [{ id: '', label: 'Default (setelan Antigravity)' }, ...(agyModels?.models ?? [])],
      note: !agy
        ? 'Antigravity CLI (agy) belum terpasang. Jalankan: curl -fsSL https://antigravity.google/cli/install.sh | bash, lalu buka `agy` sekali untuk login.'
        : agyModels?.error
          ? `agy terpasang tapi belum siap: ${agyModels.error}. Jalankan \`agy\` sekali secara interaktif untuk login.`
          : undefined,
    },
    {
      id: 'inferhub',
      label: 'InferHub',
      available: Boolean(inferHubCfg?.apiKey),
      models: inferHubModels,
      note: inferHubCfg?.apiKey
        ? undefined
        : 'InferHub API key belum diset. Simpan di Keychain lewat `npm run token:inferhub` atau isi INFERHUB_API_KEY di .env.local.',
    },
    {
      id: '9router',
      label: '9Router',
      available: nineRouterStatus.available,
      models: nineRouterStatus.models,
      note: nineRouterStatus.note,
      warning: nineRouterStatus.warning,
    },
  ];
}

// --- Stream parsers -------------------------------------------------------------------------

export interface StreamParser {
  (line: string): { events: ProviderEvent[]; result?: { reply: string; error?: string }; sessionId?: string };
}

const CLAUDE_TOOL_LABEL: Record<string, string> = { Read: 'Membaca', Edit: 'Mengedit', MultiEdit: 'Mengedit', Write: 'Menulis ulang' };

/** Codebase files relative to the Services folder (service/…/file), anything else by file name. */
function displayPath(file: string): string {
  const parts = file.split('/');
  const i = parts.lastIndexOf('Services');
  return i >= 0 && i < parts.length - 1 ? parts.slice(i + 1).join('/') : path.basename(file);
}

function describeClaudeTool(name: string, input: Record<string, unknown>): string {
  const where = typeof input.path === 'string' ? ` di ${displayPath(input.path)}` : '';
  if (name === 'Glob' && typeof input.pattern === 'string') return `Mencari file ${input.pattern}${where}`;
  if (name === 'Grep' && typeof input.pattern === 'string') return `Mencari "${input.pattern.slice(0, 60)}"${where}`;
  return `${CLAUDE_TOOL_LABEL[name] ?? name} ${typeof input.file_path === 'string' ? displayPath(input.file_path) : ''}`.trim();
}

/** Claude CLI `--output-format stream-json --verbose`. */
export function claudeStreamParser(): StreamParser {
  return (line) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return { events: [] };
    }
    const events: ProviderEvent[] = [];
    if (e.type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string') return { events, sessionId: e.session_id };
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) events.push({ kind: 'text', text: c.text.trim().slice(0, 300) });
        if (c.type === 'tool_use') events.push({ kind: 'tool', text: describeClaudeTool(c.name, c.input ?? {}) });
      }
    }
    if (e.type === 'user') {
      for (const c of e.message?.content ?? []) {
        if (c?.type === 'tool_result' && c.is_error) {
          events.push({ kind: 'tool-error', text: (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 300) });
        }
      }
    }
    if (e.type === 'result') {
      const reply = typeof e.result === 'string' ? e.result.trim() : '';
      const error = e.is_error ? reply || `Claude CLI berhenti: ${e.subtype}` : undefined;
      return { events, result: { reply: reply || (e.subtype !== 'success' ? `Claude CLI berhenti: ${e.subtype}` : ''), error } };
    }
    return { events };
  };
}

const AGY_TOOL_LABEL: Record<string, string> = {
  view_file: 'Membaca',
  read_file: 'Membaca',
  list_dir: 'Melihat folder',
  write_to_file: 'Menulis',
  replace_file_content: 'Mengedit',
  multi_replace_file_content: 'Mengedit',
  edit_file: 'Mengedit',
  run_command: 'Menjalankan perintah',
  grep_search: 'Mencari',
};

function fileFromParams(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  for (const v of Object.values(params as Record<string, unknown>)) {
    if (typeof v === 'string' && /[\w-]+\.\w{1,5}$/.test(v) && v.length < 400) return path.basename(v);
  }
  return '';
}

/** Antigravity CLI `--output-format stream-json`: init, step_update…, result. */
/**
 * Antigravity wraps every rejected tool call in "declaring permissions: …", even a plain missing
 * file, which reads like a permission problem. Strip the wrapper and say what actually happened.
 */
export function agyToolError(message: string): string {
  const m = message.replace(/^declaring permissions:.*?invalid tool call error \(invalid_args\)\s*/i, '');
  const missing = m.match(/failed to read file: stat (.+?): no such file or directory/i);
  if (missing) return `file tidak ada: ${missing[1]}`;
  const folder = m.match(/cannot view "(.+?)": path is a directory/i);
  if (folder) return `${folder[1]} adalah folder, bukan file`;
  return m;
}

export function agyStreamParser(): StreamParser {
  const textByStep = new Map<number, string>();
  return (line) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return { events: [] };
    }
    const events: ProviderEvent[] = [];
    if (e.event === 'init') {
      if (e.init?.model) events.push({ kind: 'info', text: `Model: ${e.init.model}` });
      return { events, sessionId: typeof e.conversation_id === 'string' && e.conversation_id ? e.conversation_id : undefined };
    }
    if (e.event === 'step_update') {
      const s = e.step_update ?? {};
      if (s.step_type === 'agent_response' && typeof s.text_delta === 'string') {
        const text = (textByStep.get(s.step_index) ?? '') + s.text_delta;
        textByStep.set(s.step_index, text);
        if (s.state === 'DONE' && text.trim()) events.push({ kind: 'text', text: text.trim().slice(0, 300) });
      }
      if (s.step_type === 'tool' && (s.state === 'DONE' || s.state === 'ERROR')) {
        const name = s.tool_name ?? s.tool_info?.name ?? 'tool';
        if (s.tool_info?.error || s.state === 'ERROR') {
          const err = s.tool_info?.error;
          events.push({ kind: 'tool-error', text: `${name}: ${agyToolError(String(err?.message ?? err?.type ?? 'gagal')).slice(0, 280)}` });
        } else {
          events.push({ kind: 'tool', text: `${AGY_TOOL_LABEL[name] ?? name} ${fileFromParams(s.tool_info?.parameters)}`.trim() });
        }
      }
    }
    if (e.event === 'result') {
      const r = e.result ?? {};
      // Some runs end SUCCESS with an empty response; fall back to the text streamed in steps.
      const streamed = [...textByStep.values()].join('\n').trim();
      const reply = (typeof r.response === 'string' ? r.response.trim() : '') || streamed;
      const error = r.status === 'SUCCESS' ? undefined : r.error || `Antigravity CLI berhenti dengan status ${r.status ?? 'tidak diketahui'}.`;
      return { events, result: { reply, error } };
    }
    return { events };
  };
}

// --- Runner ----------------------------------------------------------------------------------

/** File tools only (no shell); edits outside the workspace are not auto-approved. */
const CLAUDE_EDIT_ARGS = ['--allowedTools', 'Read,Glob,Grep,Edit,Write', '--permission-mode', 'acceptEdits'];

/**
 * Read-only extra folders for Claude: --add-dir makes them readable, but acceptEdits would also
 * auto-approve edits there, so writes are denied explicitly (deny rules win over allow).
 * `//` marks an absolute path in Claude permission rules.
 */
export function claudeReadOnlyDirArgs(dirs: string[], allowWhitelistedBash = false): string[] {
  const args: string[] = [];
  // Whitelisted commands (coding agents) come from --allowedTools; a blanket Bash deny would win over them.
  const deny = allowWhitelistedBash ? [] : ['Bash'];
  for (const dir of dirs) {
    args.push('--add-dir', dir);
    const abs = `/${dir.replace(/\/+$/, '')}/**`;
    deny.push(`Edit(${abs})`, `Write(${abs})`, `MultiEdit(${abs})`, `NotebookEdit(${abs})`);
  }
  return deny.length ? [...args, '--disallowedTools', ...deny] : args;
}

const FIRST_OUTPUT_TIMEOUT_MS = 300_000;
const KILL_GRACE_MS = 5_000;

/** SIGTERM, then SIGKILL if the CLI is still alive after a grace period (it can ignore TERM while stuck). */
function terminate(child: ChildProcess) {
  child.kill('SIGTERM');
  const hard = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  hard.unref();
  child.once('close', () => clearTimeout(hard));
}

/** CLIs refuse to run until updated terms are accepted interactively; say so plainly. */
export function explainCliError(label: string, message: string): string {
  if (/ACTION REQUIRED|review the updated terms|Consumer Terms/i.test(message)) {
    return `${label} meminta persetujuan ketentuan baru. Buka Terminal, jalankan \`${label === 'Claude CLI' ? 'claude' : 'agy'}\` sekali dan setujui, lalu coba lagi.`;
  }
  if (/required the "(write_file|read_file)" permission|permission check failed for (write|read)_file/i.test(message)) {
    return `${label} ditolak saat mengakses file di luar folder kerja draft. Kalau AI perlu membaca codebase, klik "Izinkan baca codebase" di panel Chat AI.`;
  }
  if (/required the "command" permission|permission check failed for unsandboxed/i.test(message)) {
    return `${label} mencoba menjalankan perintah terminal, dan itu sengaja diblokir. Coba kirim ulang; AI diarahkan memakai tool baca/edit file.`;
  }
  if (/not logged in|authentication required|authentication_error|failed to authenticate|session expired|token has been revoked|please log ?in|\/login|\b401\b/i.test(message)) {
    return `${label} belum login. Buka Terminal, jalankan \`${label === 'Claude CLI' ? 'claude' : 'agy'}\` sekali untuk login, lalu coba lagi.`;
  }
  if (/INVALID_ARGUMENT|code 400|Request contains an invalid argument/i.test(message)) {
    return `${label} menolak permintaan (INVALID_ARGUMENT 400). Biasanya terjadi jika AI mencoba membaca file PDF terenkripsi/berproteksi izin di folder Dokumen (docs/), atau sesi chat sebelumnya rusak. Sesi chat telah di-reset otomatis agar Anda dapat mencoba kembali. Bila ada file PDF terproteksi, buka PDF di browser atau macOS Preview lalu pilih File > Print > Save as PDF (tanpa proteksi sandi) sebelum diunggah kembali.`;
  }
  return message;
}

export interface ProviderRunOptions {
  cwd: string;
  timeoutMs: number;
  /** For 'text' runs: replaces Claude's system prompt; prepended for Antigravity (no such flag). */
  systemPrompt?: string;
  /** Extra folders the AI may read but never modify (the services codebase). */
  readOnlyDirs?: string[];
  /** Continue a previous CLI session/conversation so follow-up messages keep context. */
  resumeSession?: string;
  /**
   * Edit runs only (Claude): shell commands the AI may run, as prefixes such as `go test`.
   * Everything else stays denied, so coding agents can run tests but nothing else.
   */
  allowedCommands?: string[];
  onEvent?: (e: ProviderEvent) => void;
}

/** `--allowedTools` for an edit run, optionally with a few whitelisted command prefixes. */
export function claudeEditArgs(allowedCommands: string[] = []): string[] {
  if (!allowedCommands.length) return CLAUDE_EDIT_ARGS;
  const bash = allowedCommands.map((c) => `Bash(${c.replace(/[(),]/g, '')}:*)`);
  return ['--allowedTools', ['Read', 'Glob', 'Grep', 'Edit', 'Write', ...bash].join(','), '--permission-mode', 'acceptEdits'];
}

export { terminate as terminateProviderProcess };

export interface ProviderOutcome {
  reply: string;
  error?: string;
  /** Session (Claude) or conversation (Antigravity) id, for resuming on the next message. */
  sessionId?: string;
  /** The run ended "successfully" but produced no answer text. */
  emptyAnswer?: boolean;
}

export interface ProviderRun {
  /** Absent when the CLI isn't installed. */
  child?: ChildProcess;
  /** Resolves with the reply, or with `error` set (never rejects). */
  done: Promise<ProviderOutcome>;
  /** Optional abort callback for API-based runners. */
  abort?: () => void;
}

function modelArgs(model: string): string[] {
  return model ? ['--model', model] : [];
}

export function startProviderRun(sel: AiSelection, purpose: RunPurpose, prompt: string, opts: ProviderRunOptions): ProviderRun {
  if (sel.provider === 'inferhub') {
    return startInferHubRun(sel, purpose, prompt, opts);
  }
  if (sel.provider === '9router') {
    return startNineRouterRun(sel, purpose, prompt, opts);
  }

  let bin: string | undefined;
  let args: string[];
  let stdin = '';
  let parse: StreamParser;
  const label = sel.provider === 'claude' ? 'Claude CLI' : 'Antigravity CLI';

  if (sel.provider === 'claude') {
    bin = findClaudeBinary();
    args = ['-p', '--output-format', 'stream-json', '--verbose', ...modelArgs(sel.model)];
    args.push(...(purpose === 'edit' ? claudeEditArgs(opts.allowedCommands) : ['--tools', '', ...(opts.systemPrompt ? ['--system-prompt', opts.systemPrompt] : [])]));
    if (purpose === 'edit') args.push(...claudeReadOnlyDirArgs(opts.readOnlyDirs ?? [], Boolean(opts.allowedCommands?.length)));
    if (opts.resumeSession) args.push('--resume', opts.resumeSession);
    // Prompt on stdin, then close it: with an open pipe the CLI waits for more input forever.
    stdin = prompt;
    parse = claudeStreamParser();
  } else {
    bin = findAgyBinary();
    const fullPrompt = purpose === 'text' && opts.systemPrompt ? `${opts.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    // Workspace file reads/writes are auto-allowed; shell commands stay soft-denied (no skip-permissions).
    // Reading readOnlyDirs needs a read_file() rule the user grants once (see grantAgyReadAccess).
    args = ['-p', fullPrompt, '--output-format', 'stream-json', '--print-timeout', `${Math.ceil(opts.timeoutMs / 60000)}m`, ...modelArgs(sel.model)];
    if (opts.resumeSession) args.push('--conversation', opts.resumeSession);
    // Headless runs can't answer edit-review prompts; accept-edits applies them, while the git-root
    // workspace keeps file tools inside the draft folder and Services stays write-denied by rule.
    if (purpose === 'edit') args.push('--mode=accept-edits');
    parse = agyStreamParser();
  }

  if (!bin) {
    return { done: Promise.resolve({ reply: '', error: `${label} tidak ditemukan. Pasang dan login terlebih dahulu (lihat menu Koneksi).` }) };
  }

  const child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, PATH: ENV_PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(stdin);

  const done = new Promise<ProviderOutcome>((resolveOutcome) => {
    let final: { reply: string; error?: string } | undefined;
    let sessionId: string | undefined;
    const resolve = (o: { reply: string; error?: string }) => resolveOutcome({ ...o, sessionId });
    let stderr = '';
    let timedOut = false;
    let silent = false;
    // Both CLIs emit an init event right away; total silence means it's stuck on a login/terms prompt.
    const firstOutput = setTimeout(() => {
      silent = true;
      terminate(child);
    }, Math.min(FIRST_OUTPUT_TIMEOUT_MS, opts.timeoutMs));
    createInterface({ input: child.stdout }).on('line', (line) => {
      clearTimeout(firstOutput);
      const parsed = parse(line);
      parsed.events.forEach((e) => opts.onEvent?.(e));
      if (parsed.sessionId) sessionId = parsed.sessionId;
      if (parsed.result) final = parsed.result;
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-3000)));
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, opts.timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      clearTimeout(firstOutput);
      resolve({ reply: '', error: err.code === 'ENOENT' ? `${label} tidak ditemukan.` : err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(firstOutput);
      if (silent) {
        return resolve({
          reply: '',
          error: explainCliError(label, stderr.trim()) || `${label} tidak merespons dalam ${FIRST_OUTPUT_TIMEOUT_MS / 1000} detik. Biasanya karena perlu login, persetujuan ketentuan baru, atau versi CLI terlalu lama. Jalankan \`${sel.provider === 'claude' ? 'claude' : 'agy'}\` sekali di Terminal.`,
        });
      }
      if (timedOut) return resolve({ reply: final?.reply ?? '', error: `${label} tidak selesai dalam ${Math.round(opts.timeoutMs / 60000)} menit dan dihentikan.` });
      if (final?.error) return resolve({ ...final, error: explainCliError(label, final.error) });
      if (final?.reply) return resolve(final);
      // A "successful" run with no answer at all (e.g. a tool was denied): say why instead of pretending.
      if (final) return resolveOutcome({ reply: '', sessionId, emptyAnswer: true, error: explainCliError(label, stderr.trim().slice(-600)) || `${label} selesai tanpa memberi jawaban.` });
      resolve({ reply: '', error: explainCliError(label, stderr.trim().slice(-600)) || `${label} berhenti (exit ${code}) tanpa hasil.` });
    });
  });

  return { child, done };
}
