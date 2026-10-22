// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { QAEnvironment } from '../../src/lib/qa/types.ts';
import { decryptSecrets, encryptSecrets } from './env-transfer.ts';
import { QaManager } from './manager.ts';
import { memoryStore } from './test-store.ts';

/** A laptop: its own Keychain, on a shared (or its own) workspace. */
function laptop(store = memoryStore().store) {
  const keychain = new Map<string, string>();
  const qa = new QaManager({
    dir: '/nonexistent',
    store,
    actor: async () => 'tl@example.test',
    readSecret: async (k) => keychain.get(k) ?? null,
    writeSecret: async (k, v) => (keychain.set(k, v), true),
    deleteSecret: async (k) => keychain.delete(k),
    runAi: () => ({ done: Promise.resolve({ reply: '' }), cancel: () => {} }),
  });
  return { qa, keychain };
}

const env = (extra: Partial<QAEnvironment> = {}): Partial<QAEnvironment> => ({
  name: 'Development',
  baseUrl: 'https://api.dev.test',
  services: { promo: 'https://promo.dev.test' },
  headers: {},
  variables: { merchantId: 'M1' },
  auth: { type: 'bearer' },
  readOnly: false,
  timeoutMs: 5_000,
  dbServer: { host: 'db.dev.test', port: 5432, user: 'qa' },
  databases: [{ name: 'promo', database: 'promo_db', host: 'db-promo.dev.test' }],
  ...extra,
});

describe('environment import/export', () => {
  it('encrypts secrets with the passphrase only', () => {
    const blob = encryptSecrets({ a: { token: 'rahasia' } }, 'kata sandi panjang');
    expect(JSON.stringify(blob)).not.toContain('rahasia');
    expect(decryptSecrets(blob, 'kata sandi panjang')).toEqual({ a: { token: 'rahasia' } });
    expect(() => decryptSecrets(blob, 'salah sekali')).toThrow(/Passphrase salah/);
    expect(() => encryptSecrets({}, 'pendek')).toThrow(/minimal 8/);
  });

  it('moves environments with their Keychain secrets to another laptop', async () => {
    const tl = laptop();
    await tl.qa.saveEnvironment(env(), 'token-tl', { apiKey: 'k-1' }, { promo: 'pw-promo' }, 'pw-server');
    const file = await tl.qa.exportEnvironments(undefined, 'passphrase rahasia');
    expect(JSON.stringify(file)).not.toMatch(/token-tl|k-1|pw-promo|pw-server/);
    expect(file.environments[0]).not.toHaveProperty('hasSecret');

    const qa = laptop();
    const locked = await qa.qa.previewImport(file);
    expect(locked).toMatchObject({ hasSecrets: true, secretsOpened: false });
    const preview = await qa.qa.previewImport(file, 'passphrase rahasia');
    expect(preview.items[0]).toMatchObject({ name: 'Development', secrets: ['token auth', 'variabel rahasia apiKey', 'password server DB', 'password DB promo'] });
    expect(preview.items[0].match).toBeUndefined();

    const r = await qa.qa.importEnvironments(file, 'passphrase rahasia');
    expect(r).toMatchObject({ imported: 1, skipped: 0 });
    expect(r.environments[0]).toMatchObject({ name: 'Development', hasSecret: true, secretVariableNames: ['apiKey'], dbServerPassword: true, dbPasswords: { promo: true } });
    const id = r.environments[0].id;
    expect([...qa.keychain.entries()].sort()).toEqual(
      [
        [id, 'token-tl'],
        [`${id}:vars`, JSON.stringify({ apiKey: 'k-1' })],
        [`${id}:dbserver`, 'pw-server'],
        [`${id}:db:promo`, 'pw-promo'],
      ].sort(),
    );
    await expect(qa.qa.importEnvironments(file, 'passphrase keliru')).rejects.toThrow(/Passphrase salah/);
  });

  it('replaces a matching environment, adds copies, skips; secrets stay without a passphrase', async () => {
    const tl = laptop();
    await tl.qa.saveEnvironment(env({ baseUrl: 'https://api.baru.test' }), 'token-baru');
    const file = await tl.qa.exportEnvironments(undefined);
    expect(file.secrets).toBeUndefined();

    const qa = laptop();
    const [mine] = await qa.qa.saveEnvironment(env(), 'token-lama');
    const preview = await qa.qa.previewImport(file);
    expect(preview.items[0].match).toMatchObject({ id: mine.id, by: 'name' });

    const fileId = file.environments[0].id;
    let r = await qa.qa.importEnvironments(file, undefined, { [fileId]: 'replace' });
    expect(r.environments).toHaveLength(1);
    expect(r.environments[0]).toMatchObject({ id: mine.id, baseUrl: 'https://api.baru.test', hasSecret: true });
    expect(qa.keychain.get(mine.id)).toBe('token-lama');
    r = await qa.qa.importEnvironments(file, undefined, { [fileId]: 'new' });
    expect(r.environments.map((e) => e.name).sort()).toEqual(['Development', 'Development (2)']);
    r = await qa.qa.importEnvironments(file, undefined, { [fileId]: 'skip' });
    expect(r).toMatchObject({ imported: 0, skipped: 1 });
    await expect(qa.qa.previewImport({ format: 'lain' })).rejects.toThrow(/format tidak dikenal/);
  });
});
