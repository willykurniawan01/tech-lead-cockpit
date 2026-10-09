import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { resolveServicesRoot } from './services.ts';

/** Resolves repository filesystem path */
export async function resolveRepoPath(repo?: string, root?: string): Promise<{ repoName: string; repoPath: string }> {
  const cleanRepo = repo?.trim();
  if (!cleanRepo || cleanRepo === 'tech-lead-cockpit') {
    return { repoName: 'tech-lead-cockpit', repoPath: process.cwd() };
  }
  const resolvedRoot = await resolveServicesRoot(root);
  const repoPath = path.join(resolvedRoot, cleanRepo);
  const st = await stat(repoPath).catch(() => null);
  if (!st?.isDirectory()) {
    throw new Error(`Direktori repositori "${cleanRepo}" tidak ditemukan di ${resolvedRoot}.`);
  }
  return { repoName: cleanRepo, repoPath };
}
