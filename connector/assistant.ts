import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AiSelection } from '../src/lib/ai/types.ts';
import { DEFAULT_AI_SELECTION, isAiSelection } from '../src/lib/ai/types.ts';
import { startProviderRun } from './ai-providers.ts';
import { COCKPIT_GUIDE } from './cockpit-knowledge.ts';
import type { ConversationFiles } from './conversations-store.ts';
import type { AssistantMessage } from '../src/lib/assistant/types.ts';

export type AssistantMode = 'code-review' | 'security' | 'performance' | 'architecture' | 'general';

export const ASSISTANT_SYSTEM_PROMPTS: Record<AssistantMode, string> = {
  'code-review': [
    'Kamu adalah Staff Software Engineer & Tech Lead berpengalaman.',
    'Tugasmu adalah melakukan Code Review secara mendalam, objektif, dan konstruktif.',
    'Struktur review yang harus kamu berikan (dalam Bahasa Indonesia profesional):',
    '1. ## Ringkasan Perubahan: Gambaran umum dari kode/diff yang direview.',
    '2. ## Temuan Kritis & Bug: Celah logika, potential null pointer, error handling yang hilang, atau unhandled exceptions.',
    '3. ## Kualitas & Clean Code: Keterbacaan, penamaan, struktur fungsi, duplikasi kode (DRY), dan kepatuhan idiom bahasa.',
    '4. ## Rekomendasi Perbaikan: Cuplikan kode perbaikan (before vs after) yang konkret.',
    '5. ## Kesimpulan: Apakah kode ini aman untuk di-merge (Approve / Request Changes)?',
  ].join('\n'),

  security: [
    'Kamu adalah Application Security Lead & Whitehat Expert.',
    'Tugasmu adalah mengaudit keamanan kode/diff (AppSec & OWASP Top 10).',
    'Fokuskan analisis pada:',
    '- Injeksi (SQLi, Command Injection, NoSQL Injection, XSS)',
    '- Broken Authentication & Authorization (IDOR, role bypass, token leak)',
    '- Sensitif Data Exposure (hardcoded secrets, API keys, password plain-text di log)',
    '- Input Validation & Sanitization',
    '- Keamanan Dependencies dan insecure deserialization',
    'Untuk setiap celah:',
    '1. Tingkat Keparahan (Critical, High, Medium, Low)',
    '2. Skenario Eksploitasi',
    '3. Contoh Patching/Perbaikan Kode yang aman',
  ].join('\n'),

  performance: [
    'Kamu adalah Senior Performance Engineer & Database Optimization Expert.',
    'Tugasmu adalah mengaudit performa dan skalabilitas kode.',
    'Fokuskan analisis pada:',
    '- Masalah query database (N+1 queries, missing index, unpaged queries, heavy JOINs)',
    '- Alokasi memori & potential memory leaks',
    '- Algoritma & Time Complexity (O(n^2), loop bersarang yang tidak perlu)',
    '- Concurrency, locking contention, dan race conditions',
    '- Network I/O, serial requests yang bisa diparalelkan, dan caching strategy',
    'Berikan rekomendasi optimasi yang terukur beserta estimasi dampak performa.',
  ].join('\n'),

  architecture: [
    'Kamu adalah Principal Enterprise Architect.',
    'Tugasmu adalah menilai desain arsitektur, pola desain, dan batas modularitas kode.',
    'Fokuskan analisis pada:',
    '- Prinsip SOLID dan Clean Architecture',
    '- Pemisahan tanggung jawab (Separation of Concerns) antar layer/service',
    '- Coupling & Cohesion',
    '- Idempotency dan resiliensi sistem (retry, circuit breaker, fallback)',
    '- Desain API dan backward compatibility',
  ].join('\n'),

  general: [
    'Kamu adalah asisten kerja Tech Lead yang cerdas, tajam, dan solutif.',
    'Kamu membantu tugas sehari-hari Tech Lead: diskusi arsitektur, trade-off teknis, pembuatan ADR (Architecture Decision Record), perancangan API, pemecahan task, dan debugging.',
    'Jawab secara to-the-point, jelas, berbasis best-practices industri, dan berikan contoh kode konkret jika relevan.',
  ].join('\n'),
};

export type ReviewStrictness = 'lenient' | 'standard' | 'strict';

export const STRICTNESS_GUIDELINES: Record<ReviewStrictness, string> = {
  lenient:
    'PEDOMAN KETELITIAN REVIEW: SANTAI (LENIENT). Fokus HANYA pada critical blocker, runtime crash, data corruption, dan celah keamanan fatal. Jangan mempermasalahkan style, formatting, penamaan minor, atau saran performa mikro.',
  standard:
    'PEDOMAN KETELITIAN REVIEW: STANDAR (NORMAL). Seimbangkan kebenaran fungsional, maintainability, penanganan error (null/empty/network failure), dan best practice bahasa/framework.',
  strict:
    'PEDOMAN KETELITIAN REVIEW: SANGAT KETAT (STRICT / HIGH BAR). Audit menyeluruh dan ketat terhadap setiap baris: clean code, boundary & edge cases, race conditions, query performa / N+1, sanitasi input, kelengkapan unit test, dan error handling.',
};

export interface AssistantChatRequest {
  prompt: string;
  context?: string;
  mode?: AssistantMode;
  strictness?: ReviewStrictness;
  ai?: AiSelection;
  resumeSession?: string;
  /** General chat: continue this saved conversation; omitted starts a new one. */
  conversationId?: string;
}

const HISTORY_MAX_MESSAGES = 16;
const HISTORY_MAX_CHARS = 16_000;

/**
 * Earlier turns as plain text, for when the provider has no session to resume (InferHub after a
 * restart, a switch to another provider, or an expired CLI session).
 */
export function historyBlock(messages: AssistantMessage[]): string {
  const turns = messages.filter((m) => m.role !== 'system' && !m.error && m.text.trim()).slice(-HISTORY_MAX_MESSAGES);
  const out: string[] = [];
  let size = 0;
  for (const m of [...turns].reverse()) {
    const line = `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text.trim()}`;
    if (size + line.length > HISTORY_MAX_CHARS) break;
    out.unshift(line);
    size += line.length;
  }
  return out.length ? `### RIWAYAT PERCAKAPAN SEBELUMNYA\n${out.join('\n\n')}` : '';
}

export function buildAssistantPrompt(prompt: string, context?: string): string {
  if (!context?.trim()) return prompt;
  return [
    '### KODE / DIFF YANG DIREVIEW:',
    '```',
    context.trim(),
    '```',
    '',
    '### PERTANYAAN / INSTRUKSI:',
    prompt.trim(),
  ].join('\n');
}

/** The general chat also knows Cockpit itself: the guide as system prompt plus a live snapshot per message. */
export function withCockpitContext(prompt: string, snapshot: string): string {
  return `${snapshot}\n\n### PESAN USER:\n${prompt}`;
}

export async function handleAssistantChat(
  req: IncomingMessage,
  res: ServerResponse,
  body: AssistantChatRequest,
  cockpitContext?: (prompt: string) => Promise<string>,
  conversations?: ConversationFiles,
) {
  const mode = body.mode && ASSISTANT_SYSTEM_PROMPTS[body.mode] ? body.mode : 'general';
  const ai = isAiSelection(body.ai) ? body.ai : DEFAULT_AI_SELECTION;
  let systemPrompt = ASSISTANT_SYSTEM_PROMPTS[mode];
  if (body.strictness && STRICTNESS_GUIDELINES[body.strictness]) {
    systemPrompt = `${systemPrompt}\n\n${STRICTNESS_GUIDELINES[body.strictness]}`;
  }
  let prompt = buildAssistantPrompt(body.prompt, body.context);
  if (mode === 'general' && cockpitContext) {
    systemPrompt = `${systemPrompt}\n\n${COCKPIT_GUIDE}`;
    prompt = withCockpitContext(prompt, await cockpitContext(body.prompt).catch(() => '### SNAPSHOT COCKPIT\n(gagal dibaca)'));
  }

  // The general chat is saved by the connector itself, so it survives closing the page mid-answer.
  let conversationId: string | undefined;
  let resumeSession = body.resumeSession;
  let history = '';
  if (mode === 'general' && conversations) {
    const existing = body.conversationId ? await conversations.get(body.conversationId).catch(() => undefined) : undefined;
    const conv = existing ?? (await conversations.create(body.prompt));
    conversationId = conv.id;
    history = historyBlock(conv.messages);
    // InferHub and 9Router keep sessions only in memory; the saved transcript is the reliable context there.
    resumeSession = ai.provider === 'inferhub' || ai.provider === '9router' ? undefined : conv.sessions?.[ai.provider];
    await conversations.append(conv.id, { role: 'user', text: body.prompt }, { ai });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let clientGone = false;
  const sendEvent = (data: Record<string, any>) => {
    if (!clientGone) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  if (conversationId) sendEvent({ kind: 'conversation', id: conversationId });

  const start = (resume: string | undefined) =>
    startProviderRun(ai, 'text', resume || !history ? prompt : `${history}\n\n${prompt}`, {
      cwd: process.cwd(),
      timeoutMs: 120_000,
      systemPrompt,
      resumeSession: resume,
      onEvent: (ev) => sendEvent(ev),
    });

  let run = start(resumeSession);
  let cancelled = false;
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    // A saved conversation keeps going so the answer is still stored; an unsaved one has no reader left.
    if (!conversationId) {
      cancelled = true;
      run.abort?.();
    }
  });

  try {
    let outcome = await run.done;
    if (outcome.error && resumeSession && !cancelled) {
      // The CLI session may have expired: retry once from the saved transcript.
      run = start(undefined);
      outcome = await run.done;
    }
    if (conversationId && conversations) {
      await conversations.append(
        conversationId,
        outcome.error
          ? { role: 'assistant', text: `⚠️ Gagal merespons: ${outcome.error}`, error: true, provider: ai.provider, model: ai.model }
          : { role: 'assistant', text: outcome.reply, provider: ai.provider, model: ai.model },
        outcome.sessionId && !outcome.error ? { session: { provider: ai.provider, id: outcome.sessionId } } : {},
      );
    }
    if (outcome.error) sendEvent({ kind: 'error', error: outcome.error });
    else sendEvent({ kind: 'done', reply: outcome.reply, sessionId: outcome.sessionId, conversationId });
  } catch (e) {
    sendEvent({ kind: 'error', error: (e as Error).message });
  } finally {
    if (!clientGone) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}
