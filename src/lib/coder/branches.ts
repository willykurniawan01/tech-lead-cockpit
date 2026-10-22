/** Base branches tried in this order when none is picked: the setting's default, then the usual names. */
export const BASE_CANDIDATES = ['staging', 'development', 'develop', 'main', 'master'];

/** The branch a run should start from: the first wanted one that exists, else the repo's default branch. */
export function pickBaseBranch(branches: string[], wanted: (string | undefined)[], head?: string): string | undefined {
  for (const b of [...wanted, ...BASE_CANDIDATES]) if (b && branches.includes(b)) return b;
  return head && branches.includes(head) ? head : branches[0];
}

/** `feature/MU-9-…` with a Jira key; without one `agent-` marks a TAD task, `noKey = ''` (fixes) gives a plain `fix/<slug>`. */
export function branchName(jiraKey: string | undefined, title: string, prefix: 'feature' | 'fix' = 'feature', noKey = 'agent-'): string {
  const name = title.replace(/^\[[^\]]*\](\[[^\]]*\])*\s*-?\s*/, '');
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return `${prefix}/${jiraKey ? `${jiraKey}-` : noKey}${slug || 'task'}`;
}

/**
 * Why a branch name typed by the user can't be used; undefined when it can. A safe subset of git's
 * ref rules: letters, digits, `.` `_` `-` `/`, no `..`, no empty or dot-led parts, no `.lock`.
 */
export function branchNameError(name: string): string | undefined {
  const b = name.trim();
  if (!b) return 'Nama branch kosong.';
  if (b.length > 120) return 'Nama branch maksimal 120 karakter.';
  if (!/^[A-Za-z0-9._/-]+$/.test(b)) return 'Nama branch hanya boleh huruf, angka, titik, garis bawah, strip, dan garis miring (tanpa spasi).';
  if (b.includes('..') || b.includes('//') || /^[-/.]|[/.]$/.test(b) || b.endsWith('.lock') || b.split('/').some((p) => p.startsWith('.'))) return 'Nama branch tidak valid untuk git (mis. ada "..", "//", atau diawali/diakhiri "/" atau ".").';
  if (['HEAD', 'main', 'master', 'staging', 'development', 'develop'].includes(b)) return `Branch ${b} adalah branch utama; pakai nama branch baru untuk perbaikan.`;
  return undefined;
}
