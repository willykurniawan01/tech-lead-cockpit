import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * The codebase folder the AI analyses (e.g. ~/Code/Services). It is only ever
 * read: the CLIs get read access, edits there are denied, and a git-status snapshot before and
 * after each job reports any repo that changed while the AI was running.
 */

export const DEFAULT_SERVICES_ROOT = '~/Code/Services';

export interface ServicesInfo {
  root: string;
  exists: boolean;
  services: string[];
  error?: string;
}

/** The configured codebase folder (setup wizard), else the built-in default. */
export function defaultServicesRoot(): string {
  return process.env.TLC_SERVICES_ROOT?.trim() || DEFAULT_SERVICES_ROOT;
}

/** Expands `~` and only accepts existing directories inside the user's home folder. */
export async function resolveServicesRoot(input: string | undefined): Promise<string> {
  const raw = (input?.trim() || defaultServicesRoot()).replace(/^~(?=$|\/)/, homedir());
  const root = resolve(raw);
  if (root !== homedir() && !root.startsWith(homedir() + sep)) throw new Error('Folder codebase harus berada di dalam folder home.');
  const s = await stat(root).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`Folder codebase tidak ditemukan: ${root}`);
  return root;
}

export async function servicesInfo(input: string | undefined): Promise<ServicesInfo> {
  try {
    const root = await resolveServicesRoot(input);
    const entries = await readdir(root, { withFileTypes: true });
    const services = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
    return { root, exists: true, services };
  } catch (e) {
    return { root: input || defaultServicesRoot(), exists: false, services: [], error: (e as Error).message };
  }
}

function gitStatus(repo: string): Promise<string> {
  return new Promise((done) => {
    const child = execFile('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=normal'], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) =>
      done(err ? '' : stdout),
    );
    child.stdin?.end();
  });
}

export type RepoSnapshot = Map<string, string>;

/** `git status --porcelain` for every git repo directly under the root (bounded concurrency). */
export async function snapshotRepos(root: string): Promise<RepoSnapshot> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const repos: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (await stat(join(root, e.name, '.git')).catch(() => null)) repos.push(e.name);
  }
  const snap: RepoSnapshot = new Map();
  for (let i = 0; i < repos.length; i += 8) {
    await Promise.all(repos.slice(i, i + 8).map(async (name) => snap.set(name, await gitStatus(join(root, name)))));
  }
  return snap;
}

/** Repos whose working tree changed between two snapshots, with the newly changed paths. */
export function diffSnapshots(before: RepoSnapshot, after: RepoSnapshot): { repo: string; files: string[] }[] {
  const changed: { repo: string; files: string[] }[] = [];
  for (const [repo, now] of after) {
    const was = before.get(repo) ?? '';
    if (now === was) continue;
    const old = new Set(was.split('\n'));
    const files = now.split('\n').filter((l) => l && !old.has(l)).map((l) => l.slice(3));
    changed.push({ repo, files: files.length ? files : ['(perubahan status)'] });
  }
  return changed;
}
