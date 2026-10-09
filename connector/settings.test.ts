// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/lib/settings/types.ts';
import { SettingsStore, applySettingsToEnv, settingsFromEnv, validateSettings } from './settings.ts';

describe('settings', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-settings-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('fills defaults and rejects bad input', () => {
    const s = validateSettings({});
    expect(s.workspace).toEqual(DEFAULT_SETTINGS.workspace);
    expect(s.ai.defaultProvider).toBe(DEFAULT_SETTINGS.ai.defaultProvider);
    expect(validateSettings({ jira: { baseUrl: 'https://x.atlassian.net/', auth: 'basic', email: 'a@b.c', defaultProject: 'mu' } }).jira).toEqual({ baseUrl: 'https://x.atlassian.net', auth: 'basic', email: 'a@b.c', defaultProject: 'MU' });
    expect(() => validateSettings({ gitlab: { baseUrl: 'gitlab.local' } })).toThrow('http');
    expect(() => validateSettings({ jira: { baseUrl: '', auth: 'bearer', email: '', defaultProject: 'mu-1' } })).toThrow('Project key');
    expect(() => validateSettings({ workspace: { servicesRoot: '~/x', defaultBaseBranch: 'bad branch' } })).toThrow('branch');
    expect(validateSettings({ ai: { defaultProvider: 'gpt' as never, defaultModel: '', inferhub: { baseUrl: '', model: '' }, ninerouter: { baseUrl: '', model: '' } } }).ai.defaultProvider).toBe('9router');
  });

  it('migrates an install configured through .env.local', () => {
    const s = settingsFromEnv({
      CONFLUENCE_BASE_URL: 'https://org.atlassian.net/wiki',
      CONFLUENCE_AUTH: 'basic',
      CONFLUENCE_EMAIL: 'tl@org.id',
      JIRA_BASE_URL: 'https://org.atlassian.net',
      JIRA_AUTH: 'basic',
      JIRA_EMAIL: 'tl@org.id',
      GITLAB_BASE_URL: 'https://gitlab.org.id',
      NINEROUTER_BASE_URL: 'https://router.example/v1',
      INFERHUB_MODEL: 'cb/gpt-5.4',
      INFERHUB_API_KEY: 'secret-key',
    });
    expect(s.confluence).toEqual({ baseUrl: 'https://org.atlassian.net/wiki', auth: 'basic', email: 'tl@org.id' });
    expect(s.jira.baseUrl).toBe('https://org.atlassian.net');
    expect(s.gitlab.baseUrl).toBe('https://gitlab.org.id');
    expect(s.ai.ninerouter.baseUrl).toBe('https://router.example/v1');
    expect(s.ai.inferhub.model).toBe('cb/gpt-5.4');
    // Secrets never end up in the settings.
    expect(JSON.stringify(s)).not.toContain('secret-key');
    expect(s.setup.completedAt).toBeUndefined();
  });

  it('applies settings onto env, leaving env values the settings do not set', () => {
    const env: Record<string, string | undefined> = { GITLAB_BASE_URL: 'https://old.example', CONFLUENCE_BASE_URL: 'https://keep.example' };
    applySettingsToEnv(validateSettings({ gitlab: { baseUrl: 'https://gitlab.new' }, workspace: { servicesRoot: '~/S', defaultBaseBranch: 'develop' } }), env);
    expect(env.GITLAB_BASE_URL).toBe('https://gitlab.new');
    expect(env.CONFLUENCE_BASE_URL).toBe('https://keep.example');
    expect(env.TLC_SERVICES_ROOT).toBe('~/S');
    expect(env.TLC_DEFAULT_BRANCH).toBe('develop');
    expect(env.JIRA_AUTH).toBeUndefined();
  });

  it('migrates once, then merges each wizard step into the saved file (0600)', async () => {
    const file = join(dir, 'settings.json');
    const store = new SettingsStore(file);
    const first = await store.load({ GITLAB_BASE_URL: 'https://gitlab.org.id' });
    expect(first.migrated).toBe(true);
    expect(first.settings.gitlab.baseUrl).toBe('https://gitlab.org.id');
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await store.update({ ai: { inferhub: { model: 'x/model' } } as never });
    const after = await store.update({ jira: { defaultProject: 'MU' } as never, setup: { completedAt: '2026-10-08T00:00:00Z' } as never });
    // Partial updates keep the rest of each section.
    expect(after.ai.inferhub).toEqual({ baseUrl: DEFAULT_SETTINGS.ai.inferhub.baseUrl, model: 'x/model' });
    expect(after.gitlab.baseUrl).toBe('https://gitlab.org.id');
    expect(after.jira.defaultProject).toBe('MU');
    expect(after.setup.completedAt).toBe('2026-10-08T00:00:00Z');

    // A fresh store reads the file, not the env.
    const again = await new SettingsStore(file).load({ GITLAB_BASE_URL: 'https://other.example' });
    expect(again).toMatchObject({ migrated: false, settings: { gitlab: { baseUrl: 'https://gitlab.org.id' } } });
    await expect(store.update({ gitlab: { baseUrl: 'ftp://x' } })).rejects.toThrow('http');
    expect(JSON.parse(await readFile(file, 'utf8')).gitlab.baseUrl).toBe('https://gitlab.org.id');
  });

  it('starts over from env when the file is corrupt', async () => {
    const file = join(dir, 'settings.json');
    await writeFile(file, '{not json');
    const { settings, migrated } = await new SettingsStore(file).load({ JIRA_BASE_URL: 'https://jira.org.id' });
    expect(migrated).toBe(true);
    expect(settings.jira.baseUrl).toBe('https://jira.org.id');
  });
});

describe('Atlassian auth defaults', () => {
  it('uses email + API token for Cloud and fresh installs, PAT only for an old Server/DC .env', () => {
    expect(settingsFromEnv({}).jira.auth).toBe('basic');
    expect(settingsFromEnv({ JIRA_BASE_URL: 'https://acme.atlassian.net' }).jira.auth).toBe('basic');
    expect(settingsFromEnv({ JIRA_BASE_URL: 'https://jira.acme.co.id' }).jira.auth).toBe('bearer');
    expect(settingsFromEnv({ CONFLUENCE_BASE_URL: 'https://confluence.acme.co.id', CONFLUENCE_AUTH: 'basic' }).confluence.auth).toBe('basic');
  });
});
