/** AI providers the connector can drive headlessly, shared by the TAD generator and WhatsApp drafter. */

export type AiProviderId = 'claude' | 'antigravity' | 'inferhub' | '9router';

export interface AiModelOption {
  /** Value passed to the CLI's --model flag; '' means the CLI's own default. */
  id: string;
  label: string;
}

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  available: boolean;
  models: AiModelOption[];
  /** Why the provider is unavailable, or how to set it up. */
  note?: string;
  /** Usable, but something needs attention (e.g. an outdated CLI). */
  warning?: string;
  version?: string;
}

export interface AiSelection {
  provider: AiProviderId;
  model: string;
}

export const DEFAULT_AI_SELECTION: AiSelection = { provider: '9router', model: 'ag/claude-sonnet-4-6' };

export function isAiSelection(x: unknown): x is AiSelection {
  const s = x as AiSelection;
  return (
    (s?.provider === 'claude' || s?.provider === 'antigravity' || s?.provider === 'inferhub' || s?.provider === '9router') &&
    typeof s.model === 'string' &&
    /^[\w.:/-]{0,100}$/.test(s.model)
  );
}

/** One rate-limit window reported by a CLI (e.g. 5-hour session, weekly). */
export interface AiUsageWindow {
  label: string;
  usedPercent: number;
  /** Human-readable reset time as reported by the CLI. */
  resets?: string;
}

/** Credit/balance information for token gateways like InferHub. */
export interface AiCreditBalance {
  amount: string;
  currency?: string;
  email?: string;
}

/** Status information for routing gateways like 9Router. */
export interface AiGatewayStatus {
  endpoint: string;
  activeModels?: number;
  status?: string;
}

export interface AiProviderUsage {
  id: AiProviderId;
  windows: AiUsageWindow[];
  balance?: AiCreditBalance;
  gateway?: AiGatewayStatus;
  error?: string;
  fetchedAt: string;
}

