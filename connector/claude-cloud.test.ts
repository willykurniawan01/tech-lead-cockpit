import { describe, expect, it } from 'vitest';
import { checkClaudeCloudAuth, sendClaudeCloudMessage } from './claude-cloud.ts';

describe('claude-cloud connector', () => {
  it('checkClaudeCloudAuth reports status from claude auth', async () => {
    const status = await checkClaudeCloudAuth();
    expect(typeof status.available).toBe('boolean');
    if (status.available) {
      expect(typeof status.loggedIn).toBe('boolean');
    }
  });

  it('sendClaudeCloudMessage handles invalid or non-existent session cleanly', async () => {
    const res = await sendClaudeCloudMessage('session_01DiUkqY2kzbUbDmW1w96rfi', 'halo');
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error).toContain('session_01DiUkqY2kzbUbDmW1w96rfi');
  }, 15_000);
});
