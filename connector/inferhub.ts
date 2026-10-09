import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiModelOption, AiSelection } from '../src/lib/ai/types.ts';
import type { ProviderEvent, ProviderOutcome, ProviderRun, ProviderRunOptions, RunPurpose } from './ai-providers.ts';
import { INFERHUB_SERVICE, readKeychain } from './keychain.ts';
import { runOpenAiChatCompletion } from './openai-tool-runner.ts';
import { readEnvLocalVar } from './env-file.ts';

export interface InferHubConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
}

export const DEFAULT_INFERHUB_MODELS: AiModelOption[] = [
  { id: '', label: 'Default (ali/qwen3.8-max)' },
  { id: 'ali/qwen3.8-max', label: 'Qwen 3.8 Max (Alibaba)' },
  { id: 'ag/claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking' },
  { id: 'cb/gpt-5.4', label: 'GPT-5.4 (OpenAI)' },
  { id: 'cb/gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'ag/gemini-3.8-flash-high', label: 'Gemini 3.8 Flash High (Google)' },
  { id: 'ali/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
  { id: 'cc/claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (Anthropic)' },
];

export async function getInferHubConfig(env: Record<string, string | undefined> = process.env): Promise<InferHubConfig | null> {
  const isExplicitEnv = env !== process.env;
  const envKey = (isExplicitEnv ? (env.INFERHUB_API_KEY ?? '') : (readEnvLocalVar('INFERHUB_API_KEY', env) ?? '')).trim();
  const keychainKey = envKey || isExplicitEnv ? null : await readKeychain(INFERHUB_SERVICE).catch(() => null);
  const apiKey = (envKey || keychainKey || '').trim();
  if (!apiKey) return null;

  const baseUrl = (isExplicitEnv ? (env.INFERHUB_BASE_URL || 'https://api.inferhub.dev') : (readEnvLocalVar('INFERHUB_BASE_URL', env) || 'https://api.inferhub.dev')).replace(/\/+$/, '');
  const defaultModel = (isExplicitEnv ? (env.INFERHUB_MODEL || 'ali/qwen3.8-max') : (readEnvLocalVar('INFERHUB_MODEL', env) || 'ali/qwen3.8-max')).trim();
  return { apiKey, baseUrl, defaultModel };
}

let modelsCache: { at: number; models: AiModelOption[] } | undefined;

export async function listInferHubModels(cfg: InferHubConfig): Promise<AiModelOption[]> {
  if (modelsCache && Date.now() - modelsCache.at < 10 * 60 * 1000) {
    return modelsCache.models;
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return DEFAULT_INFERHUB_MODELS;
    const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
    if (!Array.isArray(body.data) || !body.data.length) return DEFAULT_INFERHUB_MODELS;

    const dynamicModels: AiModelOption[] = body.data.map((m) => ({
      id: m.id,
      label: m.name ? `${m.name} (${m.id})` : m.id,
    }));
    const models = [{ id: '', label: `Default (${cfg.defaultModel})` }, ...dynamicModels];
    modelsCache = { at: Date.now(), models };
    return models;
  } catch {
    return DEFAULT_INFERHUB_MODELS;
  }
}

export interface InferHubProfile {
  email?: string;
  balance?: number | string;
  currency?: string;
}

export async function fetchInferHubProfile(cfg: InferHubConfig): Promise<InferHubProfile | null> {
  try {
    const res = await fetch('https://inferhub.dev/api/me', {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    const balance = body.balances?.consumer_balance ?? body.balance;
    return {
      email: body.email,
      balance: balance !== undefined ? Number(balance).toFixed(2) : undefined,
    };
  } catch {
    return null;
  }
}

export function explainInferHubError(status: number, message: string): string {
  if (status === 401 || /unauthorized|invalid api key|missing or malformed authorization/i.test(message)) {
    return 'InferHub API key tidak valid atau belum terdaftar. Periksa API key di dashboard InferHub (https://inferhub.dev/dashboard).';
  }
  if (status === 402 || /insufficient balance|insufficient credits|out of funds|payment required/i.test(message)) {
    return 'Saldo InferHub tidak mencukupi. Silakan top up di dashboard InferHub (https://inferhub.dev/dashboard).';
  }
  if (status === 429 || /rate limit/i.test(message)) {
    return 'Limit permintaan InferHub tercapai (rate limit). Tunggu beberapa saat dan coba kembali.';
  }
  return message || `InferHub gagal merespons (HTTP ${status}).`;
}

// --- Runner entry point ---

export function startInferHubRun(sel: AiSelection, purpose: RunPurpose, prompt: string, opts: ProviderRunOptions): ProviderRun {
  let innerRun: ProviderRun | undefined;

  const done = (async (): Promise<ProviderOutcome> => {
    const cfg = await getInferHubConfig();
    if (!cfg) {
      return {
        reply: '',
        error: 'InferHub API key belum diset. Simpan di Keychain lewat `npm run token:inferhub` atau isi INFERHUB_API_KEY di .env.local.',
      };
    }

    innerRun = runOpenAiChatCompletion(
      {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        defaultModel: cfg.defaultModel,
        providerLabel: 'InferHub',
        explainError: explainInferHubError,
      },
      sel,
      purpose,
      prompt,
      opts,
    );

    return innerRun.done;
  })();

  return {
    done,
    abort: () => innerRun?.abort?.(),
  };
}

