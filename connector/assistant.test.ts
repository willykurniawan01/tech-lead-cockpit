// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ASSISTANT_SYSTEM_PROMPTS, buildAssistantPrompt, STRICTNESS_GUIDELINES } from './assistant.ts';

describe('Assistant System Prompts', () => {
  it('defines prompts for all assistant modes', () => {
    expect(ASSISTANT_SYSTEM_PROMPTS['code-review']).toContain('Code Review');
    expect(ASSISTANT_SYSTEM_PROMPTS['security']).toContain('OWASP');
    expect(ASSISTANT_SYSTEM_PROMPTS['performance']).toContain('performa');
    expect(ASSISTANT_SYSTEM_PROMPTS['architecture']).toContain('Clean Architecture');
    expect(ASSISTANT_SYSTEM_PROMPTS['general']).toContain('Tech Lead');
  });
});

describe('buildAssistantPrompt', () => {
  it('returns plain prompt when context is absent or empty', () => {
    expect(buildAssistantPrompt('Jelaskan konsep CQRS')).toBe('Jelaskan konsep CQRS');
    expect(buildAssistantPrompt('Jelaskan konsep CQRS', '   ')).toBe('Jelaskan konsep CQRS');
  });

  it('embeds code snippet or diff context when provided', () => {
    const prompt = buildAssistantPrompt('Review apakah ada memory leak', 'func worker() { go func() {}() }');
    expect(prompt).toContain('### KODE / DIFF YANG DIREVIEW:');
    expect(prompt).toContain('func worker()');
    expect(prompt).toContain('Review apakah ada memory leak');
  });
});

describe('STRICTNESS_GUIDELINES', () => {
  it('defines guidelines for lenient, standard, and strict levels', () => {
    expect(STRICTNESS_GUIDELINES.lenient).toContain('SANTAI');
    expect(STRICTNESS_GUIDELINES.standard).toContain('STANDAR');
    expect(STRICTNESS_GUIDELINES.strict).toContain('SANGAT KETAT');
  });
});

