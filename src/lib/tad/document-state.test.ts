import { describe, it, expect } from 'vitest';
import {
  TAD_DOCUMENT_STATES,
  extractDocumentState,
  updateDocumentState,
  getNextDocumentState,
  getPrevDocumentState,
  findDocumentStateDef,
} from './document-state';

describe('document-state', () => {
  const sampleMarkdown = `# TAD - Sample Service

| **Document Information** |   |
|---|---|
| Author | Willy |
| Last Update | 2026-10-01 |
| State | Initiate Document |
| Code Name | SAMPLE-SVC |

# Objective
Building awesome things.
`;

  it('has 6 pipeline stages in sequential steps', () => {
    expect(TAD_DOCUMENT_STATES.length).toBe(6);
    expect(TAD_DOCUMENT_STATES.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(TAD_DOCUMENT_STATES.map((s) => s.name)).toEqual([
      'Initiate Document',
      'In Review',
      'Approved',
      'In Development',
      'Testing',
      'Completed',
    ]);
  });

  it('extracts initial state from Document Information', () => {
    const extracted = extractDocumentState(sampleMarkdown);
    expect(extracted.state).toBe('Initiate Document');
    expect(extracted.def?.id).toBe('initiate-document');
    expect(extracted.isStandard).toBe(true);
  });

  it('extracts state with aliases or lowercase', () => {
    const md = sampleMarkdown.replace('Initiate Document', 'in review');
    const extracted = extractDocumentState(md);
    expect(extracted.state).toBe('In Review');
    expect(extracted.def?.id).toBe('in-review');
    expect(extracted.def?.colour).toBe('Blue');
  });

  it('updates state and last update date in Document Information', () => {
    const updated = updateDocumentState(sampleMarkdown, 'Approved');
    expect(updated).toContain('| State | Approved |');
    expect(updated).not.toContain('| State | Initiate Document |');

    const todayStr = new Date().toISOString().split('T')[0];
    expect(updated).toContain(`| Last Update | ${todayStr} |`);

    const extracted = extractDocumentState(updated);
    expect(extracted.state).toBe('Approved');
    expect(extracted.def?.colour).toBe('Green');
  });

  it('inserts State row if Document Information lacks one', () => {
    const mdNoState = `# TAD - Test
| **Document Information** |   |
|---|---|
| Author | Willy |
| Last Update | 2026-09-01 |
| Code Name | TEST |
`;
    const updated = updateDocumentState(mdNoState, 'In Development');
    expect(updated).toContain('| State | In Development |');
    const extracted = extractDocumentState(updated);
    expect(extracted.state).toBe('In Development');
  });

  it('gets next and previous states in pipeline', () => {
    expect(getNextDocumentState('Initiate Document')?.name).toBe('In Review');
    expect(getNextDocumentState('In Review')?.name).toBe('Approved');
    expect(getNextDocumentState('Approved')?.name).toBe('In Development');
    expect(getNextDocumentState('In Development')?.name).toBe('Testing');
    expect(getNextDocumentState('Testing')?.name).toBe('Completed');
    expect(getNextDocumentState('Completed')).toBeUndefined();

    expect(getPrevDocumentState('Completed')?.name).toBe('Testing');
    expect(getPrevDocumentState('In Review')?.name).toBe('Initiate Document');
    expect(getPrevDocumentState('Initiate Document')).toBeUndefined();
  });

  it('handles non-standard or custom state names', () => {
    const mdCustom = sampleMarkdown.replace('Initiate Document', 'On Hold (Legal)');
    const extracted = extractDocumentState(mdCustom);
    expect(extracted.state).toBe('On Hold (Legal)');
    expect(extracted.isStandard).toBe(false);
    expect(extracted.def).toBeUndefined();
  });
});
