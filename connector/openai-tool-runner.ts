import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiSelection } from '../src/lib/ai/types.ts';
import type { ProviderOutcome, ProviderRun, ProviderRunOptions, RunPurpose } from './ai-providers.ts';

export interface OpenAiRunnerConfig {
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  providerLabel: string;
  explainError: (status: number, message: string) => string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

/** Conversation history cache for session resumption */
const sessionCache = new Map<string, { at: number; messages: ChatMessage[] }>();
const MAX_SESSIONS = 50;

function pruneSessions() {
  if (sessionCache.size <= MAX_SESSIONS) return;
  const entries = [...sessionCache.entries()].sort((a, b) => a[1].at - b[1].at);
  while (entries.length > MAX_SESSIONS) {
    const old = entries.shift();
    if (old) sessionCache.delete(old[0]);
  }
}

// --- Tool definitions for agentic editing ---

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Membaca isi file teks dari workspace atau folder codebase (read-only).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relatif dari workspace atau path absolut' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Melihat daftar file dan subfolder dalam suatu folder.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path folder (kosongkan untuk root workspace)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Mencari teks atau simbol di dalam folder codebase Services atau workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Teks atau kata kunci yang dicari' },
          path: { type: 'string', description: 'Subfolder yang ingin dicari (opsional)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Menulis seluruh isi file TAD.md atau SCOPE.md.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Nama file target (TAD.md atau SCOPE.md)' },
          content: { type: 'string', description: 'Seluruh isi Markdown baru' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_file_content',
      description: 'Mengganti cuplikan teks tertentu di TAD.md atau SCOPE.md.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Nama file target (TAD.md atau SCOPE.md)' },
          target: { type: 'string', description: 'Teks yang ingin diganti (harus persis cocok)' },
          replacement: { type: 'string', description: 'Teks pengganti' },
        },
        required: ['path', 'target', 'replacement'],
      },
    },
  },
];

export function isSafePath(target: string, allowedDirs: string[]): boolean {
  const norm = path.resolve(target);
  return allowedDirs.some((dir) => {
    const normDir = path.resolve(dir);
    return norm === normDir || norm.startsWith(normDir + path.sep);
  });
}

export function resolvePath(p: string, cwd: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(cwd, p);
}

export async function executeTool(
  name: string,
  rawArgs: string,
  cwd: string,
  readOnlyDirs: string[],
): Promise<{ output: string; displayLabel: string; isWrite?: boolean }> {
  let args: Record<string, any> = {};
  try {
    args = JSON.parse(rawArgs);
  } catch {
    return { output: 'Format argumen tool bukan JSON yang valid.', displayLabel: `${name} (gagal)` };
  }

  const allowedReadDirs = [cwd, ...readOnlyDirs];

  if (name === 'read_file') {
    const rawPath = String(args.path || '');
    const absPath = resolvePath(rawPath, cwd);
    if (!isSafePath(absPath, allowedReadDirs)) {
      return { output: 'Akses ditolak: path di luar workspace dan folder codebase yang diizinkan.', displayLabel: `Membaca ${path.basename(rawPath)} (ditolak)` };
    }
    try {
      const content = await fs.promises.readFile(absPath, 'utf-8');
      const truncated = content.length > 40_000 ? content.slice(0, 40_000) + '\n\n...(terpotong)' : content;
      return { output: truncated, displayLabel: `Membaca ${path.basename(absPath)}` };
    } catch (e) {
      return { output: `Gagal membaca file: ${(e as Error).message}`, displayLabel: `Membaca ${path.basename(absPath)} (gagal)` };
    }
  }

  if (name === 'list_dir') {
    const rawPath = String(args.path || cwd);
    const absPath = resolvePath(rawPath, cwd);
    if (!isSafePath(absPath, allowedReadDirs)) {
      return { output: 'Akses ditolak: path di luar direktori yang diizinkan.', displayLabel: 'Melihat folder (ditolak)' };
    }
    try {
      const entries = await fs.promises.readdir(absPath, { withFileTypes: true });
      const lines = entries.slice(0, 100).map((e) => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`);
      return { output: lines.join('\n') || '(folder kosong)', displayLabel: `Melihat ${path.basename(absPath) || 'workspace'}` };
    } catch (e) {
      return { output: `Gagal melihat direktori: ${(e as Error).message}`, displayLabel: 'Melihat folder (gagal)' };
    }
  }

  if (name === 'grep_search') {
    const query = String(args.query || '');
    if (!query) return { output: 'Query pencarian kosong.', displayLabel: 'Mencari' };
    const searchRoot = args.path ? resolvePath(String(args.path), cwd) : readOnlyDirs[0] || cwd;
    if (!isSafePath(searchRoot, allowedReadDirs)) {
      return { output: 'Akses ditolak.', displayLabel: `Mencari "${query}" (ditolak)` };
    }
    try {
      const matches: string[] = [];
      async function walk(dir: string, depth = 0) {
        if (depth > 4 || matches.length >= 30) return;
        const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full, depth + 1);
          } else if (entry.isFile() && /\.(go|ts|js|py|php|java|md|json|sql|ya?ml)$/i.test(entry.name)) {
            try {
              const text = await fs.promises.readFile(full, 'utf-8');
              if (text.toLowerCase().includes(query.toLowerCase())) {
                const rel = path.relative(cwd, full);
                matches.push(rel);
                if (matches.length >= 30) break;
              }
            } catch {
              /* ignore unreadable */
            }
          }
        }
      }
      await walk(searchRoot);
      const output = matches.length ? `Ditemukan di ${matches.length} file:\n` + matches.join('\n') : `Tidak ditemukan file yang mengandung "${query}".`;
      return { output, displayLabel: `Mencari "${query.slice(0, 40)}"` };
    } catch (e) {
      return { output: `Gagal mencari: ${(e as Error).message}`, displayLabel: `Mencari "${query.slice(0, 40)}" (gagal)` };
    }
  }

  if (name === 'write_file') {
    const rawPath = String(args.path || '');
    const absPath = resolvePath(rawPath, cwd);
    // Writes are STRICTLY confined to the workspace folder and only target TAD.md, SCOPE.md, or .md
    if (!isSafePath(absPath, [cwd])) {
      return { output: 'Akses ditolak: file hanya boleh ditulis di dalam folder draft workspace.', displayLabel: `Menulis ${path.basename(rawPath)} (ditolak)` };
    }
    const base = path.basename(absPath);
    if (!/^(TAD|SCOPE|.*)\.md$/i.test(base)) {
      return { output: 'Hanya file Markdown (TAD.md atau SCOPE.md) yang boleh ditulis.', displayLabel: `Menulis ${base} (ditolak)` };
    }
    try {
      await fs.promises.writeFile(absPath, String(args.content ?? ''), 'utf-8');
      return { output: `Berhasil menulis ${base} (${String(args.content ?? '').length} karakter).`, displayLabel: `Menulis ${base}`, isWrite: true };
    } catch (e) {
      return { output: `Gagal menulis file: ${(e as Error).message}`, displayLabel: `Menulis ${base} (gagal)` };
    }
  }

  if (name === 'replace_file_content') {
    const rawPath = String(args.path || '');
    const absPath = resolvePath(rawPath, cwd);
    if (!isSafePath(absPath, [cwd])) {
      return { output: 'Akses ditolak.', displayLabel: `Mengedit ${path.basename(rawPath)} (ditolak)` };
    }
    const base = path.basename(absPath);
    try {
      const existing = await fs.promises.readFile(absPath, 'utf-8');
      const target = String(args.target ?? '');
      const replacement = String(args.replacement ?? '');
      if (!existing.includes(target)) {
        return { output: 'Teks target tidak ditemukan di dalam file. Pastikan target sesuai karakter demi karakter.', displayLabel: `Mengedit ${base} (tidak cocok)` };
      }
      const updated = existing.replace(target, replacement);
      await fs.promises.writeFile(absPath, updated, 'utf-8');
      return { output: `Berhasil mengganti konten di ${base}.`, displayLabel: `Mengedit ${base}`, isWrite: true };
    } catch (e) {
      return { output: `Gagal mengedit file: ${(e as Error).message}`, displayLabel: `Mengedit ${base} (gagal)` };
    }
  }

  return { output: `Tool "${name}" tidak dikenal.`, displayLabel: `${name} (tidak dikenal)` };
}

/** Extracts markdown document if model responded directly with ```markdown or whole TAD/SCOPE document */
export async function fallbackExtractMarkdown(replyText: string, cwd: string, targetFile: string) {
  const filePath = path.join(cwd, targetFile);
  const codeBlockMatch = replyText.match(/```(?:markdown|tad|scope|md)?\s*\n([\s\S]+?)\n```/i);
  if (codeBlockMatch && codeBlockMatch[1].trim().length > 30) {
    const content = codeBlockMatch[1].trim();
    if (targetFile === 'TAD.md' && /#\s+TAD/i.test(content)) {
      await fs.promises.writeFile(filePath, content, 'utf-8').catch(() => {});
      return;
    }
    if (targetFile === 'SCOPE.md' && /#\s+Rencana Scope|##\s+Pemahaman/i.test(content)) {
      await fs.promises.writeFile(filePath, content, 'utf-8').catch(() => {});
      return;
    }
  }

  if (targetFile === 'TAD.md' && replyText.trim().startsWith('# TAD') && replyText.trim().length > 50) {
    await fs.promises.writeFile(filePath, replyText.trim(), 'utf-8').catch(() => {});
  } else if (targetFile === 'SCOPE.md' && replyText.trim().startsWith('# Rencana Scope') && replyText.trim().length > 50) {
    await fs.promises.writeFile(filePath, replyText.trim(), 'utf-8').catch(() => {});
  }
}

/** Parses raw Server-Sent Events (SSE) data stream into OpenAI chat completion choices. */
export function parseSseResponse(rawText: string): { choices?: Array<{ message: ChatMessage }> } {
  let content = '';
  let reasoningContent = '';
  let role: 'assistant' | 'user' | 'system' | 'tool' = 'assistant';
  const toolCallsMap = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();

  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? choice.message;
      if (!delta) continue;
      if (delta.role === 'assistant' || delta.role === 'user' || delta.role === 'system' || delta.role === 'tool') {
        role = delta.role;
      }
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallsMap.get(idx) ?? {
            id: tc.id || `call_${idx}`,
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name += tc.function.name;
          if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          toolCallsMap.set(idx, existing);
        }
      }
    } catch {
      /* ignore invalid JSON in a chunk */
    }
  }

  const tool_calls = Array.from(toolCallsMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc);

  return {
    choices: [
      {
        message: {
          role,
          content: content || undefined,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(tool_calls.length ? { tool_calls } : {}),
        },
      },
    ],
  };
}

export function runOpenAiChatCompletion(
  cfg: OpenAiRunnerConfig,
  sel: AiSelection,
  purpose: RunPurpose,
  prompt: string,
  opts: ProviderRunOptions,
): ProviderRun {
  const abortController = new AbortController();
  const label = cfg.providerLabel;

  const done = (async (): Promise<ProviderOutcome> => {
    const model = sel.model || cfg.defaultModel;
    opts.onEvent?.({ kind: 'info', text: `Model: ${model}` });

    const timeout = setTimeout(() => {
      abortController.abort(new Error(`${label} tidak selesai dalam ${Math.round(opts.timeoutMs / 60000)} menit dan dihentikan.`));
    }, opts.timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cfg.apiKey) {
      headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }

    try {
      if (purpose === 'text') {
        const messages: ChatMessage[] = [
          ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
          { role: 'user', content: prompt },
        ];

        const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.2,
            stream: true,
          }),
          signal: abortController.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          let message = errText;
          try {
            message = JSON.parse(errText)?.error?.message || errText;
          } catch {
            /* raw text */
          }
          return { reply: '', error: cfg.explainError(res.status, message) };
        }

        if (!res.body) {
          return { reply: '', error: `Tidak menerima response stream dari ${label}.` };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let reply = '';
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                reply += delta;
                opts.onEvent?.({ kind: 'text', text: delta });
              }
            } catch {
              /* ignore malformed chunk */
            }
          }
        }

        return { reply: reply.trim() };
      }

      // --- purpose === 'edit' (Multi-turn tool-calling loop) ---

      const isBrainstorm = /FASE BRAINSTORMING|SCOPE\.md/.test(prompt);
      const targetFileName = isBrainstorm ? 'SCOPE.md' : 'TAD.md';

      // Load previous session or initialize fresh
      const sessionId = opts.resumeSession || randomUUID();
      let messages: ChatMessage[] = [];
      if (opts.resumeSession && sessionCache.has(opts.resumeSession)) {
        messages = [...(sessionCache.get(opts.resumeSession)?.messages ?? [])];
        messages.push({ role: 'user', content: prompt });
      } else {
        // Read initial context from workspace if available
        let initialContext = '';
        const prdContent = await fs.promises.readFile(path.join(opts.cwd, 'PRD.md'), 'utf-8').catch(() => '');
        const targetContent = await fs.promises.readFile(path.join(opts.cwd, targetFileName), 'utf-8').catch(() => '');
        if (prdContent && prdContent.length < 50_000) {
          initialContext += `\n\nIsi PRD.md saat ini:\n\`\`\`markdown\n${prdContent}\n\`\`\`\n`;
        }
        if (targetContent && targetContent.length < 50_000) {
          initialContext += `\n\nIsi ${targetFileName} saat ini:\n\`\`\`markdown\n${targetContent}\n\`\`\`\n`;
        }

        messages = [
          {
            role: 'system',
            content:
              'Kamu adalah asisten Tech Lead yang menyusun dokumen arsitektur teknis (TAD atau rencana scope) dalam Bahasa Indonesia. ' +
              'Gunakan tool read_file untuk membaca file lain, dan tool write_file atau replace_file_content untuk memperbarui file target di workspace. ' +
              'Kamu juga boleh menyertakan seluruh dokumen markdown yang diperbarui di dalam balasan chat di dalam blok ```markdown ... ```.',
          },
          { role: 'user', content: prompt + initialContext },
        ];
      }

      const MAX_TURNS = 15;
      let finalReply = '';
      let fileWasModified = false;

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (abortController.signal.aborted) break;

        const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages,
            tools: AGENT_TOOLS,
            tool_choice: 'auto',
            temperature: 0.2,
            stream: false,
          }),
          signal: abortController.signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          let message = errText;
          try {
            message = JSON.parse(errText)?.error?.message || errText;
          } catch {
            /* ignore */
          }
          return { reply: finalReply, sessionId, error: cfg.explainError(res.status, message) };
        }

        let rawText = '';
        if (typeof res.text === 'function') {
          rawText = await res.text();
        } else if (typeof res.json === 'function') {
          const jsonVal = await res.json();
          rawText = typeof jsonVal === 'string' ? jsonVal : JSON.stringify(jsonVal);
        }

        let data: { choices?: Array<{ message: ChatMessage }> };
        if (rawText.trim().startsWith('data:') || res.headers?.get?.('content-type')?.includes('text/event-stream')) {
          data = parseSseResponse(rawText);
        } else {
          try {
            data = JSON.parse(rawText);
          } catch (e) {
            return { reply: finalReply, sessionId, error: `${label} mengembalikan format tidak valid: ${(e as Error).message}` };
          }
        }
        const choiceMsg = data.choices?.[0]?.message;
        if (!choiceMsg) {
          return { reply: finalReply, sessionId, error: `${label} mengembalikan response kosong.` };
        }

        messages.push(choiceMsg);

        if (choiceMsg.content) {
          finalReply = choiceMsg.content;
          opts.onEvent?.({ kind: 'text', text: choiceMsg.content.slice(0, 300) });
        }

        // If model called tools, execute them
        if (choiceMsg.tool_calls && choiceMsg.tool_calls.length > 0) {
          for (const tc of choiceMsg.tool_calls) {
            const { output, displayLabel, isWrite } = await executeTool(
              tc.function.name,
              tc.function.arguments,
              opts.cwd,
              opts.readOnlyDirs ?? [],
            );
            if (isWrite) fileWasModified = true;
            opts.onEvent?.({ kind: 'tool', text: displayLabel });

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: tc.function.name,
              content: output,
            });
          }
          continue;
        }

        break;
      }

      if (!fileWasModified && finalReply) {
        await fallbackExtractMarkdown(finalReply, opts.cwd, targetFileName);
      }

      sessionCache.set(sessionId, { at: Date.now(), messages });
      pruneSessions();

      return { reply: finalReply, sessionId };
    } catch (e) {
      if (abortController.signal.aborted) {
        return { reply: '', error: (e as Error).message || `${label} dihentikan.` };
      }
      return { reply: '', error: `${label} error: ${(e as Error).message}` };
    } finally {
      clearTimeout(timeout);
    }
  })();

  return {
    done,
    abort: () => abortController.abort(),
  };
}
