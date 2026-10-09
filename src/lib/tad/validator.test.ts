import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { parsePrd } from '../prd/parser';
import { AI_PENDING, blankTad, generateTadSkeleton } from './generator';
import { validateMermaid, validateTad } from './validator';

const SAMPLE_PRD = `# PRD - Login Flow

| **Tribe** | AUTH |
| --- | --- |
| **Document owner** | @Novskia |
| **Tech lead** | @Willy |

## Objective

Fitur login user dengan PIN dan password.

## Requirements

|  | **User Story** | **Keyword** | **Requirement** | **Interface** |
| --- | --- | --- | --- | --- |
| 1 | as User | **Login User** | Validasi PIN | https://figma.com/login |
| 2 | as User | **Reset PIN** | Kirim OTP | https://figma.com/reset |
`;


/** Skeleton plus two hand-written tasks, standing in for what the AI produces. */
function withTasks(md: string): string {
  const be = '[BACKEND][CORE-AUTH][AUTH] - Develop API Login User';
  const fe = '[MOBILE-FE][MOBILE-APP][AUTH] - Slicing UI Reset PIN';
  const scope = ['|   | **Service Name** | **Task Name** | **Jira Task** |', '|---|---|---|---|', `| 1 | CORE-AUTH | ${be} | Belum dibuat |`, `| 2 | MOBILE-APP | ${fe} | Belum dibuat |`].join('\n');
  const detail = [`## ${be}`, '', '#### Description', '', 'Validasi PIN (REQ-1).', '', `## ${fe}`, '', '#### Description', '', 'Kirim OTP (REQ-2).'].join('\n');
  const scopeAt = md.indexOf('# Development Scope');
  const detailAt = md.indexOf('# Detail Task');
  return md.slice(0, scopeAt) + `# Development Scope\n\n${scope}\n\n# Detail Task\n\n${detail}\n`;
}

describe('validateTad', () => {
  it('generates a skeleton without invented tasks, leaving scope to the AI', () => {
    const prd = parsePrd(SAMPLE_PRD);
    const md = generateTadSkeleton(prd, { supportingDocs: ['openapi-partner.yaml'] });
    const result = validateTad(md, prd);
    expect(result.errorCount).toBe(0);
    expect(result.sections.every((s) => s.status !== 'missing')).toBe(true);
    expect(result.scopeTasks).toHaveLength(0);
    expect(md).toContain(AI_PENDING);
    expect(md).toContain('openapi-partner.yaml');
    expect(md).toContain('[Figma');
  });

  it('accepts a TAD whose scope and detail tasks match', () => {
    const prd = parsePrd(SAMPLE_PRD);
    const result = validateTad(withTasks(generateTadSkeleton(prd)), prd);
    expect(result.errorCount).toBe(0);
    expect(result.scopeTasks).toHaveLength(2);
    expect(result.detailTasks).toHaveLength(2);
    expect(result.issues.some((i) => i.code === 'uncovered-requirement')).toBe(false);
  });

  it('detects when a task in Development Scope is missing Detail Task', () => {
    const prd = parsePrd(SAMPLE_PRD);
    let md = withTasks(generateTadSkeleton(prd));
    // Add extra task to Development Scope table
    md = md.replace('| 1 | CORE-AUTH |', '| 99 | CORE-EXTRA | [BACKEND][CORE-EXTRA][AUTH] - Develop Ghost Task | Belum dibuat |\n| 1 | CORE-AUTH |');
    const result = validateTad(md, prd);
    const missing = result.issues.find((i) => i.code === 'task-missing-detail');
    expect(missing).toBeDefined();
    expect(missing?.message).toContain('Ghost Task');
  });

  it('detects invalid task type', () => {
    const prd = parsePrd(SAMPLE_PRD);
    let md = withTasks(generateTadSkeleton(prd));
    md = md.replace('[BACKEND]', '[DATABASE]');
    const result = validateTad(md, prd);
    const inv = result.issues.find((i) => i.code === 'invalid-task-type');
    expect(inv).toBeDefined();
    expect(inv?.message).toContain('DATABASE');
  });

  it('detects uncovered PRD requirements', () => {
    const prd = parsePrd(SAMPLE_PRD);
    // Add extra unreferenced requirement
    prd.requirements.push({
      id: '3',
      userStory: 'as User',
      keyword: 'Biometric Login',
      requirement: 'Support Face ID',
      interfaces: [],
    });
    const result = validateTad(withTasks(generateTadSkeleton(prd)), prd);
    const uncov = result.issues.find((i) => i.code === 'uncovered-requirement');
    expect(uncov).toBeDefined();
    expect(uncov?.message).toContain('Biometric Login');
  });

  it('validates blankTad without missing sections', () => {
    const md = blankTad('Test System');
    const result = validateTad(md);
    expect(result.errorCount).toBe(0);
    expect(result.sections.every((s) => s.status !== 'missing')).toBe(true);
  });

  it('validates actual TAD - Motion Circle.md if available', () => {
    const filePath = '/Users/willykurniawan/Documents/MTN & FM/Motion Circle/TAD - Motion Circle.md';
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const result = validateTad(content);
      expect(result.scopeTasks.length).toBe(30);
      expect(result.detailTasks.length).toBe(29);
      // Correctly catches missing Detail Task for Krakend task in Motion Circle TAD
      const missingKrakend = result.issues.find((i) => i.code === 'task-missing-detail' && i.message.includes('KRAKEND'));
      expect(missingKrakend).toBeDefined();
    }
  });
});

describe('validateMermaid', () => {
  it('reports syntax error in mermaid block', async () => {
    const md = '```mermaid\nbroken syntax\n```';
    const issues = await validateMermaid(md, async (code) => {
      if (code === 'broken syntax') throw new Error('Syntax error');
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('mermaid');
  });
});
