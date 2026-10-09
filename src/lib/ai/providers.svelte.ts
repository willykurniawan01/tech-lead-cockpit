import { appSettings } from '../settings/store.svelte';
import { DEFAULT_AI_SELECTION, isAiSelection, type AiProviderInfo, type AiSelection } from './types';
import { api } from '../api-base';

/** Per-feature defaults: quick WhatsApp drafts use Antigravity's Gemini Flash, the TAD generator Claude. */
const FEATURE_DEFAULTS: Record<'generator' | 'whatsapp', AiSelection> = {
  generator: DEFAULT_AI_SELECTION,
  whatsapp: { provider: '9router', model: 'ag/gemini-3.8-flash-high' },
};

/** Installed AI CLIs and their models, fetched once from the connector and shared by all pickers. */
class AiProviders {
  list = $state<AiProviderInfo[]>([]);
  loading = $state(false);
  error = $state('');
  private loaded = false;

  async load(force = false) {
    if ((this.loaded && !force) || this.loading) return;
    this.loading = true;
    try {
      const res = await fetch(api('/api/connector/ai/providers'), { headers: { 'X-TLC-Client': '1' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.list = await res.json();
      this.error = '';
      this.loaded = true;
    } catch (e) {
      this.error = `Gagal membaca daftar AI: ${(e as Error).message}`;
    } finally {
      this.loading = false;
    }
  }

  get(id: AiSelection['provider']): AiProviderInfo | undefined {
    return this.list.find((p) => p.id === id);
  }
}

export const aiProviders = new AiProviders();

/** The generator's default comes from the setup wizard; WhatsApp keeps its own lighter default. */
function configuredDefault(feature: 'generator' | 'whatsapp'): AiSelection {
  const ai = appSettings.value.ai;
  return feature === 'generator' && appSettings.loaded ? { provider: ai.defaultProvider, model: ai.defaultModel } : { ...FEATURE_DEFAULTS[feature] };
}

/** Remembered provider/model per feature (per-viewer convenience, so localStorage is fine). */
export function loadAiSelection(feature: 'generator' | 'whatsapp'): AiSelection {
  try {
    const saved = JSON.parse(localStorage.getItem(`tlc.ai.${feature}`) ?? 'null');
    return isAiSelection(saved) ? saved : configuredDefault(feature);
  } catch {
    return configuredDefault(feature);
  }
}

export function saveAiSelection(feature: 'generator' | 'whatsapp', sel: AiSelection) {
  try {
    localStorage.setItem(`tlc.ai.${feature}`, JSON.stringify(sel));
  } catch {
    /* ignore */
  }
}
