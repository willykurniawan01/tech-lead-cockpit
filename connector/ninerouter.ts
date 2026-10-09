import type { AiModelOption, AiSelection } from '../src/lib/ai/types.ts';
import type { ProviderOutcome, ProviderRun, ProviderRunOptions, RunPurpose } from './ai-providers.ts';
import { NINEROUTER_SERVICE, readKeychain } from './keychain.ts';
import { runOpenAiChatCompletion } from './openai-tool-runner.ts';
import { readEnvLocalVar } from './env-file.ts';

export const DEFAULT_NINEROUTER_BASE_URL = 'http://localhost:20128';

export interface NineRouterConfig {
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
}

export const DEFAULT_NINEROUTER_MODELS: AiModelOption[] = [
  { id: '', label: 'Default (9Router gateway)' },
];

export async function getNineRouterConfig(env: Record<string, string | undefined> = process.env): Promise<NineRouterConfig | null> {
  const isExplicitEnv = env !== process.env;
  const envKey = (isExplicitEnv ? (env.NINEROUTER_API_KEY ?? '') : (readEnvLocalVar('NINEROUTER_API_KEY', env) ?? '')).trim();
  const keychainKey = envKey || isExplicitEnv ? null : await readKeychain(NINEROUTER_SERVICE).catch(() => null);
  const apiKey = (envKey || keychainKey || '').trim() || undefined;

  const rawBaseUrl = (isExplicitEnv ? (env.NINEROUTER_BASE_URL ?? '') : (readEnvLocalVar('NINEROUTER_BASE_URL', env) ?? '')).trim();
  const baseUrl = (rawBaseUrl || DEFAULT_NINEROUTER_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
  const defaultModel = (isExplicitEnv ? (env.NINEROUTER_MODEL ?? '') : (readEnvLocalVar('NINEROUTER_MODEL', env) ?? '')).trim() || undefined;

  return { apiKey, baseUrl, defaultModel };
}

let modelsCache: { at: number; models: AiModelOption[] } | undefined;

export async function listNineRouterModels(cfg: NineRouterConfig): Promise<AiModelOption[]> {
  if (modelsCache && Date.now() - modelsCache.at < 2 * 60 * 1000) {
    return modelsCache.models;
  }

  const headers: Record<string, string> = {};
  if (cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }

  try {
    const res = await fetch(`${cfg.baseUrl}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) {
      return [{ id: '', label: `Default (${cfg.defaultModel || '9Router gateway'})` }];
    }

    const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
    if (!Array.isArray(body.data) || !body.data.length) {
      return [{ id: '', label: `Default (${cfg.defaultModel || '9Router gateway'})` }];
    }

    const dynamicModels: AiModelOption[] = body.data.map((m) => ({
      id: m.id,
      label: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id,
    }));

    const models = [
      { id: '', label: `Default (${cfg.defaultModel || dynamicModels[0]?.id || '9Router gateway'})` },
      ...dynamicModels,
    ];
    modelsCache = { at: Date.now(), models };
    return models;
  } catch {
    return [{ id: '', label: `Default (${cfg.defaultModel || '9Router gateway'})` }];
  }
}

export function clearNineRouterModelsCache(): void {
  modelsCache = undefined;
}

export async function checkNineRouterStatus(cfg: NineRouterConfig): Promise<{
  available: boolean;
  models: AiModelOption[];
  note?: string;
  warning?: string;
}> {
  const headers: Record<string, string> = {};
  if (cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  }

  try {
    const res = await fetch(`${cfg.baseUrl}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(4_000),
    });

    if (res.status === 401 || res.status === 403) {
      return {
        available: false,
        models: DEFAULT_NINEROUTER_MODELS,
        note: `API Key 9Router ditolak oleh endpoint (HTTP ${res.status}). Simpan di Keychain lewat \`npm run token:9router\` atau isi NINEROUTER_API_KEY di .env.local.`,
      };
    }

    if (!res.ok) {
      return {
        available: false,
        models: DEFAULT_NINEROUTER_MODELS,
        note: `9Router merespons dengan kode HTTP ${res.status} pada ${cfg.baseUrl}/v1/models.`,
      };
    }

    const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
    const dynamicModels: AiModelOption[] = Array.isArray(body?.data)
      ? body.data.map((m) => ({
          id: m.id,
          label: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id,
        }))
      : [];

    const models = [
      { id: '', label: `Default (${cfg.defaultModel || dynamicModels[0]?.id || '9Router gateway'})` },
      ...dynamicModels,
    ];
    modelsCache = { at: Date.now(), models };

    return {
      available: true,
      models,
    };
  } catch (err: any) {
    return {
      available: false,
      models: DEFAULT_NINEROUTER_MODELS,
      note: `9Router tidak dapat dihubungi di ${cfg.baseUrl}. Pastikan service 9Router aktif atau atur NINEROUTER_BASE_URL di .env.local.`,
    };
  }
}

export function explainNineRouterError(status: number, message: string): string {
  if (status === 401 || /unauthorized|invalid api key/i.test(message)) {
    return '9Router API key tidak valid. Periksa token di Keychain (`npm run token:9router`) atau NINEROUTER_API_KEY di .env.local.';
  }
  if (status === 404 || /model not found|not found/i.test(message)) {
    return `Model atau endpoint tidak ditemukan di 9Router (HTTP ${status}): ${message}`;
  }
  if (status === 429 || /rate limit/i.test(message)) {
    return 'Limit permintaan 9Router tercapai (rate limit). Tunggu beberapa saat dan coba kembali.';
  }
  if (status === 502 || status === 503 || status === 504 || /upstream|bad gateway|connect/i.test(message)) {
    return `9Router gagal menghubungi upstream AI provider (HTTP ${status}): ${message}`;
  }
  return message || `9Router gagal merespons (HTTP ${status}).`;
}

export function startNineRouterRun(
  sel: AiSelection,
  purpose: RunPurpose,
  prompt: string,
  opts: ProviderRunOptions,
): ProviderRun {
  let innerRun: ProviderRun | undefined;

  const done = (async (): Promise<ProviderOutcome> => {
    const cfg = await getNineRouterConfig();
    if (!cfg) {
      return {
        reply: '',
        error: '9Router belum dikonfigurasi. Pastikan 9Router berjalan atau isi NINEROUTER_BASE_URL di .env.local.',
      };
    }

    innerRun = runOpenAiChatCompletion(
      {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        defaultModel: cfg.defaultModel || 'default',
        providerLabel: '9Router',
        explainError: explainNineRouterError,
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
