import { describe, expect, it } from 'vitest';
import { buildMerged, mergeSummary, splitSections, threeWayMerge } from './merge';

const doc = (parts: Record<string, string>) =>
  Object.entries(parts)
    .map(([h, body]) => `${h}\n\n${body}`)
    .join('\n\n');

const BASE = doc({
  '# TAD - X': '| Author | @Willy |',
  '# Objective': 'Tujuan awal.',
  '# Detail Task': '',
  '## [BACKEND][S][X] - API A': '#### Description\n\nAPI A lama.',
  '## [BACKEND][S][X] - API B': '#### Description\n\nAPI B lama.',
  '## [BACKEND][S][X] - API C': '#### Description\n\nAPI C.',
});

describe('splitSections', () => {
  it('cuts at # and ## outside code fences and numbers repeated headings', () => {
    const s = splitSections('intro\n\n# A\n\nx\n\n```\n# bukan heading\n```\n\n## B\n\ny\n\n## B\n\nz');
    expect(s.map((x) => x.key)).toEqual(['(awal dokumen)', 'a', 'b', 'b#2']);
    expect(s[1].text).toContain('# bukan heading');
  });
});

describe('threeWayMerge', () => {
  it('takes Confluence-only edits, keeps Cockpit-only edits and flags edits on both sides', () => {
    const local = BASE.replace('Tujuan awal.', 'Tujuan diubah di Cockpit.').replace('API B lama.', 'API B versi Cockpit.');
    const remote = BASE.replace('API A lama.', 'API A diubah di Confluence.').replace('API B lama.', 'API B versi Confluence.');
    const sections = threeWayMerge(BASE, local, remote);
    const by = (k: string) => sections.find((s) => s.key.includes(k))!;
    expect(by('objective')).toMatchObject({ status: 'local', choice: 'local' });
    expect(by('api a')).toMatchObject({ status: 'remote', choice: 'remote' });
    expect(by('api b')).toMatchObject({ status: 'conflict', choice: 'local' });
    expect(by('api c').status).toBe('same');
    expect(mergeSummary(sections)).toEqual({ fromRemote: 1, keptLocal: 1, conflicts: 1, same: 3 });

    const merged = buildMerged(sections);
    expect(merged).toContain('Tujuan diubah di Cockpit.');
    expect(merged).toContain('API A diubah di Confluence.');
    expect(merged).toContain('API B versi Cockpit.');
    by('api b').choice = 'remote';
    expect(buildMerged(sections)).toContain('API B versi Confluence.');
  });

  it('handles sections added and removed on either side, in Confluence order', () => {
    const local = BASE + '\n\n## [BACKEND][S][X] - API Lokal\n\nBaru di Cockpit.';
    const remote = BASE.replace(/## \[BACKEND\]\[S\]\[X\] - API C[\s\S]*$/, '## [BACKEND][S][X] - API Remote\n\nBaru di Confluence.');
    const sections = threeWayMerge(BASE, local, remote);
    const st = Object.fromEntries(sections.map((s) => [s.key, s.status]));
    expect(st['[backend][s][x] - api remote']).toBe('added-remote');
    expect(st['[backend][s][x] - api lokal']).toBe('added-local');
    expect(st['[backend][s][x] - api c']).toBe('removed-remote');
    const merged = buildMerged(sections);
    expect(merged).toContain('Baru di Confluence.');
    expect(merged).toContain('Baru di Cockpit.');
    expect(merged).not.toContain('API C.');
  });

  it('does not see a change where only the mention format or spacing differs', () => {
    const local = BASE.replace('@Willy', '<span data-tlc-user="abc">@Willy</span>').replace('Tujuan awal.', 'Tujuan   awal.');
    const sections = threeWayMerge(BASE, local, BASE);
    expect(sections.every((s) => s.status === 'same')).toBe(true);
    // The draft's own text (with the mention id) is what stays.
    expect(buildMerged(sections)).toContain('<span data-tlc-user="abc">@Willy</span>');
  });
});
