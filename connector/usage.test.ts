// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parseAgyUsage, parseClaudeUsage } from './usage.ts';

describe('parseClaudeUsage', () => {
  it('reads session and weekly windows from `claude -p /usage`', () => {
    const text = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 87% used · resets Oct 4 at 5:40pm (Asia/Jakarta)',
      'Current week (all models): 66% used · resets Oct 9 at 3pm (Asia/Jakarta)',
      'Current week (Opus): 12% used',
      '',
      "What's contributing to your limits usage?",
    ].join('\n');
    expect(parseClaudeUsage(text)).toEqual([
      { label: 'Sesi (5 jam)', usedPercent: 87, resets: 'Oct 4 at 5:40pm (Asia/Jakarta)' },
      { label: 'Mingguan (semua model)', usedPercent: 66, resets: 'Oct 9 at 3pm (Asia/Jakarta)' },
      { label: 'Mingguan (Opus)', usedPercent: 12, resets: undefined },
    ]);
  });
});

describe('parseAgyUsage', () => {
  it('turns remaining percentages from `agy -p /usage` into used percentages', () => {
    const text = 'Gemini Models\tWeekly Limit Remaining\t72%\t2026-10-07T03:08:02Z\nGemini Models\tFive Hour Limit Remaining\t95%\t2026-10-04T10:55:22Z\n';
    expect(parseAgyUsage(text)).toEqual([
      { label: 'Gemini Models · mingguan', usedPercent: 28, resets: '2026-10-07T03:08:02Z' },
      { label: 'Gemini Models · 5 jam', usedPercent: 5, resets: '2026-10-04T10:55:22Z' },
    ]);
  });
});

describe('inferhubUsage', () => {
  it('returns balance without rate-limit windows when profile is found', async () => {
    const { inferhubUsage } = await import('./usage.ts');
    const inferhubMod = await import('./inferhub.ts');
    const spyCfg = vi.spyOn(inferhubMod, 'getInferHubConfig').mockResolvedValue({
      apiKey: 'test-key',
      baseUrl: 'https://api.inferhub.dev',
      defaultModel: 'ali/qwen3.8-max',
    });
    const spyProfile = vi.spyOn(inferhubMod, 'fetchInferHubProfile').mockResolvedValue({
      email: 'willy@example.com',
      balance: '0.65',
      currency: 'USDC',
    });

    const res = await inferhubUsage();
    expect(res.id).toBe('inferhub');
    expect(res.windows).toEqual([]);
    expect(res.balance).toEqual({
      amount: '$0.65',
      currency: 'USDC',
      email: 'willy@example.com',
    });

    spyCfg.mockRestore();
    spyProfile.mockRestore();
  });
});

describe('ninerouterUsage', () => {
  it('returns gateway status without rate-limit windows', async () => {
    const { ninerouterUsage } = await import('./usage.ts');
    const ninerouterMod = await import('./ninerouter.ts');
    const spyCfg = vi.spyOn(ninerouterMod, 'getNineRouterConfig').mockResolvedValue({
      apiKey: 'test-key',
      baseUrl: 'https://ai.diwebin.web.id',
      defaultModel: 'test-model',
    });
    const spyModels = vi.spyOn(ninerouterMod, 'listNineRouterModels').mockResolvedValue([
      { id: '', label: 'Default' },
      { id: 'm1', label: 'Model 1' },
      { id: 'm2', label: 'Model 2' },
    ]);

    const res = await ninerouterUsage();
    expect(res.id).toBe('9router');
    expect(res.windows).toEqual([]);
    expect(res.gateway).toEqual({
      endpoint: 'https://ai.diwebin.web.id',
      activeModels: 2,
      status: 'Terhubung',
    });

    spyCfg.mockRestore();
    spyModels.mockRestore();
  });
});

