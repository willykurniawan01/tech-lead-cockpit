import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatWaPhone,
  matchesWaSearch,
  normalizeWaPhone,
  phoneToJid,
  waCustomNames,
} from './custom-names.svelte';

describe('custom-names and phone utilities', () => {
  beforeEach(() => {
    localStorage.clear();
    waCustomNames.names = {};
  });

  describe('normalizeWaPhone & phoneToJid', () => {
    it('normalizes Indonesian numbers starting with 08 to 628', () => {
      expect(normalizeWaPhone('0812-3456-7890')).toBe('6281234567890');
      expect(normalizeWaPhone('081234567890')).toBe('6281234567890');
      expect(normalizeWaPhone('+62 812 3456 7890')).toBe('6281234567890');
    });

    it('generates correct WhatsApp JID', () => {
      expect(phoneToJid('081234567890')).toBe('6281234567890@s.whatsapp.net');
      expect(phoneToJid('+6281234567890')).toBe('6281234567890@s.whatsapp.net');
    });
  });

  describe('formatWaPhone', () => {
    it('formats 628 numbers with country code and dashes', () => {
      expect(formatWaPhone('6281234567890@s.whatsapp.net')).toBe('+62 812-3456-7890');
      expect(formatWaPhone('62812345678')).toBe('+62 812-3456-78');
    });

    it('formats foreign numbers cleanly', () => {
      expect(formatWaPhone('14155552671@s.whatsapp.net')).toBe('+14155552671');
    });
  });

  describe('waCustomNames', () => {
    it('saves and retrieves custom aliases', () => {
      const jid = '6281234567890@s.whatsapp.net';
      expect(waCustomNames.getName(jid, '+6281234567890')).toBe('+6281234567890');

      waCustomNames.set(jid, 'Budi PM Payment');
      expect(waCustomNames.get(jid)).toBe('Budi PM Payment');
      expect(waCustomNames.getName(jid, '+6281234567890')).toBe('Budi PM Payment');

      // Clear alias
      waCustomNames.set(jid, '');
      expect(waCustomNames.get(jid)).toBeUndefined();
      expect(waCustomNames.getName(jid, '+6281234567890')).toBe('+6281234567890');
    });
  });

  describe('matchesWaSearch', () => {
    const jid = '6281234567890@s.whatsapp.net';

    it('matches by original contact name and message preview', () => {
      expect(matchesWaSearch(jid, 'Budi Tech Lead', 'Besok deploy ya', 'budi')).toBe(true);
      expect(matchesWaSearch(jid, 'Budi Tech Lead', 'Besok deploy ya', 'deploy')).toBe(true);
      expect(matchesWaSearch(jid, 'Budi Tech Lead', 'Besok deploy ya', 'sari')).toBe(false);
    });

    it('matches by custom alias', () => {
      waCustomNames.set(jid, 'Mas Budi Payment');
      expect(matchesWaSearch(jid, '+6281234567890', 'halo', 'payment')).toBe(true);
      expect(matchesWaSearch(jid, '+6281234567890', 'halo', 'mas budi')).toBe(true);
    });

    it('matches by phone number interchangeable between 08xx and 628xx', () => {
      // User searches with 0812
      expect(matchesWaSearch(jid, 'Unknown', '', '0812')).toBe(true);
      // User searches with 62812
      expect(matchesWaSearch(jid, 'Unknown', '', '62812')).toBe(true);
      // User searches with formatted +62 812
      expect(matchesWaSearch(jid, 'Unknown', '', '+62 812')).toBe(true);
      // User searches with last 4 digits
      expect(matchesWaSearch(jid, 'Unknown', '', '7890')).toBe(true);
      // Non matching digits
      expect(matchesWaSearch(jid, 'Unknown', '', '0899')).toBe(false);
    });
  });
});
