import { describe, expect, it } from 'vitest';
import { applyHunks, buildHunks, lineDiff, storageToLines } from './diff';

describe('lineDiff', () => {
  it('finds added and removed lines', () => {
    const d = lineDiff(['a', 'b', 'c'], ['a', 'c', 'd']);
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'same', text: 'c' },
      { type: 'add', text: 'd' },
    ]);
  });
});

describe('storageToLines', () => {
  it('extracts readable text and drops macro parameters', () => {
    const lines = storageToLines('<h2>Judul</h2><p>A &amp; B</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro><table><tbody><tr><th>K</th><th>V</th></tr></tbody></table>');
    expect(lines).toEqual(['Judul', 'A & B', 'K | V']);
  });
});

describe('review hunks', () => {
  const base = ['# TAD', '', '## Objective', '', 'Lama', '', '## Scope', '', 'TODO', '', '## Detail', '', 'TODO detail'];
  const proposed = ['# TAD', '', '## Objective', '', 'Baru', '', '## Scope', '', '| 1 | Task A |', '| 2 | Task B |', '', '## Detail', '', 'TODO detail'];
  const diff = lineDiff(base, proposed);

  it('splits separate edits into blocks labelled with their section', () => {
    const hunks = buildHunks(diff);
    expect(hunks.map((h) => [h.section, h.added, h.removed])).toEqual([
      ['Objective', 1, 1],
      ['Scope', 2, 1],
    ]);
  });

  it('applies only accepted blocks', () => {
    const hunks = buildHunks(diff);
    expect(applyHunks(diff, hunks, new Set([0, 1]))).toBe(proposed.join('\n'));
    expect(applyHunks(diff, hunks, new Set())).toBe(base.join('\n'));
    const onlyScope = applyHunks(diff, hunks, new Set([1]));
    expect(onlyScope).toContain('Lama');
    expect(onlyScope).toContain('| 2 | Task B |');
    expect(onlyScope).not.toContain('Baru');
  });

  it('handles TAD-sized documents without falling back to a full replace', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `baris ${i}`);
    const edited = [...big.slice(0, 1000), 'baris baru', ...big.slice(1000, 2500), ...big.slice(2600)];
    const d = lineDiff(big, edited);
    const hunks = buildHunks(d);
    expect(hunks.map((h) => [h.added, h.removed])).toEqual([[1, 0], [0, 100]]);
    expect(applyHunks(d, hunks, new Set([0, 1]))).toBe(edited.join('\n'));
  });
});
