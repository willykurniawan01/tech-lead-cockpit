import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { TraceEvidence } from '../../src/lib/trace/types.ts';
import { SAFE_PATH } from './prompt.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CONTEXT = 2;

/**
 * Checks each piece of evidence against the real codebase: the file exists inside the Services
 * root and the cited line is in range. Verified evidence gets the lines around it, so the Tech
 * Lead sees the actual code instead of the AI's word for it.
 */
export async function verifyEvidence(servicesRoot: string, evidence: TraceEvidence[]): Promise<TraceEvidence[]> {
  const root = await realpath(servicesRoot).catch(() => servicesRoot);
  const cache = new Map<string, string[] | null>();
  const lines = async (file: string): Promise<string[] | null> => {
    if (cache.has(file)) return cache.get(file)!;
    let out: string[] | null = null;
    try {
      const abs = await realpath(join(root, file));
      if (abs.startsWith(root + sep)) {
        const st = await stat(abs);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) out = (await readFile(abs, 'utf8')).split('\n');
      }
    } catch {
      out = null;
    }
    cache.set(file, out);
    return out;
  };
  return Promise.all(
    evidence.map(async (e) => {
      if (!SAFE_PATH.test(e.file)) return { ...e, verified: false, snippet: undefined };
      const src = await lines(e.file);
      if (!src) return { ...e, verified: false, snippet: undefined };
      if (e.line === undefined) return { ...e, verified: true, snippet: undefined };
      if (e.line > src.length) return { ...e, verified: false, snippet: undefined };
      const from = Math.max(1, e.line - CONTEXT);
      const to = Math.min(src.length, e.line + CONTEXT);
      const snippet = src
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}${from + i === e.line ? ' ▶ ' : '   '}${l.slice(0, 300)}`)
        .join('\n');
      return { ...e, verified: true, snippet };
    }),
  );
}

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile('git', ['-C', cwd, ...args], { timeout: 10_000 }, (err, out) => resolve(err ? '' : out.trim())));

/** Branch and commit of each repo, so a later reader knows which code the answer describes. */
export async function repoVersions(servicesRoot: string, repos: string[]): Promise<{ repo: string; branch: string; commit: string }[]> {
  const out: { repo: string; branch: string; commit: string }[] = [];
  for (const repo of [...new Set(repos)].filter((r) => /^[A-Za-z0-9._-]+$/.test(r)).slice(0, 12)) {
    const dir = join(servicesRoot, repo);
    const commit = await git(dir, ['rev-parse', '--short', 'HEAD']);
    if (!commit) continue;
    out.push({ repo, branch: (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD', commit });
  }
  return out;
}
