// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installScript, jobsFor, migrateSettings, ReportVps, serverClock, uploadScript, validateSettings, type SshRunner } from './vps.ts';

const snapshot = { version: 1, generatedAt: '2026-10-08T08:30:00.000Z', projects: [{ projectId: 'p1', name: 'Promo', peakPercent: 0, tads: [] }] };

describe('settings & cron', () => {
  it('validates what ends up in remote commands', () => {
    expect(validateSettings({ host: '203.0.113.10', user: 'ubuntu', deliver: 'whatsapp:120363001234567890@g.us' })).toMatchObject({ host: '203.0.113.10', port: 22 });
    expect(() => validateSettings({ host: '1.2.3.4; rm -rf ~' })).toThrow('Alamat VPS');
    expect(() => validateSettings({ user: 'ubuntu$(id)' })).toThrow('User SSH');
    expect(() => validateSettings({ deliver: 'whatsapp:62812"; reboot' })).toThrow('Tujuan');
    expect(() => validateSettings({ times: ['25:00'] })).toThrow('HH:MM');
    expect(() => validateSettings({ enabled: true, host: '' })).toThrow('alamat VPS');
  });

  it('builds one job per send time and migrates old settings', () => {
    expect(jobsFor([1, 2, 3, 4, 5], ['09:00', '16:00'], '+0800')).toEqual([
      { name: 'tad-progress-0900', time: '09:00', cron: '0 10 * * 1,2,3,4,5' },
      { name: 'tad-progress-1600', time: '16:00', cron: '0 17 * * 1,2,3,4,5' },
    ]);
    expect(serverClock('16:00', '+0800')).toBe('17:00');
    expect(serverClock('23:30', '+0800')).toBe('00:30 (+1 hari)');
    expect(validateSettings({ days: [5, 1], times: ['16:00', '09:00'] })).toMatchObject({ days: [1, 5], times: ['09:00', '16:00'] });
    expect(() => validateSettings({ days: [] })).toThrow('hari');
    const migrated = migrateSettings({ timeWib: '15:30', weekdaysOnly: false, deliver: 'allowlist', installed: { at: 'x', cron: '30 16 * * *', serverOffset: '+0800', deliver: 'whatsapp:…7890' } } as never);
    expect(migrated).toMatchObject({ times: ['15:30'], days: [0, 1, 2, 3, 4, 5, 6], installed: { jobs: [{ name: 'tad-progress', time: '15:30', cron: '30 16 * * *' }], times: ['15:30'] } });
    expect(migrated).not.toHaveProperty('timeWib');
  });
});

describe('remote scripts (run with bash -s against a fake HOME)', () => {
  let home = '';
  const env = () => ({ HOME: home, PATH: `${home}/bin:/usr/bin:/bin` });
  const bash = (input: string) => execFileSync('bash', ['-s'], { input, env: env() }).toString();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tlc-vps-'));
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    mkdirSync(join(home, 'bin'));
    mkdirSync(join(home, '.hermes/tad-progress'), { recursive: true });
    writeFileSync(join(home, '.local/bin/hermes'), '#!/bin/bash\necho "hermes $*" >> "$HOME/hermes.log"\n[ "$1 $2" = "cron list" ] && echo "tad-progress  0 17 * * 1-5"\nexit 0\n');
    chmodSync(join(home, '.local/bin/hermes'), 0o755);
    writeFileSync(join(home, 'bin/node'), '#!/bin/bash\necho node "$@"\n');
    chmodSync(join(home, 'bin/node'), 0o755);
    writeFileSync(join(home, '.hermes/.env'), 'TELEGRAM_BOT_TOKEN=x\nWHATSAPP_ALLOWED_USERS=6281234567890\n');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('uploads stdin byte for byte without running it', { timeout: 30_000 }, () => {
    const payload = 'echo PWNED > "$HOME/pwned"\nexit 7\n{"a":1}\nno trailing newline';
    expect(bash(`${uploadScript('.hermes/tad-progress/latest.json')}\n${payload}`)).toMatch(/uploaded\s+\d+ bytes/);
    expect(readFileSync(join(home, '.hermes/tad-progress/latest.json'), 'utf8')).toBe(payload);
    expect(() => readFileSync(join(home, 'pwned'))).toThrow();
    expect(() => uploadScript('../.ssh/authorized_keys')).toThrow();
    // Two uploads at once (desktop app + dev server) must not trip over each other's temp file.
    const script = uploadScript('.hermes/tad-progress/latest.json');
    const runs = [1, 2, 3].map((n) => execFileSync('bash', ['-c', `for i in 1 2 3 4 5; do printf '%s\\n' "$1" '{"n":${n}}' | bash -s & done; wait`, '_', script], { env: env() }).toString());
    expect(runs.join('')).not.toMatch(/cannot stat/);
    expect(readFileSync(join(home, '.hermes/tad-progress/latest.json'), 'utf8')).toMatch(/^\{"n":\d\}\n?$/);
  });

  it('installs the wrapper and one cron job per send time, removing old jobs', () => {
    writeFileSync(join(home, '.hermes/tad-progress/tad-progress.mjs'), '// bundle');
    const jobs = jobsFor([1, 2, 3, 4, 5], ['09:00', '16:00'], '+0800');
    const out = bash(installScript(jobs, 'allowlist', ['tad-progress-1200']));
    expect(out).toContain('__TLC_TARGET__ whatsapp:…7890');
    const calls = readFileSync(join(home, 'hermes.log'), 'utf8');
    for (const old of ['tad-progress', 'tad-progress-1200', 'tad-progress-0900', 'tad-progress-1600']) expect(calls).toContain(`hermes cron remove ${old}`);
    expect(calls).toContain('hermes cron create 0 10 * * 1,2,3,4,5 --no-agent --script tad-progress.sh --deliver whatsapp:6281234567890 --name tad-progress-0900');
    expect(calls).toContain('hermes cron create 0 17 * * 1,2,3,4,5 --no-agent --script tad-progress.sh --deliver whatsapp:6281234567890 --name tad-progress-1600');
    const wrapper = readFileSync(join(home, '.hermes/scripts/tad-progress.sh'), 'utf8');
    expect(wrapper).toContain(`exec "${home}/bin/node" "$HOME/.hermes/tad-progress/tad-progress.mjs" "$@"`);
  });

  it('refuses to install without the bundle or an allowlisted number', () => {
    const jobs = jobsFor([1], ['16:00'], '+0800');
    expect(() => bash(installScript(jobs, 'allowlist'))).toThrow();
    writeFileSync(join(home, '.hermes/tad-progress/tad-progress.mjs'), '// bundle');
    writeFileSync(join(home, '.hermes/.env'), 'WHATSAPP_ALLOWED_USERS=\n');
    expect(() => bash(installScript(jobs, 'allowlist'))).toThrow();
    expect(() => installScript([{ name: 'tad-progress-1600', time: '16:00', cron: '0 17 * * 1; reboot' }], 'allowlist')).toThrow('Cron');
    expect(() => installScript(jobs, 'allowlist', ['rm -rf ~'])).toThrow('Nama job');
  });
});

describe('ReportVps', () => {
  let dir = '';
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'tlc-report-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('syncs a valid snapshot and records failures', async () => {
    const calls: { script: string; stdin?: string }[] = [];
    let code = 0;
    const ssh: SshRunner = async (_s, script, stdin) => (calls.push({ script, stdin }), { stdout: 'uploaded 10 bytes', stderr: code ? 'ssh: connect to host 203.0.113.10 port 22: Connection refused' : '', code });
    const vps = new ReportVps(ssh, dir, join(dir, 'missing.mjs'));
    await expect(vps.sync(snapshot)).rejects.toThrow('Alamat VPS belum diatur');
    await vps.saveSettings({ host: '203.0.113.10' });
    await expect(vps.sync({ nope: 1 })).rejects.toThrow('Snapshot tidak valid');

    const s = await vps.sync(snapshot);
    expect(s.lastSync).toMatchObject({ ok: true, generatedAt: snapshot.generatedAt });
    expect(calls.at(-1)?.stdin).toBe(JSON.stringify(snapshot));
    expect(readFileSync(join(dir, 'latest.json'), 'utf8')).toBe(JSON.stringify(snapshot));

    code = 255;
    await expect(vps.sync(snapshot)).rejects.toThrow('VPS tidak bisa dihubungi');
    expect((await vps.settings()).lastSync).toMatchObject({ ok: false });
    await expect(vps.install()).rejects.toThrow('build:reporter');
  });
});
