import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiProviders } from './providers.svelte';
import { aiUsage } from './usage.svelte';

describe('aiProviders', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads provider list and handles multiple concurrent calls cleanly', async () => {
    const mockProviders = [
      { id: 'claude', label: 'Claude Code', available: true, models: [{ id: 'claude-3-7-sonnet', label: 'Claude 3.7' }] },
    ];

    let fetchCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => mockProviders,
      };
    });

    // Concurrent load calls should not duplicate network requests
    await Promise.all([aiProviders.load(true), aiProviders.load(true)]);
    expect(fetchCount).toBe(1);
    expect(aiProviders.list).toEqual(mockProviders);
    expect(aiProviders.loading).toBe(false);
  });
});

describe('aiUsage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads usage list and avoids duplicate in-flight requests', async () => {
    const mockUsage = [
      { id: 'claude', windows: [] },
    ];

    let fetchCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => mockUsage,
      };
    });

    await Promise.all([aiUsage.load(true), aiUsage.load(true)]);
    expect(fetchCount).toBe(1);
    expect(aiUsage.loading).toBe(false);
  });
});
