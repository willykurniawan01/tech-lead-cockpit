import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiSelection } from '../../src/lib/ai/types.ts';
import type { QAEnvImportAction, QAEnvImportPreview, QARunEvidence, QASuiteReview } from '../../src/lib/qa/types.ts';
import { evidenceStorage, evidenceTitle } from '../../src/lib/qa/evidence.ts';
import type { QAAgentJob, QADatabase, QADbConnection, QADbResult, QADbServer, QAEnvironment, QAPipeline, QAPlan, QAProject, QASuspect, QAFlow, QAFlowResult, QAGenerateJob, QAGenerateRequest, QARun, QARunRequest, QASuite, QATadRef } from '../../src/lib/qa/types.ts';
import { executeSetup, listDatabases, QaDbError, queryReadOnly, schemaSummary, testConnection } from './db.ts';
import { matchDatabases } from '../../src/lib/qa/db-match.ts';
import { buildQaPrompt, dedupeStepIds, parseQaReply, QA_SYSTEM_PROMPT } from './generator.ts';
import { arrangeFlows, groupOrder } from '../../src/lib/qa/groups.ts';
import { mergeSuites } from '../../src/lib/qa/merge.ts';
import { buildFixPrompt, buildPlanPrompt, buildRepairPrompt, checkFlowsAgainstPlan, evidenceMentions, FIX_SYSTEM_PROMPT, parseFix, parsePlan, parseRepair, PLAN_SYSTEM_PROMPT, REPAIR_SYSTEM_PROMPT } from './plan.ts';
import { verifyEvidence } from '../trace/verify.ts';
import { declaredTypes, runFlow, summarize } from './runner.ts';
import { DATA_DIR } from '../paths.ts';
import { DraftedQaStore } from './drafts.ts';
import { buildExport, decryptSecrets, describeSecrets, type EnvExportFile, type EnvSecrets, readExport } from './env-transfer.ts';
import { FileQaStore, QaConflictError, type QaStore } from './store.ts';

/**
 * E2E state: environments, one suite per project and its run history, kept in a QaStore: files
 * under ~/.tech-lead-cockpit/qa (0700), or the shared PostgreSQL database chosen in Settings.
 * Environment secrets live in the Keychain, never in the store. Generation and runs are background
 * jobs the UI polls, so a reload doesn't lose them.
 */

export const QA_KEYCHAIN_SERVICE = 'tech-lead-cockpit.qa';
/** Reading the codebase makes generation slower. */
const GENERATE_TIMEOUT_MS = 20 * 60_000;
/** Background agents re-read and reapply their change when someone saved the suite in between. */
const SAVE_ATTEMPTS = 3;
/** Pipeline agents running at once (writers, repairers); the CLI's usage limits are shared. */
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 5;
const MAX_REPAIRS = 15;
/** Flows per fix-by-instruction run, and per agent (small batches keep each answer short and exact). */
const MAX_FIX_FLOWS = 80;
const FIX_BATCH = 5;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export class QaInputError extends Error {}

export interface QaDeps {
  /** Folder of the file store (also where suites from before projects existed are adopted from). */
  dir?: string;
  /** The store in use (Settings: files or the shared database); the file store in `dir` when absent. */
  store?: () => QaStore | undefined;
  /** Who is saving (name or email from Settings), recorded as updated_by. */
  actor?: () => Promise<string | undefined>;
  /** `key` is the environment id, or `<id>:vars` for its secret variables (a JSON object). */
  readSecret: (key: string) => Promise<string | null>;
  writeSecret: (key: string, value: string) => Promise<boolean>;
  deleteSecret: (key: string) => Promise<boolean>;
  runAi: (ai: AiSelection, prompt: string, opts: { cwd: string; timeoutMs: number; systemPrompt: string; readOnlyDirs?: string[]; onProgress: (text: string) => void }) => {
    done: Promise<{ reply: string; error?: string }>;
    cancel: () => void;
  };
  fetch?: typeof fetch;
  /** The Services codebase the AI may read (read-only) while generating. */
  resolveServicesRoot?: (input: string) => Promise<string>;
  /** Snapshot of the repos' working trees; the returned function lists repos changed since. */
  watchRepos?: (root: string) => Promise<() => Promise<string[]>>;
  /** Mirrors a pipeline agent into Agent Tasks; returns the task id it is listed under. */
  agentSink?: (job: QAAgentJob, projectName: string) => Promise<string | undefined>;
  /** Database access (PostgreSQL): read-only queries, and `execute` for test setup; tests inject a fake. */
  db?: {
    query: (db: QADbConnection, password: string | undefined, sql: string) => Promise<QADbResult>;
    schema: (db: QADbConnection, password: string | undefined) => Promise<string>;
    test: (db: QADbConnection, password: string | undefined) => Promise<string>;
    list: (server: QADbConnection, password: string | undefined) => Promise<string[]>;
    execute?: (db: QADbConnection, password: string | undefined, sql: string) => Promise<QADbResult>;
  };
}

const REAL_DB = { query: queryReadOnly, schema: schemaSummary, test: testConnection, list: listDatabases, execute: executeSetup };
const DB_NAME = /^[A-Za-z][\w.-]{0,79}$/;
const MAX_DATABASES = 80;
/** Databases whose schema the AI reads in one generation (the selected tasks' services). */
const MAX_SCHEMA_DBS = 8;
const dbSecretKey = (envId: string, name: string) => `${envId}:db:${name}`;
const serverSecretKey = (envId: string) => `${envId}:dbserver`;

function cleanServer(raw: unknown): QADbServer | undefined {
  const d = (raw ?? {}) as Partial<QADbServer>;
  const host = String(d.host ?? '').trim();
  if (!host) return undefined;
  if (!/^[\w.-]{1,253}$/.test(host)) throw new QaInputError('Host server database tidak valid.');
  const user = String(d.user ?? '').trim();
  if (!user) throw new QaInputError('User server database wajib diisi.');
  const port = Number(d.port) || 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new QaInputError('Port server database tidak valid.');
  return { host, port, user: user.slice(0, 100), ...(d.ssl ? { ssl: true } : {}) };
}

function cleanDatabases(raw: unknown): QADatabase[] {
  const out: QADatabase[] = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_DATABASES) : []) {
    const d = (item ?? {}) as Partial<QADatabase>;
    const service = String(d.service ?? '').trim();
    const name = String(d.name ?? '').trim() || service;
    const database = String(d.database ?? '').trim();
    if (!name && !database) continue;
    if (!DB_NAME.test(name)) throw new QaInputError(`Nama database "${name}" tidak valid (huruf, angka, titik, - atau _).`);
    if (out.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new QaInputError(`"${name}" dipetakan dua kali.`);
    if (!database || !/^[\w.$-]{1,100}$/.test(database)) throw new QaInputError(`${name}: nama database tidak valid.`);
    const host = String(d.host ?? '').trim();
    if (host && !/^[\w.-]{1,253}$/.test(host)) throw new QaInputError(`${name}: host tidak valid.`);
    const port = Number(d.port);
    out.push({
      name,
      ...(service ? { service: service.slice(0, 100) } : {}),
      database,
      ...(host ? { host, ...(Number.isInteger(port) && port > 0 && port < 65_536 ? { port } : {}), ...(d.user ? { user: String(d.user).trim().slice(0, 100) } : {}), ...(d.ssl ? { ssl: true } : {}) } : {}),
    });
  }
  return out;
}

const httpUrl = (v: string) => /^https?:\/\/[^\s/]+/i.test(v);

function cleanRecord(v: unknown, what: string, check?: (k: string, val: string) => void): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new QaInputError(`${what} harus berupa objek.`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    const key = k.trim();
    if (!key) continue;
    if (key.length > 100) throw new QaInputError(`${what}: nama "${key.slice(0, 20)}…" terlalu panjang.`);
    const value = String(val ?? '').trim();
    check?.(key, value);
    out[key] = value;
  }
  return out;
}

export function validateEnvironment(raw: Partial<QAEnvironment>): QAEnvironment {
  const name = String(raw.name ?? '').trim().slice(0, 80);
  if (!name) throw new QaInputError('Nama environment wajib diisi.');
  const baseUrl = String(raw.baseUrl ?? '').trim();
  if (baseUrl && !httpUrl(baseUrl)) throw new QaInputError('Base URL harus diawali http:// atau https://.');
  const services = cleanRecord(raw.services, 'URL service', (k, v) => {
    if (v && !httpUrl(v)) throw new QaInputError(`URL service "${k}" harus diawali http:// atau https://.`);
  });
  if (!baseUrl && !Object.values(services).some(Boolean)) throw new QaInputError('Isi base URL default atau minimal satu URL service.');
  const authType = raw.auth?.type ?? 'none';
  if (!['none', 'bearer', 'basic', 'header'].includes(authType)) throw new QaInputError('Tipe auth tidak dikenal.');
  const headerName = String(raw.auth?.headerName ?? '').trim();
  if (authType === 'header' && !/^[\w-]{1,100}$/.test(headerName)) throw new QaInputError('Nama header auth tidak valid.');
  const timeoutMs = Number(raw.timeoutMs ?? 30_000);
  return {
    id: raw.id && ID.test(raw.id) ? raw.id : '',
    name,
    baseUrl,
    services,
    headers: cleanRecord(raw.headers, 'Header'),
    variables: cleanRecord(raw.variables, 'Variabel'),
    auth: { type: authType, ...(authType === 'header' ? { headerName } : {}), ...(authType === 'basic' ? { username: String(raw.auth?.username ?? '').trim() } : {}) },
    readOnly: raw.readOnly === true,
    // Test setup may change data only when asked for, and never on a read-only environment.
    ...(raw.dbWrites === true && raw.readOnly !== true ? { dbWrites: true } : {}),
    dbServer: cleanServer(raw.dbServer),
    databases: cleanDatabases(raw.databases),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 1_000), 300_000) : 30_000,
    // The version it was loaded with: a save over someone else's newer one is refused.
    ...(Number.isInteger(raw.version) && Number(raw.version) >= 0 ? { version: Number(raw.version) } : {}),
  };
}

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'env';
  return `${base}-${randomUUID().slice(0, 6)}`;
}

/** A suite as handed out: its version, and its draft revision while changes wait for review. */
const servedKey = (s: QASuite) => `${s.projectId}@${s.version ?? 0}.${s.draftRev ?? '-'}`;

export class QaManager {
  private readonly dir: string;
  private readonly fileStore: FileQaStore;
  private readonly jobs = new Map<string, QAGenerateJob & { cancel?: () => void }>();
  private readonly runs = new Map<string, { run: QARun; cancelled: boolean }>();
  private readonly pipelines = new Map<string, QAPipeline>();
  /** Cancel functions of running pipeline agents, and agents asked to stop. */
  private readonly agentCancels = new Map<string, () => void>();
  private readonly agentStopped = new Set<string>();
  /** Suites as last handed out, per version: the base for merging a save that lost a race. */
  private readonly served = new Map<string, QASuite>();

  constructor(private readonly deps: QaDeps) {
    this.dir = deps.dir ?? join(DATA_DIR, 'qa');
    this.fileStore = new FileQaStore(this.dir);
  }

  /** The store chosen in Settings (resolved per call, so a change applies without a restart). */
  get store(): QaStore {
    return this.deps.store?.() ?? this.fileStore;
  }

  private async actor(): Promise<string | undefined> {
    return (await this.deps.actor?.().catch(() => undefined)) || undefined;
  }

  /** Only for the per-TAD suites from before projects existed (always files). */
  private async read<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private projectId(id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new QaInputError('Id proyek tidak valid.');
    return id;
  }

  // Environments ---------------------------------------------------------------------------

  /** A generation or run is in progress (only in this process's memory). */
  isBusy(): boolean {
    return (
      [...this.jobs.values()].some((j) => j.status === 'running') ||
      [...this.runs.values()].some((r) => r.run.status === 'running') ||
      [...this.pipelines.values()].some((p) => p.agents.some((a) => a.status === 'running' || a.status === 'queued'))
    );
  }

  /**
   * Databases saved before servers existed (each with its own host): when they share one server,
   * that becomes the environment's server (password copied), and each gets its service guessed
   * from the database name. Runs once per environment. Returns the environments it changed.
   */
  private async migrateDatabases(envs: QAEnvironment[]): Promise<QAEnvironment[]> {
    const changed: QAEnvironment[] = [];
    for (const env of envs) {
      const legacy = (env.databases ?? []).filter((d) => d.host);
      if (env.dbServer || !legacy.length) continue;
      const first = legacy[0];
      if (!legacy.every((d) => d.host === first.host && (d.port ?? 5432) === (first.port ?? 5432) && d.user === first.user)) continue;
      env.dbServer = { host: first.host!, port: first.port ?? 5432, user: first.user ?? '', ...(first.ssl ? { ssl: true } : {}) };
      const password = await this.deps.readSecret(dbSecretKey(env.id, first.name));
      if (password && !(await this.deps.readSecret(serverSecretKey(env.id)))) await this.deps.writeSecret(serverSecretKey(env.id), password);
      const guesses = matchDatabases(Object.keys(env.services), legacy.map((d) => d.database));
      env.databases = (env.databases ?? []).map((d) => {
        if (!d.host) return d;
        const service = d.service ?? Object.entries(guesses).find(([, db]) => db === d.database)?.[0];
        void this.deps.deleteSecret(dbSecretKey(env.id, d.name));
        return { name: service ?? d.name, ...(service ? { service } : {}), database: d.database };
      });
      changed.push(env);
    }
    return changed;
  }

  async listEnvironments(): Promise<QAEnvironment[]> {
    let envs = await this.store.listEnvironments();
    const migrated = await this.migrateDatabases(envs);
    if (migrated.length) {
      const by = await this.actor();
      // Someone else saving first is fine: their copy is migrated the next time.
      for (const env of migrated) await this.store.saveEnvironment(env, by).catch((e) => { if (!(e instanceof QaConflictError)) throw e; });
      envs = await this.store.listEnvironments();
    }
    return Promise.all(
      envs.map(async (e) => ({
        ...e,
        hasSecret: Boolean(await this.deps.readSecret(e.id)),
        secretVariableNames: Object.keys(await this.secretVariables(e.id)),
        dbServerPassword: Boolean(await this.deps.readSecret(serverSecretKey(e.id))),
        dbPasswords: Object.fromEntries(await Promise.all((e.databases ?? []).filter((d) => d.host).map(async (d) => [d.name, Boolean(await this.deps.readSecret(dbSecretKey(e.id, d.name)))] as const))),
      })),
    );
  }

  private async secretVariables(envId: string): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse((await this.deps.readSecret(`${envId}:vars`)) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  /**
   * `secret`: undefined keeps the stored one, '' removes it. `secretVariables`: undefined keeps
   * them; an object replaces them, where an empty value keeps that variable's stored value.
   */
  async saveEnvironment(raw: Partial<QAEnvironment>, secret?: string, secretVariables?: Record<string, string>, dbPasswords?: Record<string, string>, dbServerPassword?: string): Promise<QAEnvironment[]> {
    const env = validateEnvironment(raw);
    const envs = await this.store.listEnvironments();
    const index = env.id ? envs.findIndex((e) => e.id === env.id) : -1;
    if (index < 0) {
      env.id = slug(env.name);
      env.version = 0;
    } else if ((env.version ?? 0) !== (envs[index].version ?? 0)) {
      // Checked before any Keychain change, so a refused save leaves the secrets as they were.
      throw new QaConflictError('environment', envs[index].updatedBy, envs[index].updatedAt);
    }
    if (dbServerPassword !== undefined) {
      if (dbServerPassword === '' || !env.dbServer) await this.deps.deleteSecret(serverSecretKey(env.id));
      else if (!(await this.deps.writeSecret(serverSecretKey(env.id), dbServerPassword))) throw new QaInputError('Gagal menyimpan password database ke Keychain.');
    }
    // Database passwords: '' removes, a value sets, absent keeps; removed databases lose theirs.
    for (const [name, value] of Object.entries(dbPasswords ?? {})) {
      if (!env.databases?.some((d) => d.name === name) || typeof value !== 'string') continue;
      if (value === '') await this.deps.deleteSecret(dbSecretKey(env.id, name));
      else if (!(await this.deps.writeSecret(dbSecretKey(env.id, name), value))) throw new QaInputError('Gagal menyimpan password database ke Keychain.');
    }
    for (const old of index >= 0 ? (envs[index].databases ?? []) : []) {
      if (!env.databases?.some((d) => d.name === old.name)) await this.deps.deleteSecret(dbSecretKey(env.id, old.name));
    }
    if (secret !== undefined) {
      if (secret === '') await this.deps.deleteSecret(env.id);
      else if (!(await this.deps.writeSecret(env.id, secret))) throw new QaInputError('Gagal menyimpan token ke Keychain.');
    }
    if (secretVariables !== undefined) {
      const current = await this.secretVariables(env.id);
      const next = Object.fromEntries(Object.entries(cleanRecord(secretVariables, 'Variabel rahasia')).map(([k, v]) => [k, v || current[k] || '']).filter(([, v]) => v));
      if (!Object.keys(next).length) await this.deps.deleteSecret(`${env.id}:vars`);
      else if (!(await this.deps.writeSecret(`${env.id}:vars`, JSON.stringify(next)))) throw new QaInputError('Gagal menyimpan variabel rahasia ke Keychain.');
      // A name can't be both plain and secret.
      for (const k of Object.keys(next)) delete env.variables[k];
    }
    await this.store.saveEnvironment(env, await this.actor());
    return this.listEnvironments();
  }

  // Import / export ----------------------------------------------------------------------------

  private async envSecrets(env: QAEnvironment): Promise<EnvSecrets> {
    const token = await this.deps.readSecret(env.id);
    const variables = await this.secretVariables(env.id);
    const dbServer = await this.deps.readSecret(serverSecretKey(env.id));
    const databases: Record<string, string> = {};
    for (const d of env.databases ?? []) {
      const v = await this.deps.readSecret(dbSecretKey(env.id, d.name));
      if (v) databases[d.name] = v;
    }
    return {
      ...(token ? { token } : {}),
      ...(Object.keys(variables).length ? { variables } : {}),
      ...(dbServer ? { dbServer } : {}),
      ...(Object.keys(databases).length ? { databases } : {}),
    };
  }

  /** The chosen environments (all when `ids` is absent); Keychain secrets only with a passphrase, encrypted. */
  async exportEnvironments(ids: string[] | undefined, passphrase?: string): Promise<EnvExportFile> {
    const envs = (await this.store.listEnvironments()).filter((e) => !ids || ids.includes(e.id));
    if (!envs.length) throw new QaInputError('Tidak ada environment untuk di-export.');
    let secrets: Record<string, EnvSecrets> | undefined;
    if (passphrase !== undefined) {
      secrets = {};
      for (const e of envs) secrets[e.id] = await this.envSecrets(e);
    }
    return buildExport(envs, secrets, passphrase, await this.actor());
  }

  private async openImport(raw: unknown, passphrase?: string): Promise<{ file: EnvExportFile; secrets?: Record<string, EnvSecrets>; existing: QAEnvironment[] }> {
    const file = readExport(raw);
    const secrets = file.secrets && passphrase ? decryptSecrets(file.secrets, passphrase) : undefined;
    return { file, secrets, existing: await this.store.listEnvironments() };
  }

  private static matchOf(env: Partial<QAEnvironment>, existing: QAEnvironment[]): QAEnvironment & { by: 'id' | 'name' } | undefined {
    const byId = existing.find((e) => e.id === env.id);
    if (byId) return { ...byId, by: 'id' };
    const name = String(env.name ?? '').trim().toLowerCase();
    const byName = existing.find((e) => e.name.trim().toLowerCase() === name);
    return byName ? { ...byName, by: 'name' } : undefined;
  }

  /** What an import file holds and how it lines up with the environments here (nothing is saved). */
  async previewImport(raw: unknown, passphrase?: string): Promise<QAEnvImportPreview> {
    const { file, secrets, existing } = await this.openImport(raw, passphrase);
    return {
      exportedAt: file.exportedAt,
      ...(file.exportedBy ? { exportedBy: file.exportedBy } : {}),
      hasSecrets: Boolean(file.secrets),
      secretsOpened: Boolean(secrets),
      items: file.environments.map((e, i) => {
        const id = typeof e?.id === 'string' && e.id ? e.id : `#${i + 1}`;
        let error: string | undefined;
        try {
          validateEnvironment({ ...e, version: undefined });
        } catch (err) {
          error = (err as Error).message;
        }
        const match = QaManager.matchOf(e, existing);
        return {
          id,
          name: String(e?.name ?? id),
          baseUrl: String(e?.baseUrl ?? ''),
          ...(match ? { match: { id: match.id, name: match.name, by: match.by } } : {}),
          secrets: describeSecrets(secrets?.[e?.id]),
          ...(error ? { error } : {}),
        };
      }),
    };
  }

  /**
   * Saves the file's environments: 'replace' overwrites the matching one here (its secrets only
   * where the file has them), 'new' adds a copy, 'skip' leaves it. Default: replace a match, else new.
   */
  async importEnvironments(raw: unknown, passphrase: string | undefined, actions: Record<string, QAEnvImportAction> = {}): Promise<{ imported: number; skipped: number; environments: QAEnvironment[] }> {
    const { file, secrets, existing } = await this.openImport(raw, passphrase);
    if (file.secrets && !secrets && passphrase) throw new QaInputError('Passphrase salah.');
    let imported = 0;
    let skipped = 0;
    for (const e of file.environments) {
      const match = QaManager.matchOf(e, existing);
      const action = actions[e.id] ?? (match ? 'replace' : 'new');
      if (action === 'skip') {
        skipped++;
        continue;
      }
      const taken = new Set(existing.map((x) => x.name.trim().toLowerCase()));
      let name = String(e.name ?? '').trim();
      if (action === 'new') for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${String(e.name).trim()} (${n})`;
      const target = action === 'replace' && match ? { id: match.id, version: match.version } : { id: '', version: undefined };
      const s = secrets?.[e.id];
      const saved = await this.saveEnvironment({ ...e, name, ...target }, s?.token, s?.variables, s?.databases, s?.dbServer);
      existing.splice(0, existing.length, ...saved);
      imported++;
    }
    return { imported, skipped, environments: await this.listEnvironments() };
  }

  /** Connection of one database: its own host, or the environment's server. */
  private connection(env: QAEnvironment, db: QADatabase): QADbConnection {
    const server = env.dbServer;
    const host = db.host ?? server?.host;
    if (!host) throw new QaDbError(`Server database environment ${env.name} belum diatur.`);
    return { name: db.name, host, port: db.port ?? server?.port ?? 5432, user: db.user ?? server?.user ?? '', database: db.database, ssl: db.ssl ?? server?.ssl };
  }

  private async password(env: QAEnvironment, db?: QADatabase): Promise<string | undefined> {
    return ((db?.host && (await this.deps.readSecret(dbSecretKey(env.id, db.name)))) || (await this.deps.readSecret(serverSecretKey(env.id)))) ?? undefined;
  }

  /** Database by name or service (case-insensitive). */
  private findDb(env: QAEnvironment, name: string): QADatabase | undefined {
    const n = name.toLowerCase();
    return env.databases?.find((d) => d.name.toLowerCase() === n) ?? env.databases?.find((d) => d.service?.toLowerCase() === n);
  }

  /** Read-only query on one of the environment's databases. */
  private dbQuery(env: QAEnvironment): (name: string, sql: string) => Promise<QADbResult> {
    return async (name, sql) => {
      const db = this.findDb(env, name);
      if (!db) throw new QaDbError(`Database "${name}" tidak ada di environment ${env.name}.`);
      return (this.deps.db ?? REAL_DB).query(this.connection(env, db), await this.password(env, db), sql);
    };
  }

  /**
   * A step's setup data change, only for environments that allow it (`dbWrites`, not read-only).
   * Undefined otherwise: the runner then refuses the step instead of running on unchanged data.
   */
  private dbExecute(env: QAEnvironment): ((name: string, sql: string) => Promise<QADbResult>) | undefined {
    if (!env.dbWrites || env.readOnly || !env.databases?.length) return undefined;
    const execute = (this.deps.db ?? REAL_DB).execute;
    if (!execute) return undefined;
    return async (name, sql) => {
      const db = this.findDb(env, name);
      if (!db) throw new QaDbError(`Database "${name}" tidak ada di environment ${env.name}.`);
      return execute(this.connection(env, db), await this.password(env, db), sql);
    };
  }

  private async savedEnv(envId: string): Promise<QAEnvironment> {
    const env = (await this.store.listEnvironments()).find((e) => e.id === envId);
    if (!env) throw new QaInputError('Environment tidak ditemukan; simpan dulu.');
    return env;
  }

  /** "Tes koneksi": the server (no name) or one mapped database. */
  async testDatabase(envId: string, name?: string): Promise<string> {
    const env = await this.savedEnv(envId);
    try {
      if (name) {
        const db = this.findDb(env, name);
        if (!db) throw new QaInputError('Database tidak ditemukan; simpan environment dulu.');
        return await (this.deps.db ?? REAL_DB).test(this.connection(env, db), await this.password(env, db));
      }
      if (!env.dbServer) throw new QaInputError('Isi server database dulu.');
      return await (this.deps.db ?? REAL_DB).test({ name: 'server', ...env.dbServer, database: 'postgres' }, await this.password(env));
    } catch (e) {
      throw new QaInputError((e as Error).message);
    }
  }

  /** Database names on the environment's server, to map services to them. */
  async listServerDatabases(envId: string): Promise<string[]> {
    const env = await this.savedEnv(envId);
    if (!env.dbServer) throw new QaInputError('Isi server database dulu.');
    try {
      return await (this.deps.db ?? REAL_DB).list({ name: 'server', ...env.dbServer, database: 'postgres' }, await this.password(env));
    } catch (e) {
      throw new QaInputError((e as Error).message);
    }
  }

  async deleteEnvironment(id: string): Promise<QAEnvironment[]> {
    const envs = await this.store.listEnvironments();
    for (const d of envs.find((e) => e.id === id)?.databases ?? []) await this.deps.deleteSecret(dbSecretKey(id, d.name));
    await this.deps.deleteSecret(serverSecretKey(id));
    await this.store.deleteEnvironment(id);
    await this.deps.deleteSecret(id);
    await this.deps.deleteSecret(`${id}:vars`);
    return this.listEnvironments();
  }

  // Suites ---------------------------------------------------------------------------------

  private suiteFile = (projectId: string) => this.fileStore.suiteFile(this.projectId(projectId));

  private remember(suite: QASuite | null): QASuite | null {
    if (!suite) return suite;
    this.served.set(servedKey(suite), structuredClone(suite));
    // A handful per project is plenty: a page holds its version for minutes, not hours.
    while (this.served.size > 50) this.served.delete(this.served.keys().next().value!);
    return suite;
  }

  async getSuite(projectId: string): Promise<QASuite | null> {
    return this.remember(await this.loadSuite(projectId));
  }

  private async loadSuite(projectId: string): Promise<QASuite | null> {
    const suite = await this.store.getSuite(this.projectId(projectId));
    if (!suite) return null;
    // Steps keyed by id in the UI and in run results must be unique; heal older suites once.
    const healed = dedupeStepIds(suite.flows ?? []);
    if (dedupeStepIds(suite.undo?.flows ?? []) || healed) {
      return this.store.saveSuite(suite, await this.actor()).catch((e) => {
        if (e instanceof QaConflictError) return this.store.getSuite(projectId);
        throw e;
      });
    }
    return suite;
  }

  /**
   * Suites and runs used to be stored per TAD (same folders, keyed by the draft id). When a
   * project has no suite yet, it takes over the flows and run history of its TADs, once.
   */
  async adoptLegacy(projectId: string, projectName: string, draftIds: string[]): Promise<QASuite | null> {
    const id = this.projectId(projectId);
    const current = await this.getSuite(id);
    // Those suites only ever existed as files; the shared database starts from projects.
    if (current || this.store.kind !== 'file') return current;
    const legacy: { draftId: string; suite: QASuite & { draftId?: string; tadTitle?: string } }[] = [];
    for (const draftId of draftIds.filter((d) => ID.test(d) && d !== id)) {
      const suite = await this.read<QASuite & { draftId?: string; tadTitle?: string }>(this.suiteFile(draftId));
      if (suite?.flows?.length) legacy.push({ draftId, suite });
    }
    if (!legacy.length) return null;
    const now = new Date().toISOString();
    const notes = legacy.map((l) => l.suite.notes).filter(Boolean).join('\n\n');
    const merged = await this.saveSuite({ projectId: id, projectName, flows: legacy.flatMap((l) => l.suite.flows), notes: notes || undefined, generatedAt: legacy[0].suite.generatedAt, ai: legacy[0].suite.ai, updatedAt: now });
    const archive = join(this.dir, 'suites', 'migrated');
    await mkdir(archive, { recursive: true, mode: 0o700 });
    for (const { draftId } of legacy) {
      await rename(this.suiteFile(draftId), join(archive, `${draftId}.json`)).catch(() => {});
      // Run history moves along (the old runs still say draftId/tadTitle; they are read as is).
      const from = this.fileStore.runDir(draftId);
      for (const name of await readdir(from).catch(() => [] as string[])) {
        await mkdir(this.fileStore.runDir(id), { recursive: true, mode: 0o700 });
        await rename(join(from, name), join(this.fileStore.runDir(id), name)).catch(() => {});
      }
      await rm(from, { recursive: true, force: true });
    }
    return merged;
  }

  /**
   * Saves over the version `suite` was loaded with. When someone saved in between, the changes are
   * merged per test case (mergeSuites) and saved again; QaConflictError only when the same test
   * case changed on both sides, or when the version it was loaded with is no longer known.
   */
  async saveSuite(suite: QASuite): Promise<QASuite> {
    const mine = { ...suite, projectId: this.projectId(suite.projectId), updatedAt: new Date().toISOString() };
    const by = await this.actor();
    try {
      return this.remember(await this.store.saveSuite(mine, by))!;
    } catch (e) {
      const base = e instanceof QaConflictError ? this.served.get(servedKey(mine)) : undefined;
      if (!base) throw e;
      for (let attempt = 1; ; attempt++) {
        const theirs = await this.store.getSuite(mine.projectId);
        if (!theirs) throw e;
        const merged = mergeSuites(base, mine, theirs);
        if ('conflicts' in merged) throw new QaConflictError('suite', theirs.updatedBy, theirs.updatedAt, merged.conflicts);
        try {
          return this.remember(await this.store.saveSuite({ ...merged.suite, version: theirs.version, draftRev: theirs.draftRev }, by))!;
        } catch (again) {
          if (!(again instanceof QaConflictError) || attempt >= SAVE_ATTEMPTS) throw again;
        }
      }
    }
  }

  /** Sends a finished run to Confluence as a readable evidence page (again = update it). */
  async publishEvidence(projectId: string, runId: string): Promise<QARunEvidence> {
    const store = this.store;
    if (!store.saveEvidence) throw new QaInputError('Evidence hanya bisa dikirim bila penyimpanan memakai Confluence (Workspace QA).');
    const run = await this.getRun(this.projectId(projectId), runId);
    if (!run) throw new QaInputError('Run tidak ditemukan.');
    if (run.status === 'running') throw new QaInputError('Run masih berjalan; tunggu sampai selesai.');
    const by = await this.actor();
    const evidence = await store.saveEvidence(run, { title: evidenceTitle(run), storage: evidenceStorage(run, { by, attachment: `run-${run.id}.json` }) }, by);
    const live = this.runs.get(run.id)?.run;
    if (live) live.evidence = evidence;
    return evidence;
  }

  // Review before sending (drafts) ------------------------------------------------------------

  private drafts(): DraftedQaStore {
    const store = this.store;
    if (!(store instanceof DraftedQaStore)) throw new QaInputError('Penyimpanan ini tidak memakai draft.');
    return store;
  }

  /** Test case changes waiting in the local draft, against what is published. */
  reviewSuite(projectId: string): Promise<QASuiteReview> {
    return this.drafts().reviewSuite(this.projectId(projectId));
  }

  /** Sends the chosen draft changes (all when `keys` is absent) to the shared storage. */
  async publishSuite(projectId: string, keys?: string[]): Promise<{ suite: QASuite; sent: number }> {
    const result = await this.drafts().publishSuite(this.projectId(projectId), keys, await this.actor());
    this.remember(result.suite);
    return result;
  }

  async discardSuite(projectId: string, keys?: string[]): Promise<QASuite | null> {
    return this.remember(await this.drafts().discardSuite(this.projectId(projectId), keys));
  }

  /**
   * Read-change-save for background agents: on a conflict the latest suite is read and `fn`
   * applied again (their changes are per flow), instead of failing or overwriting.
   */
  private async updateSuite(projectId: string, fn: (current: QASuite | null) => QASuite | null): Promise<QASuite | null> {
    for (let attempt = 1; ; attempt++) {
      const next = fn(await this.getSuite(projectId));
      if (!next) return null;
      try {
        return await this.saveSuite(next);
      } catch (e) {
        if (!(e instanceof QaConflictError) || attempt >= SAVE_ATTEMPTS) throw e;
      }
    }
  }

  // Generation -----------------------------------------------------------------------------

  /**
   * What the AI may use besides the TAD: the schemas of the tasks' services' databases (read-only,
   * never passwords) and the Services codebase (read-only, CLI agents only).
   */
  private async prepareContext(req: QAGenerateRequest, progress: (text: string) => void): Promise<{ req: QAGenerateRequest; codebase?: { root: string; folders: string[] }; warning?: string }> {
    // The environment's databases: their schema lets the AI write real-data queries (never passwords).
    req = { ...req, databases: undefined };
    const env = req.environmentId ? (await this.store.listEnvironments()).find((e) => e.id === req.environmentId) : undefined;
    if (env?.databases?.length) {
      // Only the databases of the selected tasks' services (a project has many microservices).
      const wanted = new Set(req.tasks.map((t) => t.service?.toLowerCase()).filter(Boolean));
      let picked = env.databases.filter((d) => wanted.has((d.service ?? d.name).toLowerCase()));
      if (!picked.length && env.databases.length <= 3) picked = env.databases;
      picked = picked.slice(0, MAX_SCHEMA_DBS);
      if (picked.length) {
        progress(`Membaca skema ${picked.length} database…`);
        req.databases = await Promise.all(
          picked.map(async (d) => {
            try {
              return { name: d.name, service: d.service, schema: await (this.deps.db ?? REAL_DB).schema(this.connection(env, d), await this.password(env, d)) };
            } catch (e) {
              return { name: d.name, service: d.service, schema: '', error: (e as Error).message };
            }
          }),
        );
        // Agents may then write a step's `setup` (data changes for the scenario).
        if (env.dbWrites && !env.readOnly) req.dbWrites = true;
      }
    }
    // The codebase (read-only): routes, payloads and responses are checked against the code.
    let codebase: { root: string; folders: string[] } | undefined;
    let warning: string | undefined;
    // Only the CLI agents can read files; API providers generate from the TAD alone.
    const canRead = req.ai.provider === 'claude' || req.ai.provider === 'antigravity';
    if (req.useCodebase !== false && canRead && this.deps.resolveServicesRoot) {
      try {
        const root = await this.deps.resolveServicesRoot(req.servicesRoot ?? '');
        const all = await readdir(root, { withFileTypes: true }).catch(() => []);
        const names = all.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
        const folders = [...new Set(req.tasks.map((t) => names.find((n) => n.toLowerCase() === (t.service ?? '').toLowerCase())).filter((n): n is string => Boolean(n)))];
        codebase = { root, folders };
        req.codebase = codebase;
        if (!folders.length) warning = `Folder service task tidak ada di ${root}; AI mencari sendiri di folder itu.`;
      } catch (e) {
        // No codebase folder: generate from the TAD alone, and say so (endpoints that only the
        // code has, like a CMS create API, are then missing).
        warning = `Codebase tidak terbaca (${(e as Error).message}); test case disusun dari TAD saja. Cek folder Services di Pengaturan.`;
      }
    }
    return { req, codebase, warning };
  }

  async generate(req: QAGenerateRequest): Promise<QAGenerateJob> {
    const projectId = this.projectId(req.projectId);
    if (!req.tasks?.length) throw new QaInputError('Pilih minimal satu task.');
    if (!req.ai?.provider) throw new QaInputError('Pilih provider AI.');
    const busy = [...this.jobs.values()].find((j) => j.projectId === projectId && j.status === 'running');
    if (busy) return busy;

    // The result replaces the suite as it is now: a save by someone else meanwhile makes it fail, not vanish.
    const baseVersion = (await this.getSuite(projectId))?.version;
    const job: QAGenerateJob & { cancel?: () => void } = { id: randomUUID(), projectId, status: 'running', startedAt: new Date().toISOString(), progress: 'Menyiapkan prompt…' };
    this.jobs.set(job.id, job);
    const ctx = await this.prepareContext(req, (t) => (job.progress = t));
    req = ctx.req;
    const codebase = ctx.codebase;
    // Empty working folder: the AI gets the TAD in the prompt and reads the codebase only if allowed.
    const cwd = await mkdtemp(join(tmpdir(), 'tlc-qa-'));
    const changed = codebase && this.deps.watchRepos ? await this.deps.watchRepos(codebase.root).catch(() => undefined) : undefined;
    // Shown until the AI streams its own progress (a big prompt can take a few minutes).
    job.progress = `AI menyusun skenario${req.databases?.length ? ` dengan skema ${req.databases.length} database` : ''}… biasanya beberapa menit.`;
    const run = this.deps.runAi(req.ai, buildQaPrompt(req), {
      cwd,
      timeoutMs: GENERATE_TIMEOUT_MS,
      systemPrompt: QA_SYSTEM_PROMPT,
      readOnlyDirs: codebase ? [codebase.root] : [],
      onProgress: (text) => (job.progress = text.slice(0, 200)),
    });
    job.cancel = run.cancel;
    void run.done
      .then(async (outcome) => {
        if (job.status === 'cancelled') return;
        if (outcome.error) throw new Error(outcome.error);
        let parsed: ReturnType<typeof parseQaReply>;
        try {
          parsed = parseQaReply(outcome.reply, req.tasks.map((t) => t.title));
        } catch (e) {
          job.rawReply = outcome.reply.slice(0, 50_000);
          throw e;
        }
        const { flows } = parsed;
        let notes = ctx.warning ? `PERINGATAN: ${ctx.warning}${parsed.notes ? `\n\n${parsed.notes}` : ''}` : parsed.notes;
        // The codebase is read-only: report any change found in a repo's working tree.
        const touched = changed ? await changed().catch(() => []) : [];
        if (touched.length) notes = `${notes ? `${notes}\n\n` : ''}PERINGATAN: working tree berubah selama generate di ${touched.join(', ')}. Periksa repo tersebut.`;
        const now = new Date().toISOString();
        const suite: QASuite = {
          projectId,
          projectName: req.projectName,
          flows: [...(req.existing ?? []), ...flows],
          notes,
          generatedAt: now,
          ai: req.ai,
          updatedAt: now,
          version: baseVersion,
        };
        job.suite = await this.saveSuite(suite);
        job.status = 'done';
      })
      .catch((e: Error) => {
        if (job.status === 'running') {
          job.status = 'error';
          job.error = e.message;
        }
      })
      .finally(() => {
        job.finishedAt ??= new Date().toISOString();
        job.cancel = undefined;
        void rm(cwd, { recursive: true, force: true });
      });
    return this.publicJob(job);
  }

  private publicJob(job: QAGenerateJob & { cancel?: () => void }): QAGenerateJob {
    const { cancel: _cancel, ...rest } = job;
    return rest;
  }

  getJob(id: string): QAGenerateJob | undefined {
    const job = this.jobs.get(id);
    return job && this.publicJob(job);
  }

  latestJob(projectId: string): QAGenerateJob | undefined {
    const all = [...this.jobs.values()].filter((j) => j.projectId === projectId);
    const job = all[all.length - 1];
    return job && this.publicJob(job);
  }

  cancelJob(id: string): QAGenerateJob | undefined {
    const job = this.jobs.get(id);
    if (job?.status === 'running') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      job.cancel?.();
    }
    return job && this.publicJob(job);
  }

  // Pipeline: planner → review → writers per stage (parallel) → check → run → repair ------------

  private pipeline(projectId: string): QAPipeline {
    let p = this.pipelines.get(projectId);
    if (!p) {
      p = { projectId, phase: 'idle', concurrency: DEFAULT_CONCURRENCY, agents: [], updatedAt: new Date().toISOString() };
      this.pipelines.set(projectId, p);
    }
    return p;
  }

  async getPlan(projectId: string): Promise<QAPlan | null> {
    return this.store.getPlan(this.projectId(projectId));
  }

  /** The plan and the pipeline's agents (live), for the UI. */
  async getPipeline(projectId: string): Promise<{ plan: QAPlan | null; pipeline: QAPipeline }> {
    const p = this.pipeline(this.projectId(projectId));
    return { plan: await this.getPlan(projectId), pipeline: { ...p, agents: p.agents.map((a) => ({ ...a })) } };
  }

  /** The user's edits to the plan (reorder, rename, drop stages or endpoints). */
  async savePlan(plan: QAPlan): Promise<QAPlan> {
    const saved: QAPlan = { ...plan, projectId: this.projectId(plan.projectId), updatedAt: new Date().toISOString() };
    if (!saved.stages?.length) throw new QaInputError('Rencana butuh minimal satu tahap.');
    return this.store.savePlan(saved, await this.actor());
  }

  private busyAgents(p: QAPipeline) {
    return p.agents.filter((a) => a.status === 'running' || a.status === 'queued');
  }

  private async syncAgent(job: QAAgentJob, projectName: string) {
    const id = await this.deps.agentSink?.(job, projectName).catch(() => undefined);
    if (id) job.agentTaskId = id;
  }

  /** Runs one agent to its reply (or throws); progress and status mirror into Agent Tasks. */
  private async runAgent(job: QAAgentJob, projectName: string, ai: AiSelection, prompt: string, systemPrompt: string, readOnlyDirs: string[]): Promise<string> {
    if (this.agentStopped.has(job.id)) throw new Error('Dibatalkan.');
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    await this.syncAgent(job, projectName);
    const cwd = await mkdtemp(join(tmpdir(), 'tlc-qa-'));
    let lastSync = 0;
    try {
      const run = this.deps.runAi(ai, prompt, {
        cwd,
        timeoutMs: GENERATE_TIMEOUT_MS,
        systemPrompt,
        readOnlyDirs,
        onProgress: (text) => {
          job.progress = text.slice(0, 200);
          if (Date.now() - lastSync > 5_000) (lastSync = Date.now()), void this.syncAgent(job, projectName);
        },
      });
      this.agentCancels.set(job.id, run.cancel);
      const outcome = await run.done;
      if (this.agentStopped.has(job.id)) throw new Error('Dibatalkan.');
      if (outcome.error) throw new Error(outcome.error);
      return outcome.reply;
    } finally {
      this.agentCancels.delete(job.id);
      void rm(cwd, { recursive: true, force: true });
    }
  }

  private async finishAgent(job: QAAgentJob, projectName: string, outcome: { result?: string; error?: unknown; rawReply?: string }) {
    job.finishedAt = new Date().toISOString();
    job.progress = undefined;
    if (outcome.error) {
      job.status = this.agentStopped.has(job.id) ? 'cancelled' : 'error';
      job.error = (outcome.error as Error).message;
      if (outcome.rawReply) job.rawReply = outcome.rawReply.slice(0, 50_000);
    } else {
      job.status = 'done';
      job.result = outcome.result;
    }
    await this.syncAgent(job, projectName);
  }

  /** Runs `fn` over `items`, at most `limit` at a time. */
  private async pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }));
  }

  private newAgent(projectId: string, role: QAAgentJob['role'], label: string, ai: AiSelection, extra: Partial<QAAgentJob> = {}): QAAgentJob {
    return { id: randomUUID(), projectId, role, label, ai, status: 'queued', ...extra };
  }

  /** Step 1: the planner agent maps the journey (stages, endpoints with file:line, variable contract). */
  async startPlan(req: QAGenerateRequest): Promise<QAPipeline> {
    const projectId = this.projectId(req.projectId);
    if (!req.tasks?.length) throw new QaInputError('Pilih minimal satu task.');
    const p = this.pipeline(projectId);
    if (this.busyAgents(p).length) throw new QaInputError('Masih ada agent E2E yang berjalan untuk proyek ini.');
    // A new plan replaces the one there now; an edit saved meanwhile makes it fail instead.
    const baseVersion = (await this.getPlan(projectId))?.version;
    const job = this.newAgent(projectId, 'plan', 'Rencana journey E2E', req.ai);
    p.agents = [job];
    p.phase = 'planning';
    p.updatedAt = new Date().toISOString();
    void (async () => {
      try {
        job.progress = 'Menyiapkan konteks…';
        const { req: full, codebase, warning } = await this.prepareContext({ ...req, focus: undefined }, (t) => (job.progress = t));
        const changed = codebase && this.deps.watchRepos ? await this.deps.watchRepos(codebase.root).catch(() => undefined) : undefined;
        job.progress = 'AI memetakan journey dari TAD dan kode…';
        const reply = await this.runAgent(job, req.projectName, req.ai, buildPlanPrompt(full), PLAN_SYSTEM_PROMPT, codebase ? [codebase.root] : []);
        let plan: QAPlan;
        try {
          plan = parsePlan(reply, { projectId, projectName: req.projectName, ai: req.ai, request: { ...req, databases: undefined, codebase: undefined, focus: undefined } });
        } catch (e) {
          await this.finishAgent(job, req.projectName, { error: e, rawReply: reply });
          return;
        }
        // Each endpoint's evidence is checked against the real router file: the line exists and
        // the code around it names the path.
        if (codebase) {
          const endpoints = plan.stages.flatMap((st) => st.endpoints);
          const cite = (e: (typeof endpoints)[number]) => /^(.+):(\d+)$/.exec(e.evidence ?? '');
          const checked = await verifyEvidence(codebase.root, endpoints.map((e) => ({ file: cite(e)?.[1] ?? '', line: Number(cite(e)?.[2]), note: '', verified: false })));
          endpoints.forEach((e, i) => (e.verified = Boolean(cite(e)) && checked[i].verified && evidenceMentions(e.path, checked[i].snippet)));
        }
        const touched = changed ? await changed().catch(() => []) : [];
        if (touched.length) plan.notes = `${plan.notes ? `${plan.notes}\n\n` : ''}PERINGATAN: working tree berubah selama perencanaan di ${touched.join(', ')}.`;
        if (warning) plan.notes = `PERINGATAN: ${warning}${plan.notes ? `\n\n${plan.notes}` : ''}`;
        await this.savePlan({ ...plan, version: baseVersion });
        await this.finishAgent(job, req.projectName, { result: `${plan.stages.length} tahap` });
      } catch (e) {
        await this.finishAgent(job, req.projectName, { error: e });
      } finally {
        p.phase = job.status === 'done' ? 'review' : 'idle';
        p.updatedAt = new Date().toISOString();
      }
    })();
    return p;
  }

  /**
   * Step 2: writer agents, one per stage (all, or `stageIds` to redo some), at most `concurrency`
   * at a time. Each stage's flows replace that stage's flows as soon as they are ready.
   */
  async writeFromPlan(projectId: string, opts: { concurrency?: number; stageIds?: string[]; ai?: AiSelection } = {}): Promise<QAPipeline> {
    projectId = this.projectId(projectId);
    const plan = await this.getPlan(projectId);
    if (!plan) throw new QaInputError('Buat rencana journey dulu.');
    const p = this.pipeline(projectId);
    if (this.busyAgents(p).length) throw new QaInputError('Masih ada agent E2E yang berjalan untuk proyek ini.');
    const stages = plan.stages.filter((st) => !opts.stageIds?.length || opts.stageIds.includes(st.id));
    if (!stages.length) throw new QaInputError('Tahap tidak ditemukan di rencana.');
    p.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(opts.concurrency ?? p.concurrency)));
    const ai = opts.ai ?? plan.ai;
    const jobs = stages.map((st) => this.newAgent(projectId, 'write', `Tulis test case: ${st.title}`, ai, { stageId: st.id }));
    p.agents = jobs;
    p.phase = 'writing';
    p.updatedAt = new Date().toISOString();
    for (const j of jobs) void this.syncAgent(j, plan.projectName);
    const written = new Map<string, QAFlow[]>();

    // Existing flows of the stages being rewritten are replaced as each stage finishes.
    const merge = () => this.updateSuite(projectId, (prev) => {
      const current = prev?.flows ?? [];
      const finished = new Set(plan.stages.filter((st) => written.has(st.id)).map((st) => st.title));
      const byStage = new Map<string, QAFlow[]>();
      const others: QAFlow[] = [];
      for (const f of current) {
        if (f.stage && finished.has(f.stage)) continue;
        if (f.stage && plan.stages.some((st) => st.title === f.stage)) byStage.set(f.stage, [...(byStage.get(f.stage) ?? []), f]);
        else others.push(f);
      }
      const ordered = plan.stages.flatMap((st) => written.get(st.id) ?? byStage.get(st.title) ?? []);
      const now = new Date().toISOString();
      // Groups the user saved (made, renamed, reordered) keep their place; stages not among them follow in
      // plan order. The saved list itself is left as is, so a stage that finishes first doesn't fix the order.
      const flows = arrangeFlows([...ordered, ...others], groupOrder({ groups: prev?.groups, flows: [...ordered, ...others] }));
      return { ...(prev ?? {}), projectId, projectName: plan.projectName, flows: checkFlowsAgainstPlan(flows, plan), generatedAt: now, ai, updatedAt: now };
    });

    void (async () => {
      await this.pool(jobs, p.concurrency, async (job) => {
        const stage = plan.stages.find((st) => st.id === job.stageId)!;
        try {
          const tasks = plan.request.tasks.filter((t) => !stage.taskTitles.length || stage.taskTitles.includes(t.title));
          const services = new Set(stage.endpoints.map((e) => e.service?.toLowerCase()).filter(Boolean));
          const scoped = { ...plan.request, ai, tasks: tasks.length ? tasks : plan.request.tasks, focus: { stage, stages: plan.stages.map((x) => ({ id: x.id, title: x.title })), variables: plan.variables } };
          // The codebase folders of the stage's services too (not only the tasks').
          const { req: full, codebase } = await this.prepareContext(
            { ...scoped, tasks: [...scoped.tasks, ...[...services].filter((sv) => !scoped.tasks.some((t) => t.service?.toLowerCase() === sv)).map((sv) => ({ title: '', service: sv, spec: '' }))] },
            (t) => (job.progress = t),
          );
          full.tasks = scoped.tasks;
          const reply = await this.runAgent(job, plan.projectName, ai, buildQaPrompt(full), QA_SYSTEM_PROMPT, codebase ? [codebase.root] : []);
          let flows: QAFlow[];
          try {
            flows = parseQaReply(reply, stage.taskTitles).flows.map((f) => ({ ...f, stage: stage.title }));
          } catch (e) {
            await this.finishAgent(job, plan.projectName, { error: e, rawReply: reply });
            return;
          }
          written.set(stage.id, flows);
          await merge();
          await this.finishAgent(job, plan.projectName, { result: `${flows.length} test case` });
        } catch (e) {
          await this.finishAgent(job, plan.projectName, { error: e });
        }
      });
      p.phase = 'idle';
      p.updatedAt = new Date().toISOString();
    })();
    return p;
  }

  /**
   * Step 3: after a run, one repair agent per failed flow: a wrong test is fixed in the suite, a
   * service bug is listed as a suspect (for Bug Tracing).
   */
  async repairRun(projectId: string, runId: string, opts: { concurrency?: number; ai?: AiSelection } = {}): Promise<QAPipeline> {
    projectId = this.projectId(projectId);
    const run = await this.getRun(projectId, runId);
    if (!run || run.status === 'running') throw new QaInputError('Run tidak ditemukan atau masih berjalan.');
    const suite = await this.getSuite(projectId);
    if (!suite) throw new QaInputError('Belum ada test case.');
    const failed = run.flows.filter((f) => f.status === 'failed' || f.status === 'error').filter((f) => suite.flows.some((x) => x.id === f.flowId)).slice(0, MAX_REPAIRS);
    if (!failed.length) throw new QaInputError('Tidak ada test case yang gagal di run ini.');
    const p = this.pipeline(projectId);
    if (this.busyAgents(p).length) throw new QaInputError('Masih ada agent E2E yang berjalan untuk proyek ini.');
    const plan = await this.getPlan(projectId);
    const ai = opts.ai ?? plan?.ai ?? suite.ai;
    if (!ai) throw new QaInputError('Pilih AI untuk agent perbaikan.');
    p.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(opts.concurrency ?? p.concurrency)));
    const jobs = failed.map((f) => this.newAgent(projectId, 'repair', `Perbaiki: ${f.name}`, ai, { flowId: f.flowId }));
    p.agents = jobs;
    p.phase = 'repairing';
    p.updatedAt = new Date().toISOString();
    for (const j of jobs) void this.syncAgent(j, suite.projectName);
    // One write at a time: agents finish in any order.
    let chain: Promise<unknown> = Promise.resolve();
    const update = (fn: (s: QASuite) => QASuite) => (chain = chain.then(() => this.updateSuite(projectId, (cur) => (cur ? fn(cur) : null))));

    void (async () => {
      await this.pool(jobs, p.concurrency, async (job) => {
        const result = failed.find((f) => f.flowId === job.flowId)!;
        const flow = suite.flows.find((f) => f.id === job.flowId)!;
        try {
          const services = [...new Set(flow.steps.map((st) => st.service).filter((x): x is string => Boolean(x)))];
          // Same environment as the failed run: its databases let the repair use real test data.
          const { req: ctx, codebase } = await this.prepareContext({ ...(plan?.request ?? { projectId, projectName: suite.projectName, categories: [] }), ai, tasks: services.map((sv) => ({ title: '', service: sv, spec: '' })), environmentId: run.environment.id }, (t) => (job.progress = t));
          const reply = await this.runAgent(job, suite.projectName, ai, buildRepairPrompt(flow, result, codebase, ctx.databases, ctx.dbWrites), REPAIR_SYSTEM_PROMPT, codebase ? [codebase.root] : []);
          let verdict: ReturnType<typeof parseRepair>;
          try {
            verdict = parseRepair(reply, flow);
          } catch (e) {
            await this.finishAgent(job, suite.projectName, { error: e, rawReply: reply });
            return;
          }
          if (verdict.flow && verdict.verdict !== 'service-bug') {
            const fixed = { ...verdict.flow, repairNote: `${verdict.verdict === 'environment' ? 'Lingkungan' : 'Test diperbaiki'}: ${verdict.reason}` };
            await update((s) => ({ ...s, flows: plan ? checkFlowsAgainstPlan(s.flows.map((f) => (f.id === flow.id ? fixed : f)), plan) : s.flows.map((f) => (f.id === flow.id ? fixed : f)) }));
          }
          if (verdict.verdict === 'service-bug') {
            const suspect: QASuspect = { flowId: flow.id, flowName: flow.name, title: verdict.bug?.title ?? flow.name, detail: verdict.bug?.detail ?? verdict.reason, ...(verdict.bug?.service ? { service: verdict.bug.service } : {}), runId, at: new Date().toISOString() };
            await update((s) => ({ ...s, suspects: [...(s.suspects ?? []).filter((x) => x.flowId !== flow.id), suspect] }));
          }
          await chain;
          const label = verdict.verdict === 'fix-test' ? 'test diperbaiki' : verdict.verdict === 'service-bug' ? 'dugaan bug service' : 'masalah lingkungan';
          await this.finishAgent(job, suite.projectName, { result: `${label}: ${verdict.reason.slice(0, 160)}` });
        } catch (e) {
          await this.finishAgent(job, suite.projectName, { error: e });
        }
      });
      p.phase = 'idle';
      p.updatedAt = new Date().toISOString();
    })();
    return p;
  }

  /**
   * Fixes flows by the Tech Lead's instruction ("msisdn harus string"): one agent per small batch,
   * reading the code (struct types, router) and the flows' latest run. Changed flows replace the
   * old ones as each batch finishes; the old versions are kept for one undo.
   */
  async fixFlows(projectId: string, opts: { flowIds: string[]; instruction: string; ai?: AiSelection; concurrency?: number; environmentId?: string }): Promise<QAPipeline> {
    projectId = this.projectId(projectId);
    // Room for a generated instruction (e.g. the variables to fill from the database).
    const instruction = opts.instruction.trim().slice(0, 12_000);
    if (!instruction) throw new QaInputError('Tulis instruksi perbaikannya.');
    const suite = await this.getSuite(projectId);
    if (!suite) throw new QaInputError('Belum ada test case.');
    const wanted = new Set(opts.flowIds);
    const flows = suite.flows.filter((f) => wanted.has(f.id));
    if (!flows.length) throw new QaInputError('Pilih minimal satu test case.');
    if (flows.length > MAX_FIX_FLOWS) throw new QaInputError(`Terlalu banyak test case (${flows.length}); maksimal ${MAX_FIX_FLOWS} sekali perbaikan.`);
    const p = this.pipeline(projectId);
    if (this.busyAgents(p).length) throw new QaInputError('Masih ada agent E2E yang berjalan untuk proyek ini.');
    const plan = await this.getPlan(projectId);
    const ai = opts.ai ?? plan?.ai ?? suite.ai;
    if (!ai) throw new QaInputError('Pilih AI untuk agent perbaikan.');
    // The latest result of each flow helps the agent see what the service answered.
    const results = new Map<string, QAFlowResult>();
    for (const run of await this.listRuns(projectId)) for (const r of run.flows) if (wanted.has(r.flowId) && !results.has(r.flowId)) results.set(r.flowId, r);
    const batches: QAFlow[][] = [];
    for (let i = 0; i < flows.length; i += FIX_BATCH) batches.push(flows.slice(i, i + FIX_BATCH));
    p.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(opts.concurrency ?? p.concurrency)));
    const jobs = batches.map((b, i) => this.newAgent(projectId, 'fix', `Perbaiki AI: ${b.length === 1 ? b[0].name : `${b.length} test case (bagian ${i + 1}/${batches.length})`}`, ai, b.length === 1 ? { flowId: b[0].id } : {}));
    p.agents = jobs;
    p.phase = 'fixing';
    p.updatedAt = new Date().toISOString();
    for (const j of jobs) void this.syncAgent(j, suite.projectName);
    // Undo restores every flow this instruction changed; a new instruction starts a new undo.
    const undo = { at: new Date().toISOString(), label: instruction.slice(0, 200), flows: [] as QAFlow[] };
    let chain: Promise<unknown> = Promise.resolve();
    const apply = (fixed: { flow: QAFlow; summary: string }[]) =>
      (chain = chain.then(() =>
        this.updateSuite(projectId, (cur) => {
          if (!cur) return null;
          for (const { flow } of fixed) {
            const old = cur.flows.find((f) => f.id === flow.id);
            if (old && !undo.flows.some((f) => f.id === old.id)) undo.flows.push(old);
          }
          const map = new Map(fixed.map((x) => [x.flow.id, { ...x.flow, repairNote: `Diperbaiki AI: ${x.summary}` }]));
          const next = cur.flows.map((f) => map.get(f.id) ?? f);
          return { ...cur, flows: plan ? checkFlowsAgainstPlan(next, plan) : next, undo: { ...undo, flows: [...undo.flows] } };
        }),
      ));

    void (async () => {
      await this.pool(jobs, p.concurrency, async (job) => {
        const batch = batches[jobs.indexOf(job)];
        try {
          const services = [...new Set(batch.flatMap((f) => f.steps.map((st) => st.service).filter((x): x is string => Boolean(x))))];
          // The environment's databases of these services: the agent can swap sample values for real data.
          const { req: ctx, codebase } = await this.prepareContext({ ...(plan?.request ?? { projectId, projectName: suite.projectName, categories: [] }), ai, tasks: services.map((sv) => ({ title: '', service: sv, spec: '' })), environmentId: opts.environmentId }, (t) => (job.progress = t));
          const reply = await this.runAgent(job, suite.projectName, ai, buildFixPrompt(batch, instruction, results, codebase, ctx.databases, ctx.dbWrites), FIX_SYSTEM_PROMPT, codebase ? [codebase.root] : []);
          let fix: ReturnType<typeof parseFix>;
          try {
            fix = parseFix(reply, batch);
          } catch (e) {
            await this.finishAgent(job, suite.projectName, { error: e, rawReply: reply });
            return;
          }
          if (fix.fixed.length) await apply(fix.fixed);
          await chain;
          const result = fix.fixed.length ? `${fix.fixed.length} test case diubah: ${fix.fixed.map((x) => x.summary).join(' · ')}` : 'tidak ada yang perlu diubah';
          await this.finishAgent(job, suite.projectName, { result: `${result}${fix.notes ? ` · Catatan: ${fix.notes}` : ''}`.slice(0, 1_500) });
        } catch (e) {
          await this.finishAgent(job, suite.projectName, { error: e });
        }
      });
      p.phase = 'idle';
      p.updatedAt = new Date().toISOString();
    })();
    return p;
  }

  /** Puts back the flows the last AI fix changed (flows deleted since then stay deleted). */
  async undoFix(projectId: string): Promise<QASuite> {
    projectId = this.projectId(projectId);
    const suite = await this.getSuite(projectId);
    if (!suite?.undo?.flows.length) throw new QaInputError('Tidak ada perbaikan AI yang bisa dibatalkan.');
    if (this.busyAgents(this.pipeline(projectId)).some((a) => a.role === 'fix')) throw new QaInputError('Agent perbaikan masih berjalan; tunggu atau batalkan dulu.');
    const back = new Map(suite.undo.flows.map((f) => [f.id, f]));
    const { undo: _undo, ...rest } = suite;
    return this.saveSuite({ ...rest, flows: suite.flows.map((f) => back.get(f.id) ?? f) });
  }

  /** Stops one agent (or every agent of the project's pipeline). */
  cancelAgent(jobId: string): QAAgentJob | undefined {
    for (const p of this.pipelines.values()) {
      const job = p.agents.find((a) => a.id === jobId);
      if (!job) continue;
      this.agentStopped.add(job.id);
      this.agentCancels.get(job.id)?.();
      if (job.status === 'queued') {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
      }
      return job;
    }
    return undefined;
  }

  cancelPipeline(projectId: string): QAPipeline {
    const p = this.pipeline(this.projectId(projectId));
    for (const a of this.busyAgents(p)) this.cancelAgent(a.id);
    return p;
  }

  // Runs -----------------------------------------------------------------------------------

  async startRun(req: QARunRequest): Promise<QARun> {
    const projectId = this.projectId(req.projectId);
    const active = [...this.runs.values()].find((r) => r.run.projectId === projectId && r.run.status === 'running');
    if (active) throw new QaInputError('Masih ada run E2E yang berjalan untuk TAD ini.');
    const suite = await this.getSuite(projectId);
    if (!suite) throw new QaInputError('Belum ada skenario E2E untuk TAD ini.');
    const env = (await this.store.listEnvironments()).find((e) => e.id === req.environmentId);
    if (!env) throw new QaInputError('Environment tidak ditemukan.');
    const flows: QAFlow[] = req.flowIds?.length ? suite.flows.filter((f) => req.flowIds!.includes(f.id)) : suite.flows.filter((f) => f.enabled);
    if (!flows.length) throw new QaInputError('Tidak ada flow yang dipilih.');
    const secret = env.auth.type === 'none' ? undefined : ((await this.deps.readSecret(env.id)) ?? undefined);
    const secretVariables = await this.secretVariables(env.id);

    const run: QARun = {
      id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`,
      projectId,
      projectName: suite.projectName,
      environment: { id: env.id, name: env.name, readOnly: env.readOnly },
      status: 'running',
      startedAt: new Date().toISOString(),
      flows: flows.map((f) => ({ flowId: f.id, name: f.name, category: f.category, taskTitles: f.taskTitles, status: 'pending', steps: [] })),
      summary: summarize([]),
    };
    const state = { run, cancelled: false };
    this.runs.set(run.id, state);

    void (async () => {
      // One journey: values extracted by a flow are available to the next ones.
      const carried = { values: {} as Record<string, string>, from: {} as Record<string, string> };
      // From the whole suite, not just the flows picked: running one flow alone casts like a full run.
      const declared = declaredTypes(suite.flows);
      for (const [i, flow] of flows.entries()) {
        if (state.cancelled) {
          run.flows[i].status = 'skipped';
          continue;
        }
        run.flows[i].status = 'running';
        run.flows[i] = await runFlow(flow, i, {
          env,
          secret,
          secretVariables,
          fetch: this.deps.fetch,
          query: env.databases?.length ? this.dbQuery(env) : undefined,
          execute: this.dbExecute(env),
          carried,
          declared,
          cancelled: () => state.cancelled,
          onStep: (fi, step) => {
            run.flows[fi].steps.push(step);
            run.summary = summarize(run.flows);
          },
        });
        run.summary = summarize(run.flows);
      }
      // Persist first, then flip the live status: a reader that sees "done" can rely on the store.
      const finished: QARun = { ...run, status: state.cancelled ? 'cancelled' : 'done', finishedAt: new Date().toISOString(), summary: summarize(run.flows) };
      await this.store.saveRun(finished, await this.actor());
      Object.assign(run, finished);
    })().catch(() => {
      run.status = 'done';
      run.finishedAt = new Date().toISOString();
    });
    return run;
  }

  async getRun(projectId: string, id: string): Promise<QARun | undefined> {
    const live = this.runs.get(id)?.run;
    if (live && live.projectId === projectId) return live;
    if (!ID.test(id)) return undefined;
    return this.store.getRun(this.projectId(projectId), id);
  }

  async listRuns(projectId: string): Promise<QARun[]> {
    const stored = await this.store.listRuns(this.projectId(projectId));
    const live = [...this.runs.values()].map((r) => r.run).filter((r) => r.projectId === projectId && r.status === 'running');
    return [...live, ...stored.filter((r) => !live.some((l) => l.id === r.id))];
  }

  cancelRun(id: string): QARun | undefined {
    const state = this.runs.get(id);
    if (state && state.run.status === 'running') state.cancelled = true;
    return state?.run;
  }

  // Projects (what QA Cockpit lists) -------------------------------------------------------

  listProjects(): Promise<QAProject[]> {
    return this.store.listProjects();
  }

  /** Tech Lead Cockpit keeps a project's name and TADs current in the store. */
  async upsertProject(raw: { id?: unknown; name?: unknown; tads?: unknown }): Promise<QAProject> {
    const id = this.projectId(raw.id);
    const name = String(raw.name ?? '').trim().slice(0, 300);
    if (!name) throw new QaInputError('Nama proyek wajib diisi.');
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const tads: QATadRef[] = (Array.isArray(raw.tads) ? raw.tads.slice(0, 50) : []).map((t: Record<string, unknown>) => ({
      title: text(t?.title, 300) ?? 'TAD',
      ...(text(t?.draftId, 64) ? { draftId: text(t?.draftId, 64) } : {}),
      ...(text(t?.confluencePageId, 40) ? { confluencePageId: text(t?.confluencePageId, 40) } : {}),
      ...(text(t?.confluenceUrl, 1000) && /^https?:\/\//i.test(String(t?.confluenceUrl)) ? { confluenceUrl: text(t?.confluenceUrl, 1000) } : {}),
      ...(Array.isArray(t?.jiraKeys) ? { jiraKeys: (t.jiraKeys as unknown[]).map(String).filter((k) => /^[A-Z][A-Z0-9]+-\d+$/.test(k)).slice(0, 200) } : {}),
    }));
    // Unchanged: no write (opening a project calls this every time).
    const current = (await this.store.listProjects()).find((p) => p.id === id);
    if (current && current.name === name && JSON.stringify(current.tads) === JSON.stringify(tads)) return current;
    return this.store.upsertProject({ id, name, tads }, await this.actor());
  }
}
