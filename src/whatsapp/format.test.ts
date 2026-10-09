import { describe, expect, it } from 'vitest';
import { formatWaText } from './format';

describe('formatWaText', () => {
  it('renders WhatsApp formatting', () => {
    expect(formatWaText('ini *penting* dan _miring_ ~salah~')).toBe('ini <strong>penting</strong> dan <em>miring</em> <s>salah</s>');
    expect(formatWaText('pakai `npm test`')).toBe('pakai <code>npm test</code>');
  });

  it('escapes HTML from message content', () => {
    expect(formatWaText('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('links URLs without swallowing quotes or punctuation, and leaves snake_case alone', () => {
    expect(formatWaText('"https://x.id/a_b".')).toBe('&quot;<a href="https://x.id/a_b" target="_blank" rel="noreferrer">https://x.id/a_b</a>&quot;.');
    expect(formatWaText('kolom user_id_baru')).toBe('kolom user_id_baru');
  });
});
