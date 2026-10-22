import { access, chmod, cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { QAStoreMigration } from '../../src/lib/qa/types.ts';
import { QaInputError } from './manager.ts';
import { bare, type FileQaStore, type QaStore } from './store.ts';

/**
 * "Pindahkan data lokal ke DB pusat": copies the file store into the shared database. The whole
 * qa folder is backed up first; nothing in the database is overwritten (an item already there
 * with different content is listed as skipped), and the local files stay where they are.
 * Safe to run again: what is already there with the same content is left alone.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** JSON with sorted keys: the database (jsonb) does not keep key order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Same content, whoever saved it and when. */
function sameContent(a: object, b: object): boolean {
  const strip = (x: object) => {
    const { updatedAt: _t, ...rest } = bare(x as { version?: number; updatedBy?: string; updatedAt?: string });
    return rest;
  };
  return stableJson(strip(a)) === stableJson(strip(b));
}

async function ids(dir: string, files: boolean): Promise<string[]> {
  const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return names
    .filter((d) => (files ? d.isFile() && d.name.endsWith('.json') : d.isDirectory()))
    .map((d) => d.name.replace(/\.json$/, ''))
    .filter((n) => ID.test(n));
}

export async function moveToCentral(source: FileQaStore, target: QaStore, opts: { backupRoot: string; by?: string; now?: Date }): Promise<QAStoreMigration> {
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backupDir = join(opts.backupRoot, `${stamp}-before-central`);
  if (!(await access(source.dir).then(() => true, () => false))) throw new QaInputError('Tidak ada data E2E lokal untuk dipindahkan.');
  await mkdir(opts.backupRoot, { recursive: true, mode: 0o700 });
  await chmod(opts.backupRoot, 0o700).catch(() => {});
  // Backup first: if it fails, nothing is moved.
  await cp(source.dir, backupDir, { recursive: true, errorOnExist: true, force: false });

  const out: QAStoreMigration = { backupDir, projects: 0, suites: 0, plans: 0, environments: 0, runs: 0, skipped: [] };
  const projectIds = [...new Set([...(await ids(join(source.dir, 'suites'), true)), ...(await ids(join(source.dir, 'plans'), true)), ...(await ids(join(source.dir, 'runs'), false))])];
  const knownProjects = new Map((await target.listProjects()).map((p) => [p.id, p]));
  const localProjects = new Map((await source.listProjects()).map((p) => [p.id, p]));

  for (const id of projectIds) {
    const suite = await source.getSuite(id);
    const plan = await source.getPlan(id);
    const name = localProjects.get(id)?.name ?? suite?.projectName ?? plan?.projectName ?? id;

    if (suite) {
      const there = await target.getSuite(id);
      if (!there) {
        await target.saveSuite({ ...suite, version: 0 }, opts.by);
        out.suites++;
      } else if (!sameContent(suite, there)) out.skipped.push(`Test case ${name}: sudah ada di DB pusat dengan isi berbeda (diubah ${there.updatedBy ?? 'orang lain'}).`);
    }
    if (plan) {
      const there = await target.getPlan(id);
      if (!there) {
        await target.savePlan({ ...plan, version: 0 }, opts.by);
        out.plans++;
      } else if (!sameContent(plan, there)) out.skipped.push(`Rencana journey ${name}: sudah ada di DB pusat dengan isi berbeda.`);
    }
    // Runs never change once finished: the ones missing are added, oldest first (newest are kept on pruning).
    const have = new Set((await target.listRuns(id)).map((r) => r.id));
    for (const run of (await source.listRuns(id)).reverse()) {
      if (have.has(run.id) || run.status === 'running') continue;
      await target.saveRun(run, opts.by);
      out.runs++;
    }
    if (!knownProjects.has(id)) {
      await target.upsertProject({ id, name, tads: localProjects.get(id)?.tads ?? [] }, opts.by);
      out.projects++;
    }
  }

  const central = new Map((await target.listEnvironments()).map((e) => [e.id, e]));
  for (const env of await source.listEnvironments()) {
    const there = central.get(env.id);
    if (!there) {
      await target.saveEnvironment({ ...env, version: 0 }, opts.by);
      out.environments++;
    } else if (!sameContent(env, there)) out.skipped.push(`Environment ${env.name}: sudah ada di DB pusat dengan isi berbeda.`);
  }
  return out;
}
