import { createHash } from 'node:crypto';
import type { AppSettings } from '../../src/lib/settings/types.ts';
import type { QAStoreStatus } from '../../src/lib/qa/types.ts';
import { createPgPool, PgQaStore, QaStoreError, type PgPoolLike, type QaStoreConnection } from './pg-store.ts';
import { ConfluenceQaStore, type ConfluenceApi } from './confluence-store.ts';
import type { QaStore } from './store.ts';

/**
 * Which store the E2E manager uses, from Settings → Penyimpanan E2E. Files need nothing here (the
 * manager's own file store); Confluence uses the app's Confluence connection; the shared database
 * gets one pool, rebuilt only when the connection or password changes. A shared store that is
 * chosen but not usable never falls back to files silently: every call fails with the reason.
 */

type StoreSettings = AppSettings['qaStore'];

export interface QaStoreSwitchDeps {
  readPassword: () => Promise<string | null>;
  createPool?: (conn: QaStoreConnection, password: string | undefined) => PgPoolLike;
  /** The Confluence connection from Settings; `key` changes when its URL or token does. */
  confluence?: () => Promise<{ api: ConfluenceApi; key: string } | undefined>;
}

/** A chosen database that can't be used: every call says why. */
export function unavailableStore(message: string, kind: QaStore['kind'] = 'postgres'): QaStore {
  const fail = async (): Promise<never> => {
    throw new QaStoreError(message);
  };
  return {
    kind,
    getSuite: fail,
    saveSuite: fail,
    getPlan: fail,
    savePlan: fail,
    listEnvironments: fail,
    saveEnvironment: fail,
    deleteEnvironment: fail,
    listRuns: fail,
    getRun: fail,
    saveRun: fail,
    listProjects: fail,
    upsertProject: fail,
  };
}

export const connectionOf = (s: StoreSettings): QaStoreConnection => ({ host: s.host, port: s.port, database: s.database, user: s.user, ...(s.ssl ? { ssl: true } : {}) });

export class QaStoreSwitch {
  private key = 'file';
  private store?: QaStore;
  private state: QAStoreStatus = { mode: 'file' };
  private applying?: Promise<void>;

  constructor(private readonly deps: QaStoreSwitchDeps) {}

  /** The store for the current settings; undefined = the manager's file store. */
  current(): QaStore | undefined {
    return this.store;
  }

  status(): QAStoreStatus {
    return { ...this.state };
  }

  /** Follows the settings (called at start and whenever they or the password change). */
  apply(settings: StoreSettings): Promise<void> {
    const run = async () => {
      if (settings.mode === 'confluence') {
        const target = `${settings.confluenceSpace} / halaman ${settings.confluenceParentId}`;
        if (!settings.confluenceSpace || !settings.confluenceParentId) {
          await this.swap('cf-incomplete', unavailableStore('Confluence dipilih tapi space dan halaman induk belum diisi di Pengaturan → Penyimpanan E2E.', 'confluence'), { mode: 'confluence', target, error: 'Space atau halaman induk belum diisi.' });
          return;
        }
        const conn = await this.deps.confluence?.().catch(() => undefined);
        if (!conn) {
          await this.swap('cf-offline', unavailableStore('Confluence belum terhubung. Atur URL dan token Confluence di Koneksi.', 'confluence'), { mode: 'confluence', target, error: 'Confluence belum terhubung.' });
          return;
        }
        const key = `cf:${settings.confluenceSpace}:${settings.confluenceParentId}:${conn.key}`;
        if (key === this.key) return;
        await this.swap(key, new ConfluenceQaStore(conn.api, { spaceKey: settings.confluenceSpace, parentPageId: settings.confluenceParentId }), { mode: 'confluence', target });
        return;
      }
      if (settings.mode !== 'postgres') {
        await this.swap('file', undefined, { mode: 'file' });
        return;
      }
      const conn = connectionOf(settings);
      const target = `${conn.host}:${conn.port}/${conn.database}`;
      if (!conn.host || !conn.user) {
        await this.swap('incomplete', unavailableStore('DB pusat dipilih tapi host/user belum diisi di Pengaturan → Penyimpanan E2E.'), { mode: 'postgres', target, error: 'Host atau user belum diisi.' });
        return;
      }
      const password = (await this.deps.readPassword().catch(() => null)) ?? undefined;
      const key = `pg:${JSON.stringify(conn)}:${createHash('sha256').update(password ?? '').digest('hex')}`;
      if (key === this.key) return;
      const pool = (this.deps.createPool ?? createPgPool)(conn, password);
      await this.swap(key, new PgQaStore(pool, conn), { mode: 'postgres', target });
      return;
    };
    // One change at a time, in the order they came.
    this.applying = (this.applying ?? Promise.resolve()).then(run, run);
    return this.applying;
  }

  private async swap(key: string, store: QaStore | undefined, state: QAStoreStatus) {
    if (key === this.key) return;
    const old = this.store;
    this.key = key;
    this.store = store;
    this.state = state;
    await old?.close?.();
  }
}
