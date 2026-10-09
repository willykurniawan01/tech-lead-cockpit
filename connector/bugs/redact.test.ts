// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { logExcerpt, redactLog } from './redact.ts';

describe('redactLog', () => {
  it('masks tokens, secrets and personal data but keeps the shape', () => {
    const raw = [
      'Authorization: Bearer abcdefghijklmnop.qrstuv',
      '{"username":"budi","password":"s3cr3t!","pin":"123456","amount":10000}',
      'GET /v1/pay?token=abc123xyz&ref=TRX-1',
      'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'card 4111 1111 1111 1234 msisdn 081234567890 email budi.santoso@example.com',
      'order 123456 amount 10000 at 2026-10-08T10:00:00Z',
    ].join('\n');
    const out = redactLog(raw);
    expect(out).toContain('Authorization: Bearer ***');
    expect(out).toContain('"password":"***"');
    expect(out).toContain('"pin":"***"');
    expect(out).toContain('"amount":10000');
    expect(out).toContain('token=***&ref=TRX-1');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('****1234');
    expect(out).toContain('0812****890');
    expect(out).toContain('***@example.com');
    // Ordinary numbers stay.
    expect(out).toContain('order 123456 amount 10000 at 2026-10-08T10:00:00Z');
  });
});

describe('logExcerpt', () => {
  it('keeps error lines with context and marks gaps', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `INFO line ${i + 1}`);
    lines[19] = 'ERROR promo reserve failed: quota slot not found';
    lines[39] = 'panic: runtime error: invalid memory address or nil pointer dereference';
    const ex = logExcerpt(lines.join('\n'));
    expect(ex).toContain('… (baris 18)');
    expect(ex).toContain('ERROR promo reserve failed');
    expect(ex).toContain('INFO line 22');
    expect(ex).toContain('nil pointer dereference');
    expect(ex).not.toContain('INFO line 5\n');
    // No error at all: the tail.
    expect(logExcerpt('a\nb\nc')).toBe('a\nb\nc');
  });
});
