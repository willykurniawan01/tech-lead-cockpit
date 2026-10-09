import { execFile } from 'node:child_process';
import type { AiProviderUsage, AiUsageWindow } from '../src/lib/ai/types.ts';
import { findAgyBinary, findClaudeBinary } from './ai-providers.ts';
import { fetchInferHubProfile, getInferHubConfig } from './inferhub.ts';
import { getNineRouterConfig, listNineRouterModels } from './ninerouter.ts';

/**
 * Plan usage straight from the CLIs: `claude -p /usage` and `agy -p /usage` answer locally
 * (no model call, no cost) with the session/weekly windows and when they reset.
 */

const CACHE_MS = 60_000;
let cache: { at: number; data: AiProviderUsage[] } | undefined;

/** "Current session: 87% used · resets Oct 4 at 5:40pm (Asia/Jakarta)" */
export function parseClaudeUsage(text: string): AiUsageWindow[] {
  const windows: AiUsageWindow[] = [];
  for (const m of text.matchAll(/^\s*(Current [^:\n]+):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+([^\n]+))?/gim)) {
    const label = m[1].replace(/^Current session$/i, 'Sesi (5 jam)').replace(/^Current week \(all models\)$/i, 'Mingguan (semua model)').replace(/^Current week/i, 'Mingguan');
    windows.push({ label, usedPercent: Number(m[2]), resets: m[3]?.trim() });
  }
  return windows;
}

/** "Gemini Models\tWeekly Limit Remaining\t72%\t2026-10-07T03:08:02Z" */
export function parseAgyUsage(text: string): AiUsageWindow[] {
  const windows: AiUsageWindow[] = [];
  for (const line of text.split('\n')) {
    const [group, kind, pct, reset] = line.split('\t').map((x) => x?.trim());
    const remaining = pct?.match(/^(\d+(?:\.\d+)?)%$/);
    if (!group || !kind || !remaining) continue;
    const label = `${group} · ${/five hour/i.test(kind) ? '5 jam' : /weekly/i.test(kind) ? 'mingguan' : kind}`;
    windows.push({ label, usedPercent: Math.round(100 - Number(remaining[1])), resets: reset });
  }
  return windows;
}

function run(bin: string, args: string[], stdin: string): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ stdout, error: err ? (stderr.trim() || err.message).slice(0, 300) : undefined }),
    );
    child.stdin?.end(stdin);
  });
}

async function claudeUsage(): Promise<AiProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const bin = findClaudeBinary();
  if (!bin) return { id: 'claude', windows: [], error: 'Claude CLI belum terpasang.', fetchedAt };
  const { stdout, error } = await run(bin, ['-p', '--output-format', 'json'], '/usage');
  let text = stdout;
  try {
    text = String(JSON.parse(stdout).result ?? '');
  } catch {
    /* plain text */
  }
  const windows = parseClaudeUsage(text);
  return { id: 'claude', windows, error: windows.length ? undefined : error ?? 'Laporan usage tidak terbaca (mungkin perlu login ulang).', fetchedAt };
}

async function agyUsage(): Promise<AiProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const bin = findAgyBinary();
  if (!bin) return { id: 'antigravity', windows: [], error: 'Antigravity CLI belum terpasang.', fetchedAt };
  const { stdout, error } = await run(bin, ['-p', '/usage'], '');
  const windows = parseAgyUsage(stdout);
  return { id: 'antigravity', windows, error: windows.length ? undefined : error ?? 'Laporan usage tidak terbaca (mungkin perlu login ulang).', fetchedAt };
}

export async function inferhubUsage(): Promise<AiProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const cfg = await getInferHubConfig();
  if (!cfg?.apiKey) return { id: 'inferhub', windows: [], error: 'InferHub API key belum diset.', fetchedAt };
  const profile = await fetchInferHubProfile(cfg);
  if (!profile) {
    return {
      id: 'inferhub',
      windows: [],
      error: 'Tidak dapat membaca saldo InferHub.',
      fetchedAt,
    };
  }
  return {
    id: 'inferhub',
    windows: [],
    balance: {
      amount: profile.balance !== undefined ? `$${profile.balance}` : '-',
      currency: profile.currency ?? 'USDC',
      email: profile.email,
    },
    fetchedAt,
  };
}

export async function ninerouterUsage(): Promise<AiProviderUsage> {
  const fetchedAt = new Date().toISOString();
  const cfg = await getNineRouterConfig();
  if (!cfg) return { id: '9router', windows: [], error: '9Router belum dikonfigurasi.', fetchedAt };
  const models = await listNineRouterModels(cfg);
  const count = models.length > 1 ? models.length - 1 : 0;
  return {
    id: '9router',
    windows: [],
    gateway: {
      endpoint: cfg.baseUrl,
      activeModels: count,
      status: 'Terhubung',
    },
    fetchedAt,
  };
}

export async function getUsage(force = false): Promise<AiProviderUsage[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const data = await Promise.all([claudeUsage(), agyUsage(), inferhubUsage(), ninerouterUsage()]);
  cache = { at: Date.now(), data };
  return data;
}

