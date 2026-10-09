import { describe, it, expect, vi } from 'vitest';
import { cleanHtmlText, extractMRUrls, extractHtmlAttachments, formatBytes, teamsSession, buildTeamsDraftPrompt, TEAMS_TONE_INSTRUCTIONS } from './session.ts';
import { TEAMS_TONES, type TeamsTone } from './types.ts';

vi.mock('../keychain.ts', () => ({
  TEAMS_SERVICE: 'tech-lead-cockpit.teams',
  readKeychain: vi.fn().mockResolvedValue(null),
  writeKeychain: vi.fn().mockResolvedValue(true),
  deleteKeychain: vi.fn().mockResolvedValue(true),
}));

describe('Microsoft Teams Module', () => {
  describe('formatBytes', () => {
    it('formats file sizes accurately', () => {
      expect(formatBytes(500)).toBe('500 B');
      expect(formatBytes(2048)).toBe('2.0 KB');
      expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
      expect(formatBytes(0)).toBe('');
    });
  });

  describe('extractHtmlAttachments', () => {
    it('extracts images from html tags', () => {
      const html = '<p>Berikut screenshot:</p><img src="data:image/png;base64,ABC" alt="login.png" />';
      const atts = extractHtmlAttachments(html);
      expect(atts).toEqual([
        { name: 'login.png', contentType: 'image', contentUrl: 'data:image/png;base64,ABC' },
      ]);
    });

    it('extracts document attachment cards', () => {
      const html = '<p>Pesan</p><div>📎 <strong>document.pdf</strong></div>';
      const atts = extractHtmlAttachments(html);
      expect(atts).toEqual([
        { name: 'document.pdf', contentType: 'document' },
      ]);
    });
  });

  describe('cleanHtmlText', () => {
    it('strips html tags and normalizes breaks', () => {
      const html = '<p>Halo Mas,<br/>tolong review MR ya</p><p>Makasih</p>';
      const cleaned = cleanHtmlText(html);
      expect(cleaned).toContain('Halo Mas,\ntolong review MR ya');
      expect(cleaned).toContain('Makasih');
    });

    it('decodes common html entities', () => {
      const html = 'Perubahan di Service A &amp; Service B &gt; 5 items';
      expect(cleanHtmlText(html)).toBe('Perubahan di Service A & Service B > 5 items');
    });

    it('handles empty or blank input', () => {
      expect(cleanHtmlText('')).toBe('');
    });
  });

  describe('extractMRUrls', () => {
    it('detects GitLab MR links in text', () => {
      const text = 'Tolong cek https://gitlab.com/diweb.in/tech-lead-cockpit/-/merge_requests/42 ya mas';
      const urls = extractMRUrls(text);
      expect(urls).toEqual(['https://gitlab.com/diweb.in/tech-lead-cockpit/-/merge_requests/42']);
    });

    it('detects GitHub PR links in text', () => {
      const text = 'PR nya di https://github.com/facebook/react/pull/1234';
      const urls = extractMRUrls(text);
      expect(urls).toEqual(['https://github.com/facebook/react/pull/1234']);
    });

    it('returns empty array when no MR or PR urls are found', () => {
      const text = 'Halo selamat siang mas, apa kabar?';
      expect(extractMRUrls(text)).toEqual([]);
    });

    it('deduplicates multiple identical urls and strips punctuation', () => {
      const text = 'Cek https://gitlab.com/org/repo/-/merge_requests/10, atau https://gitlab.com/org/repo/-/merge_requests/10.';
      const urls = extractMRUrls(text);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe('https://gitlab.com/org/repo/-/merge_requests/10');
    });
  });

  describe('TEAMS_TONES and buildTeamsDraftPrompt', () => {
    it('defines exactly 5 tone options with valid labels and descriptions', () => {
      expect(TEAMS_TONES).toHaveLength(5);
      const toneIds = TEAMS_TONES.map((t) => t.id);
      expect(toneIds).toEqual(['casual', 'professional', 'formal', 'mentoring', 'concise']);
      for (const t of TEAMS_TONES) {
        expect(t.label.length).toBeGreaterThan(0);
        expect(t.hint.length).toBeGreaterThan(0);
        expect(t.description.length).toBeGreaterThan(0);
        expect(TEAMS_TONE_INSTRUCTIONS[t.id]).toBeDefined();
      }
    });

    it('defaults to casual tone when tone is not specified', () => {
      const prompt = buildTeamsDraftPrompt({
        messages: [{ sender: 'Budi', content: 'Halo mas', timestamp: '10:00', isMe: false }],
      });
      expect(prompt).toContain(TEAMS_TONE_INSTRUCTIONS.casual);
    });

    it('injects specific tone guidelines for each tone', () => {
      const tones: TeamsTone[] = ['casual', 'professional', 'formal', 'mentoring', 'concise'];
      for (const tone of tones) {
        const prompt = buildTeamsDraftPrompt({
          messages: [{ sender: 'Budi', content: 'Halo', timestamp: '10:00', isMe: false }],
          tone,
        });
        expect(prompt).toContain(TEAMS_TONE_INSTRUCTIONS[tone]);
      }
    });

    it('includes detected MR links and user custom instructions', () => {
      const prompt = buildTeamsDraftPrompt({
        messages: [
          {
            sender: 'Budi',
            content: 'Ini MR nya https://gitlab.com/app/-/merge_requests/99',
            timestamp: '10:00',
            isMe: false,
            detectedMRs: ['https://gitlab.com/app/-/merge_requests/99'],
          },
        ],
        instructions: 'bilang nanti siang direview setelah meeting',
        tone: 'professional',
      });
      expect(prompt).toContain('https://gitlab.com/app/-/merge_requests/99');
      expect(prompt).toContain('bilang nanti siang direview setelah meeting');
      expect(prompt).toContain(TEAMS_TONE_INSTRUCTIONS.professional);
    });
  });

  describe('teamsSession', () => {
    it('returns unauthenticated status initially when no keychain token exists', async () => {
      const status = await teamsSession.getStatus();
      expect(status.connected).toBe(false);
      expect(status.user).toBeUndefined();
    });

    it('can cancel active login cleanly', () => {
      teamsSession.cancelLogin();
      expect(true).toBe(true);
    });
  });
});
