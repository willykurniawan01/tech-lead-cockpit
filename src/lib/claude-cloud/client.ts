import { api } from '../api-base';

export interface ClaudeCloudAuthStatus {
  available: boolean;
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
  error?: string;
}

export interface ClaudeCloudStartResult {
  ok: boolean;
  sessionId?: string;
  url?: string;
  log?: string;
  error?: string;
}

export interface ClaudeCloudMessageResult {
  ok: boolean;
  sessionId: string;
  url?: string;
  error?: string;
}

export interface ClaudeUltrareviewResult {
  ok: boolean;
  output?: string;
  findings?: unknown;
  error?: string;
}

export const claudeCloud = {
  async status(): Promise<ClaudeCloudAuthStatus> {
    try {
      const res = await fetch(api('/api/connector/ai/claude-cloud/status'), {
        headers: { 'X-TLC-Client': '1' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e: any) {
      return { available: false, loggedIn: false, error: e.message };
    }
  },

  async start(payload: {
    repo?: string;
    root?: string;
    prompt: string;
    mode?: 'cloud' | 'ultrareview';
    target?: string;
  }): Promise<ClaudeCloudStartResult> {
    const res = await fetch(api('/api/connector/ai/claude-cloud/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      return { ok: false, error: err.message || `HTTP ${res.status}` };
    }
    return await res.json();
  },

  async sendMessage(sessionId: string, message: string): Promise<ClaudeCloudMessageResult> {
    const res = await fetch(api('/api/connector/ai/claude-cloud/message'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-TLC-Client': '1' },
      body: JSON.stringify({ sessionId, message }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      return { ok: false, sessionId, error: err.message || `HTTP ${res.status}` };
    }
    return await res.json();
  },
};
