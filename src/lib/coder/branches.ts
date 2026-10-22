/** Base branches tried in this order when none is picked: the setting's default, then the usual names. */
export const BASE_CANDIDATES = ['staging', 'development', 'develop', 'main', 'master'];

/** The branch a run should start from: the first wanted one that exists, else the repo's default branch. */
export function pickBaseBranch(branches: string[], wanted: (string | undefined)[], head?: string): string | undefined {
  for (const b of [...wanted, ...BASE_CANDIDATES]) if (b && branches.includes(b)) return b;
  return head && branches.includes(head) ? head : branches[0];
}
