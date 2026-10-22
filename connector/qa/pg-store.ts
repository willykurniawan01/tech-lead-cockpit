import pg from 'pg';
import type { QAEnvironment, QAPlan, QAProject, QARun, QASuite } from '../../src/lib/qa/types.ts';
import { bare, KEEP_RUNS, QaConflictError, storableEnvironment, type QaStore } from './store.ts';

/**
 * The shared E2E store: one PostgreSQL database (e.g. `tlc_qa`) used by Tech Lead Cockpit and
 * QA Cockpit. Tables are created and upgraded by the app itself (MIGRATIONS, recorded in
 * schema_version, one app at a time under an advisory lock). Rows hold the same JSON the file
 * store keeps; `version` guards suites, plans and environments against concurrent saves.
 * No secrets are stored here: tokens and passwords stay in each user's Keychain.
 */

export class QaStoreError extends Error {}

export interface QaStoreConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: boolean;
}

type Rows = { rows: Record<string, unknown>[]; rowCount: number | null };
interface Queryable {
  query(text: string, values?: unknown[]): Promise<Rows>;
}
/** What the store needs of a pg.Pool (tests pass pg-mem's). */
export interface PgPoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
  end(): Promise<void>;
}

/** Arbitrary key for pg_advisory_xact_lock: apps migrating at the same time wait for each other. */
const MIGRATION_LOCK = 7_428_130;

export const MIGRATIONS: { version: number; name: string; sql: string[] }[] = [
  {
    version: 1,
    name: 'e2e tables',
    sql: [
      `CREATE TABLE qa_projects (
        id text PRIMARY KEY,
        name text NOT NULL,
        tads jsonb NOT NULL DEFAULT '[]',
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      )`,
      `CREATE TABLE qa_suites (
        project_id text PRIMARY KEY,
        data jsonb NOT NULL,
        version integer NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      )`,
      `CREATE TABLE qa_plans (
        project_id text PRIMARY KEY,
        data jsonb NOT NULL,
        version integer NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      )`,
      `CREATE TABLE qa_runs (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        status text NOT NULL,
        environment_id text,
        summary jsonb,
        data jsonb NOT NULL,
        created_by text
      )`,
      `CREATE INDEX qa_runs_project ON qa_runs (project_id, started_at)`,
      `CREATE TABLE qa_environments (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        version integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      )`,
    ],
  },
];

export const LATEST_SCHEMA = MIGRATIONS[MIGRATIONS.length - 1].version;

const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined);
const json = (v: unknown) => JSON.stringify(v);
const by = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export function createPgPool(conn: QaStoreConnection, password: string | undefined, appName = 'tech-lead-cockpit-store'): PgPoolLike {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.user,
    password: password || undefined,
    ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
    max: 4,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    application_name: appName,
  });
  // An idle client dropped by the server must not take the connector down.
  pool.on('error', () => {});
  return pool as unknown as PgPoolLike;
}

/** Connection errors in words a user can act on. */
export function connectionMessage(e: unknown, conn: QaStoreConnection): string {
  const err = e as { code?: string; message?: string };
  const where = `${conn.host}:${conn.port}/${conn.database}`;
  if (err.code === '28P01' || err.code === '28000') return `Login DB pusat ditolak untuk user ${conn.user} (${where}). Periksa user dan password.`;
  if (err.code === '3D000') return `Database ${conn.database} belum ada di ${conn.host}. Jalankan scripts/sql/qa-central-db.sql dulu.`;
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || /timeout/i.test(err.message ?? '')) return `DB pusat ${where} tidak terjangkau. Pastikan VPN aktif.`;
  return `DB pusat ${where}: ${err.message ?? String(e)}`;
}

export class PgQaStore implements QaStore {
  readonly kind = 'postgres' as const;
  private ready?: Promise<number>;

  /** `conn` only names the server in error messages. */
  constructor(
    private readonly pool: PgPoolLike,
    private readonly conn?: QaStoreConnection,
  ) {}

  /** A driver error as a QaStoreError a user can act on. */
  private wrap(e: unknown): never {
    if (e instanceof QaStoreError || e instanceof QaConflictError) throw e;
    throw new QaStoreError(this.conn ? connectionMessage(e, this.conn) : `DB pusat: ${(e as Error).message}`, { cause: e });
  }

  /** Creates or upgrades the tables once per store; returns the schema version. */
  migrate(by?: string): Promise<number> {
    this.ready ??= this.runMigrations(by).catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  private async runMigrations(by?: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_version (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        applied_by text
      )`);
      const { rows } = await client.query('SELECT max(version) AS v FROM schema_version');
      const current = Number(rows[0]?.v ?? 0);
      if (current > LATEST_SCHEMA) throw new QaStoreError(`Skema DB pusat (versi ${current}) lebih baru dari app ini (versi ${LATEST_SCHEMA}). Perbarui app dulu.`);
      for (const m of MIGRATIONS.filter((x) => x.version > current)) {
        for (const sql of m.sql) await client.query(sql);
        await client.query('INSERT INTO schema_version (version, name, applied_by) VALUES ($1, $2, $3)', [m.version, m.name, by ?? null]);
      }
      await client.query('COMMIT');
      return Math.max(current, LATEST_SCHEMA);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  private async q(text: string, values?: unknown[]): Promise<Rows> {
    try {
      await this.migrate();
      return await this.pool.query(text, values);
    } catch (e) {
      this.wrap(e);
    }
  }

  /**
   * "Tes koneksi": logs in and reads the server and schema version without creating anything
   * (tables are made on first use). Schema 0 = not created yet.
   */
  async probe(): Promise<{ server: string; schemaVersion: number }> {
    try {
      const { rows } = await this.pool.query('SHOW server_version');
      const schema = await this.pool.query('SELECT max(version) AS v FROM schema_version').catch(() => ({ rows: [{ v: 0 }] }));
      return { server: String(rows[0]?.server_version ?? 'PostgreSQL'), schemaVersion: Number(schema.rows[0]?.v ?? 0) };
    } catch (e) {
      this.wrap(e);
    }
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }

  /**
   * Insert-or-update guarded by version: `expected` 0 only creates, otherwise the row must still
   * be at `expected`. Nothing changed means someone else saved first.
   */
  private async saveVersioned(table: 'qa_suites' | 'qa_plans' | 'qa_environments', key: string, keyValue: string, data: unknown, expected: number, user: string | undefined, what: QaConflictError['what']): Promise<{ version: number; updatedAt: string }> {
    // A create that finds the row already there fails on the primary key (23505): someone created it first.
    const res =
      expected === 0
        ? await this.q(`INSERT INTO ${table} (${key}, data, version, updated_at, updated_by) VALUES ($1, $2::jsonb, 1, now(), $3) RETURNING version, updated_at`, [keyValue, json(data), user ?? null]).catch((e) => {
            if ((e as { cause?: { code?: string } }).cause?.code === '23505') return { rows: [], rowCount: 0 } as Rows;
            throw e;
          })
        : await this.q(`UPDATE ${table} SET data = $2::jsonb, version = version + 1, updated_at = now(), updated_by = $3 WHERE ${key} = $1 AND version = $4 RETURNING version, updated_at`, [keyValue, json(data), user ?? null, expected]);
    if (!res.rows.length) {
      const cur = (await this.q(`SELECT updated_by, updated_at FROM ${table} WHERE ${key} = $1`, [keyValue])).rows[0];
      throw new QaConflictError(what, by(cur?.updated_by), iso(cur?.updated_at));
    }
    return { version: Number(res.rows[0].version), updatedAt: iso(res.rows[0].updated_at) ?? new Date().toISOString() };
  }

  async getSuite(projectId: string): Promise<QASuite | null> {
    const row = (await this.q('SELECT data, version, updated_by FROM qa_suites WHERE project_id = $1', [projectId])).rows[0];
    return row ? { ...(row.data as QASuite), version: Number(row.version), updatedBy: by(row.updated_by) } : null;
  }

  async saveSuite(suite: QASuite, user?: string): Promise<QASuite> {
    const data = bare(suite);
    const { version } = await this.saveVersioned('qa_suites', 'project_id', suite.projectId, data, suite.version ?? 0, user, 'suite');
    // QA Cockpit lists projects from here; Tech Lead Cockpit fills in the TADs (upsertProject).
    await this.q(`INSERT INTO qa_projects (id, name, tads, updated_at, updated_by) VALUES ($1, $2, '[]'::jsonb, now(), $3) ON CONFLICT (id) DO NOTHING`, [suite.projectId, suite.projectName || suite.projectId, user ?? null]);
    return { ...(data as QASuite), version, ...(user ? { updatedBy: user } : {}) };
  }

  async getPlan(projectId: string): Promise<QAPlan | null> {
    const row = (await this.q('SELECT data, version, updated_by FROM qa_plans WHERE project_id = $1', [projectId])).rows[0];
    return row ? { ...(row.data as QAPlan), version: Number(row.version), updatedBy: by(row.updated_by) } : null;
  }

  async savePlan(plan: QAPlan, user?: string): Promise<QAPlan> {
    const data = bare(plan);
    const { version } = await this.saveVersioned('qa_plans', 'project_id', plan.projectId, data, plan.version ?? 0, user, 'plan');
    return { ...(data as QAPlan), version, ...(user ? { updatedBy: user } : {}) };
  }

  async listEnvironments(): Promise<QAEnvironment[]> {
    const { rows } = await this.q('SELECT data, version, updated_at, updated_by FROM qa_environments ORDER BY created_at, id');
    return rows.map((r) => ({ ...(r.data as QAEnvironment), version: Number(r.version), updatedAt: iso(r.updated_at), updatedBy: by(r.updated_by) }));
  }

  async saveEnvironment(env: QAEnvironment, user?: string): Promise<QAEnvironment> {
    const data = storableEnvironment(env);
    const { version, updatedAt } = await this.saveVersioned('qa_environments', 'id', env.id, data, env.version ?? 0, user, 'environment');
    return { ...data, version, updatedAt, ...(user ? { updatedBy: user } : {}) };
  }

  async deleteEnvironment(id: string): Promise<void> {
    await this.q('DELETE FROM qa_environments WHERE id = $1', [id]);
  }

  async listRuns(projectId: string): Promise<QARun[]> {
    const { rows } = await this.q('SELECT data FROM qa_runs WHERE project_id = $1 ORDER BY started_at DESC, id DESC', [projectId]);
    return rows.map((r) => r.data as QARun);
  }

  async getRun(projectId: string, id: string): Promise<QARun | undefined> {
    const row = (await this.q('SELECT data FROM qa_runs WHERE project_id = $1 AND id = $2', [projectId, id])).rows[0];
    return row ? (row.data as QARun) : undefined;
  }

  async saveRun(run: QARun, user?: string): Promise<void> {
    await this.q(
      `INSERT INTO qa_runs (id, project_id, started_at, finished_at, status, environment_id, summary, data, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9) ON CONFLICT (id) DO NOTHING`,
      [run.id, run.projectId, run.startedAt, run.finishedAt ?? null, run.status, run.environment?.id ?? null, json(run.summary), json(run), user ?? null],
    );
    await this.q(`DELETE FROM qa_runs WHERE project_id = $1 AND id NOT IN (SELECT id FROM qa_runs WHERE project_id = $1 ORDER BY started_at DESC, id DESC LIMIT ${KEEP_RUNS})`, [run.projectId]);
  }

  async listProjects(): Promise<QAProject[]> {
    const { rows } = await this.q('SELECT id, name, tads, updated_at, updated_by FROM qa_projects ORDER BY name, id');
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), tads: (r.tads as QAProject['tads']) ?? [], updatedAt: iso(r.updated_at) ?? '', updatedBy: by(r.updated_by) }));
  }

  async upsertProject(project: Omit<QAProject, 'updatedAt' | 'updatedBy'>, user?: string): Promise<QAProject> {
    const { rows } = await this.q(
      `INSERT INTO qa_projects (id, name, tads, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, now(), $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tads = EXCLUDED.tads, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING updated_at`,
      [project.id, project.name, json(project.tads), user ?? null],
    );
    return { ...project, updatedAt: iso(rows[0]?.updated_at) ?? new Date().toISOString(), ...(user ? { updatedBy: user } : {}) };
  }
}
