// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { agyStreamParser, claudeStreamParser, explainCliError, isOutdated, parseAgyModels } from './ai-providers.ts';

const lines = (xs: object[]) => xs.map((x) => JSON.stringify(x));

describe('parseAgyModels', () => {
  it('reads the tab-separated output of agy 1.2', () => {
    expect(parseAgyModels('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n')).toEqual([
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });

  it('reads slug/label pairs from `agy models`', () => {
    const out = 'gemini-3.8-flash-high     Gemini 3.8 Flash (High)\ngemini-3.1-pro-high       Gemini 3.1 Pro (High)\n...\n';
    expect(parseAgyModels(out)).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    ]);
  });
});

describe('claudeStreamParser', () => {
  it('turns text, tool calls and the result into progress events', () => {
    const parse = claudeStreamParser();
    const [init, text, tool, toolErr, result] = lines([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Saya baca dulu.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/ws/TAD.md' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'String not found' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Selesai.' },
    ]);
    expect(parse(init).events).toEqual([]);
    expect(parse(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abcdef12' })).sessionId).toBe('sess-abcdef12');
    expect(parse(text).events).toEqual([{ kind: 'text', text: 'Saya baca dulu.' }]);
    expect(parse(tool).events).toEqual([{ kind: 'tool', text: 'Mengedit TAD.md' }]);
    expect(parse(toolErr).events).toEqual([{ kind: 'tool-error', text: 'String not found' }]);
    expect(parse(result).result).toEqual({ reply: 'Selesai.', error: undefined });
  });

  it('describes searches and codebase files relative to Services', () => {
    const parse = claudeStreamParser();
    const tool = (name: string, input: object) => parse(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })).events[0].text;
    expect(tool('Glob', { pattern: '**/*.go', path: '/Users/me/MTN & FM/Services/core-wms-ultimate' })).toBe('Mencari file **/*.go di core-wms-ultimate');
    expect(tool('Grep', { pattern: 'CrudOverbooking' })).toBe('Mencari "CrudOverbooking"');
    expect(tool('Read', { file_path: '/Users/me/MTN & FM/Services/core-user-auth-ultimate/core/services/user.go' })).toBe('Membaca core-user-auth-ultimate/core/services/user.go');
  });

  it('reports CLI errors', () => {
    const r = claudeStreamParser()(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }));
    expect(r.result?.error).toBe('Claude CLI berhenti: error_max_turns');
  });
});

describe('agyStreamParser', () => {
  it('accumulates streamed text per step and labels tool steps (format from the headless docs)', () => {
    const parse = agyStreamParser();
    const out = lines([
      { event: 'init', conversation_id: 'c1', init: { cwd: '/ws', model: 'gemini-3.8-flash-medium', permission_mode: 'request-review' } },
      { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Mengedit ' } },
      { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'TAD sekarang.' } },
      { event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'replace_file_content', tool_info: { name: 'replace_file_content', parameters: { TargetFile: '/ws/TAD.md' } } } },
      { event: 'step_update', step_update: { step_index: 5, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', error: { type: 'PERMISSION', message: 'soft-denied' } } } },
      { event: 'result', result: { status: 'SUCCESS', response: 'Task dipecah.\n' } },
    ]).map((l) => parse(l));
    expect(out[0].events).toEqual([{ kind: 'info', text: 'Model: gemini-3.8-flash-medium' }]);
    expect(out[1].events).toEqual([]);
    expect(out[2].events).toEqual([{ kind: 'text', text: 'Mengedit TAD sekarang.' }]);
    expect(out[3].events).toEqual([{ kind: 'tool', text: 'Mengedit TAD.md' }]);
    expect(out[4].events).toEqual([{ kind: 'tool-error', text: 'run_command: soft-denied' }]);
    expect(out[5].result).toEqual({ reply: 'Task dipecah.', error: undefined });
  });

  it('captures the conversation id, ERROR tool steps, and falls back to streamed text', () => {
    const parse = agyStreamParser();
    expect(parse(JSON.stringify({ event: 'init', conversation_id: 'conv-123456789', init: {} })).sessionId).toBe('conv-123456789');
    const denied = parse(JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', error: { type: 'TOOL_ERROR', message: 'permission check failed' } } } }));
    expect(denied.events).toEqual([{ kind: 'tool-error', text: 'run_command: permission check failed' }]);
    parse(JSON.stringify({ event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Halo juga!' } }));
    expect(parse(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '' } })).result).toEqual({ reply: 'Halo juga!', error: undefined });
  });

  it('explains a denied terminal command', () => {
    expect(explainCliError('Antigravity CLI', 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for')).toContain('perintah terminal');
  });

  it('surfaces non-success statuses as errors', () => {
    const r = agyStreamParser()(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'invalid model selection' } }));
    expect(r.result?.error).toBe('invalid model selection');
  });
});

describe('CLI health', () => {
  it('flags Claude CLI versions older than 2.1', () => {
    expect(isOutdated('2.0.37')).toBe(true);
    expect(isOutdated('1.9.0')).toBe(true);
    expect(isOutdated('2.1.0')).toBe(false);
    expect(isOutdated('3.0.0')).toBe(false);
    expect(isOutdated(undefined)).toBe(false);
  });

  it('turns terms/login prompts into actionable messages', () => {
    const terms = '[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect. You must run `claude` to review the updated terms.';
    expect(explainCliError('Claude CLI', terms)).toContain('jalankan `claude` sekali dan setujui');
    expect(explainCliError('Antigravity CLI', 'authentication required')).toContain('jalankan `agy` sekali untuk login');
    const revoked = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}';
    expect(explainCliError('Claude CLI', revoked)).toContain('jalankan `claude` sekali untuk login');
    expect(explainCliError('Claude CLI', 'Failed to authenticate: OAuth session expired and could not be refreshed')).toContain('untuk login');
    expect(explainCliError('Antigravity CLI', 'INVALID_ARGUMENT (code 400): Request contains an invalid argument.')).toContain('INVALID_ARGUMENT 400');
    expect(explainCliError('Claude CLI', 'boom')).toBe('boom');
  });
});
