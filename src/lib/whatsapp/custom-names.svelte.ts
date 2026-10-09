import { wa } from './client';

const STORAGE_KEY = 'tlc.wa.custom_names';

class WaCustomNames {
  names = $state<Record<string, string>>(this.load());

  private load(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  get(jid: string): string | undefined {
    return this.names[jid];
  }

  set(jid: string, name: string) {
    const trimmed = name.trim();
    const next = { ...this.names };
    if (!trimmed) {
      delete next[jid];
    } else {
      next[jid] = trimmed;
    }
    this.names = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.names));
    } catch {
      /* ignore storage quota errors */
    }
    if (trimmed) {
      wa.setContactName(jid, trimmed).catch(() => {});
    }
  }

  getName(jid: string, fallbackName?: string): string {
    const custom = this.names[jid]?.trim();
    if (custom) return custom;
    if (fallbackName?.trim()) return fallbackName.trim();
    return formatWaPhone(jid);
  }
}

export const waCustomNames = new WaCustomNames();

/**
 * Normalizes phone number into WhatsApp international digit string without leading +.
 * e.g. "0812-3456-789" -> "628123456789"
 * e.g. "+62 812 3456 789" -> "628123456789"
 */
export function normalizeWaPhone(input: string): string {
  const cleaned = input.trim().replace(/[^\d+]/g, '');
  let digits = cleaned.replace(/^\+/, '');
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  }
  return digits;
}

export function phoneToJid(input: string): string {
  const digits = normalizeWaPhone(input);
  return `${digits}@s.whatsapp.net`;
}

/**
 * Formats a phone number or JID for clean human display:
 * e.g. "6281234567890@s.whatsapp.net" -> "+62 812-3456-7890"
 */
export function formatWaPhone(jidOrPhone: string): string {
  if (!jidOrPhone) return '';
  const digits = jidOrPhone.replace(/@.*$/, '').replace(/\D/g, '');
  if (!digits) return jidOrPhone;
  if (digits.startsWith('62')) {
    const rest = digits.slice(2);
    if (rest.length <= 4) return `+62 ${rest}`;
    if (rest.length <= 8) return `+62 ${rest.slice(0, 3)}-${rest.slice(3)}`;
    return `+62 ${rest.slice(0, 3)}-${rest.slice(3, 7)}-${rest.slice(7)}`;
  }
  return `+${digits}`;
}

/**
 * Smart search for WhatsApp chats:
 * Matches query against custom alias, original name, last message preview,
 * or phone number digits (supporting 08xx vs 628xx interchangeable lookups).
 */
export function matchesWaSearch(jid: string, originalName: string, lastText: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  const displayName = waCustomNames.getName(jid, originalName).toLowerCase();
  if (displayName.includes(q)) return true;
  if (originalName.toLowerCase().includes(q)) return true;
  if (lastText && lastText.toLowerCase().includes(q)) return true;

  // Numeric phone matching
  const qDigits = q.replace(/\D/g, '');
  if (qDigits.length >= 2) {
    const jidDigits = jid.replace(/@.*$/, '').replace(/\D/g, '');
    if (jidDigits.includes(qDigits)) return true;

    // Interchange 08xx with 628xx
    if (qDigits.startsWith('0')) {
      const qWith62 = '62' + qDigits.slice(1);
      if (jidDigits.includes(qWith62)) return true;
    } else if (qDigits.startsWith('62')) {
      const qWith0 = '0' + qDigits.slice(2);
      if (('0' + jidDigits.slice(2)).includes(qWith0) || jidDigits.includes(qDigits)) return true;
    }
  }

  return false;
}
