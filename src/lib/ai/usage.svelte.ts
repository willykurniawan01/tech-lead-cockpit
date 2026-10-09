import type { AiProviderId, AiProviderUsage } from './types';
import { api } from '../api-base';

/** Plan usage per CLI, shared by every meter on the page. */
class AiUsage {
  list = $state<AiProviderUsage[]>([]);
  loading = $state(false);
  private lastLoad = 0;

  async load(force = false) {
    if (this.loading || (!force && Date.now() - this.lastLoad < 60_000)) return;
    this.loading = true;
    try {
      const res = await fetch(api(`/api/connector/ai/usage${force ? '?refresh=1' : ''}`), { headers: { 'X-TLC-Client': '1' } });
      if (res.ok) this.list = await res.json();
      this.lastLoad = Date.now();
    } catch {
      /* keep the previous numbers */
    } finally {
      this.loading = false;
    }
  }

  get(id: AiProviderId): AiProviderUsage | undefined {
    return this.list.find((u) => u.id === id);
  }
}

export const aiUsage = new AiUsage();
