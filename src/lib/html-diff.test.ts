import { describe, expect, it } from 'vitest';
import { htmlDiff, sameText } from './html-diff';

describe('htmlDiff', () => {
  it('marks inserted and removed words inside the new structure', () => {
    expect(htmlDiff('<p>Ambil SOF lama</p>', '<p>Ambil SOF aktif</p>')).toBe('<p>Ambil SOF <del class="tc-del">lama</del><ins class="tc-add">aktif</ins></p>');
  });

  it('shows new blocks as insertions with their own tags', () => {
    expect(htmlDiff('<p>a</p>', '<p>a</p><p>baru</p>')).toBe('<p>a</p><p><ins class="tc-add">baru</ins></p>');
  });

  it('keeps tables valid: changes inside cells inline, removed rows as struck-out rows', () => {
    const before = '<table><tbody><tr><td>Method</td><td>GET</td></tr><tr><td>Header</td><td>Auth</td></tr></tbody></table>';
    const after = '<table><tbody><tr><td>Method</td><td>POST</td></tr></tbody></table>';
    const out = htmlDiff(before, after);
    expect(out).toContain('<ins class="tc-add">POST</ins>');
    expect(out).toMatch(/<del class="tc-del">GET[^<]*<br>Header │ Auth/);
    const div = document.createElement('div');
    div.innerHTML = out;
    expect(div.firstElementChild?.tagName).toBe('TABLE'); // nothing pushed out above the table
  });

  it('detects markup-only differences', () => {
    expect(sameText('<p>a <b>b</b></p>', '<p>a <i>b</i></p>')).toBe(true);
    expect(sameText('<p>a</p>', '<p>b</p>')).toBe(false);
  });
});
