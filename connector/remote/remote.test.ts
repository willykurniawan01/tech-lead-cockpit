// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../src/lib/confluence/api-types.ts';
import { connectorMiddleware } from '../dev-connector.ts';
import { MAX_AUTH_FAILURES, PAIR_CODE_TTL_MS, SESSION_TTL_MS } from './auth.ts';
import { RemoteAccess, resolveExpiry, type RemoteDeps } from './manager.ts';
import type { MobileData } from './server.ts';
import { isTailscaleIPv4 } from './tailscale.ts';

const HOUR = 3_600_000;

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Res {
  status: number;
  body: any;
  text: string;
}

/** Raw HTTP so the Host header can be set; rejects with ECONNREFUSED when nothing listens. */
function call(port: number, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...opts.headers,
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: any = undefined;
          try {
            body = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body, text });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: 'ECONNREFUSED' });

function mockData(): MobileData & { [K in keyof MobileData]: ReturnType<typeof vi.fn> } {
  return {
    projects: vi.fn(async () => [{ id: 'p1', name: 'Payment', devPercent: 40, livePercent: 40, tasks: 2, stages: { merged: 0, review: 1, inProgress: 0, todo: 1 }, attention: [], targetComplete: false, errors: [] }]),
    agentTasks: vi.fn(async () => ({ counts: { running: 1 }, tasks: [] })),
    mrs: vi.fn(async () => []),
    e2e: vi.fn(async () => []),
    reportText: vi.fn(async () => ({ projectName: 'Payment', text: '🚀 *Project Progress Report — Payment*' })),
    sendWhatsApp: vi.fn(async () => {}),
  } as never;
}

describe('Remote Access', () => {
  let dir: string;
  let port: number;
  let clock: number;
  let audit: AuditEvent[];
  let timers: { fn: () => void; ms: number; cancelled: boolean }[];
  let data: ReturnType<typeof mockData>;
  let remote: RemoteAccess;

  const make = (over: Partial<RemoteDeps> = {}) =>
    new RemoteAccess({
      dir,
      port,
      appendAudit: async (e) => void audit.push(e),
      data,
      detect: async () => ({ ip: '127.0.0.1' }),
      tls: async () => Promise.reject(new Error('no cert in tests')),
      notify: vi.fn(),
      now: () => clock,
      schedule: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => (t.cancelled = true);
      },
      allowLoopback: true,
      log: () => {},
      ...over,
    });

  async function pairAndSession(name = 'iPhone Willy') {
    const { code } = await remote.pairStart();
    const paired = await call(port, 'POST', '/m/api/pair', { body: { code, name } });
    expect(paired.status).toBe(200);
    const session = await call(port, 'POST', '/m/api/session', { body: { deviceId: paired.body.deviceId, secret: paired.body.secret } });
    expect(session.status).toBe(200);
    return { deviceId: paired.body.deviceId as string, secret: paired.body.secret as string, token: session.body.token as string };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tlc-remote-'));
    port = await freePort();
    clock = Date.parse('2026-10-07T10:00:00Z');
    audit = [];
    timers = [];
    data = mockData();
    remote = make();
  });

  afterEach(async () => {
    await remote.disable('test-cleanup');
    await rm(dir, { recursive: true, force: true });
  });

  describe('activation cycle', () => {
    it('is off by default: no listener at all', async () => {
      expect((await remote.status()).active).toBe(false);
      await refused(call(port, 'GET', '/m/'));
    });

    it('requires a bounded duration (no "forever")', async () => {
      await expect(remote.enable(undefined)).rejects.toThrow(/durasi/i);
      await expect(remote.enable({ kind: 'forever' } as never)).rejects.toThrow(/selamanya/);
      await expect(remote.enable({ kind: 'until', until: new Date(clock + 25 * HOUR).toISOString() })).rejects.toThrow(/24 jam/);
      await expect(remote.enable({ kind: 'until', until: new Date(clock + 60_000).toISOString() })).rejects.toThrow(/5 menit/);
      expect(resolveExpiry({ kind: '2h' }, clock)).toBe(clock + 2 * HOUR);
      expect(resolveExpiry({ kind: '8h' }, clock)).toBe(clock + 8 * HOUR);
      await refused(call(port, 'GET', '/m/'));
    });

    it('refuses without Tailscale, with a clear message, and opens nothing', async () => {
      remote = make({ detect: async () => Promise.reject(new Error('Tailscale tidak ditemukan di Mac ini.')) });
      await expect(remote.enable({ kind: '2h' })).rejects.toThrow('Tailscale tidak ditemukan');
      expect((await remote.status()).active).toBe(false);
      expect(audit.at(-1)).toMatchObject({ action: 'remote.enable', result: 'failure' });
      await refused(call(port, 'GET', '/m/'));
    });

    it('binds only to a Tailscale address (100.64.0.0/10)', async () => {
      remote = make({ detect: async () => ({ ip: '192.168.1.20' }), allowLoopback: false });
      await expect(remote.enable({ kind: '2h' })).rejects.toThrow(/bukan alamat Tailscale/);
      remote = make({ allowLoopback: false });
      await expect(remote.enable({ kind: '2h' })).rejects.toThrow(/bukan alamat Tailscale/);
      expect(isTailscaleIPv4('100.64.0.1')).toBe(true);
      expect(isTailscaleIPv4('100.127.255.254')).toBe(true);
      expect(isTailscaleIPv4('100.128.0.1')).toBe(false);
      expect(isTailscaleIPv4('10.0.0.1')).toBe(false);
    });

    it('opens the listener on enable and really closes it on disable', async () => {
      const status = await remote.enable({ kind: '2h' });
      expect(status).toMatchObject({ active: true, baseUrl: `http://127.0.0.1:${port}`, https: false });
      expect(status.expiresAt).toBe(new Date(clock + 2 * HOUR).toISOString());
      const page = await call(port, 'GET', '/m/');
      expect(page.status).toBe(200);
      expect(page.text).toContain('Cockpit Remote');

      await remote.disable('desktop', 'desktop');
      expect((await remote.status()).active).toBe(false);
      await refused(call(port, 'GET', '/m/'));
      expect(audit.map((a) => a.action)).toEqual(['remote.enable', 'remote.disable']);
      expect(timers[0].cancelled).toBe(true);
    });

    it('turns off when the duration ends (timer), closing the listener', async () => {
      await remote.enable({ kind: '2h' });
      expect(timers[0].ms).toBe(2 * HOUR);
      clock += 2 * HOUR;
      timers[0].fn();
      await vi.waitFor(async () => expect((await remote.status()).active).toBe(false));
      await vi.waitFor(() => refused(call(port, 'GET', '/m/')));
      expect((await remote.status()).lastStop?.reason).toBe('expired');
    });

    it('never serves a request past expiry, even if the timer has not fired', async () => {
      await remote.enable({ kind: 'until', until: new Date(clock + HOUR).toISOString() });
      const { token } = await pairAndSession();
      clock += HOUR + 1;
      const r = await call(port, 'GET', '/m/api/projects', { token }).catch((e) => e);
      expect(r.status === 503 || r.code === 'ECONNRESET' || r.code === 'ECONNREFUSED').toBe(true);
      await vi.waitFor(() => refused(call(port, 'GET', '/m/')));
      expect(data.projects).not.toHaveBeenCalled();
    });

    it('can be turned off from the phone (with confirmation)', async () => {
      await remote.enable({ kind: '8h' });
      const { token } = await pairAndSession();
      expect((await call(port, 'POST', '/m/api/remote/disable', { token, body: {} })).status).toBe(400);
      expect((await call(port, 'POST', '/m/api/remote/disable', { token, body: { confirm: true } })).status).toBe(200);
      await vi.waitFor(() => refused(call(port, 'GET', '/m/')));
      expect((await remote.status()).lastStop?.reason).toBe('phone');
    });

    it('refuses a second enable while active', async () => {
      await remote.enable({ kind: '2h' });
      await expect(remote.enable({ kind: '8h' })).rejects.toThrow(/sudah aktif/);
    });
  });

  describe('pairing', () => {
    it('is only possible while Remote is on', async () => {
      await expect(remote.pairStart()).rejects.toThrow(/Aktifkan Remote/);
    });

    it('trades a one-time code for a device secret; the code works once', async () => {
      await remote.enable({ kind: '2h' });
      const { code } = await remote.pairStart();
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect((await call(port, 'POST', '/m/api/pair', { body: { code: 'ZZZZ-ZZZZ', name: 'x' } })).status).toBe(401);
      const ok = await call(port, 'POST', '/m/api/pair', { body: { code: code.toLowerCase(), name: 'iPhone' } });
      expect(ok.status).toBe(200);
      expect(ok.body.secret).toMatch(/^[\w-]{40,}$/);
      const again = await call(port, 'POST', '/m/api/pair', { body: { code, name: 'iPhone 2' } });
      expect(again.status).toBe(401);
      const devices = (await remote.status()).devices;
      expect(devices).toHaveLength(1);
      expect(JSON.stringify(devices)).not.toContain(ok.body.secret);
      expect(audit.some((a) => a.action === 'remote.pair' && a.title.includes('iPhone'))).toBe(true);
    });

    it('rejects an expired code', async () => {
      await remote.enable({ kind: '2h' });
      const { code } = await remote.pairStart();
      clock += PAIR_CODE_TTL_MS + 1;
      const r = await call(port, 'POST', '/m/api/pair', { body: { code, name: 'iPhone' } });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('expired');
    });

    it('a new code replaces the previous one', async () => {
      await remote.enable({ kind: '2h' });
      const first = await remote.pairStart();
      await remote.pairStart();
      expect((await call(port, 'POST', '/m/api/pair', { body: { code: first.code } })).status).toBe(401);
    });

    it('revoking a device kills its session at once and blocks new sessions', async () => {
      await remote.enable({ kind: '2h' });
      const { deviceId, secret, token } = await pairAndSession();
      expect((await call(port, 'GET', '/m/api/projects', { token })).status).toBe(200);
      await remote.revoke(deviceId);
      expect((await call(port, 'GET', '/m/api/projects', { token })).status).toBe(401);
      const s = await call(port, 'POST', '/m/api/session', { body: { deviceId, secret } });
      expect(s.status).toBe(401);
      expect(s.body.code).toBe('revoked');
      expect(audit.some((a) => a.action === 'remote.revoke')).toBe(true);
    });

    it('survives a restart (devices persist) but never the active state', async () => {
      await remote.enable({ kind: '2h' });
      const { deviceId } = await pairAndSession();
      await remote.disable('connector-restart');
      remote = make();
      const s = await remote.status();
      expect(s.active).toBe(false);
      expect(s.devices.map((d) => d.id)).toEqual([deviceId]);
    });
  });

  describe('session tokens', () => {
    it('need the right device secret', async () => {
      await remote.enable({ kind: '2h' });
      const { deviceId } = await pairAndSession();
      expect((await call(port, 'POST', '/m/api/session', { body: { deviceId, secret: 'wrong-secret-wrong-secret-wrong-secret' } })).status).toBe(401);
      expect((await call(port, 'GET', '/m/api/projects')).status).toBe(401);
      expect((await call(port, 'GET', '/m/api/projects', { token: 'x'.repeat(43) })).status).toBe(401);
    });

    it('stop working when Remote is turned off, and stay dead after re-enabling', async () => {
      await remote.enable({ kind: '2h' });
      const { deviceId, secret, token } = await pairAndSession();
      await remote.disable('desktop');
      await remote.enable({ kind: '2h' });
      expect((await call(port, 'GET', '/m/api/projects', { token })).status).toBe(401);
      // The paired device simply opens a new session in the new activation.
      const s = await call(port, 'POST', '/m/api/session', { body: { deviceId, secret } });
      expect(s.status).toBe(200);
      expect(s.body.token).not.toBe(token);
      expect((await call(port, 'GET', '/m/api/projects', { token: s.body.token })).status).toBe(200);
    });

    it('expire after 15 minutes and never outlive the activation', async () => {
      await remote.enable({ kind: 'until', until: new Date(clock + 10 * 60_000).toISOString() });
      const { token } = await pairAndSession();
      expect(remote.expiresAt).toBe(clock + 10 * 60_000);
      clock += 10 * 60_000 - 1;
      expect((await call(port, 'GET', '/m/api/status', { token })).status).toBe(200);
      await remote.disable('x');
      clock = Date.parse('2026-10-07T12:00:00Z');
      await remote.enable({ kind: '2h' });
      const second = await pairAndSession('iPad');
      clock += SESSION_TTL_MS;
      expect((await call(port, 'GET', '/m/api/status', { token: second.token })).status).toBe(401);
    });

    it('notify the laptop once per new connection and audit it', async () => {
      const notify = vi.fn();
      remote = make({ notify });
      await remote.enable({ kind: '2h' });
      const { deviceId, secret } = await pairAndSession('iPhone Willy');
      await call(port, 'POST', '/m/api/session', { body: { deviceId, secret } }); // refresh: not a new connection
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][1]).toContain('iPhone Willy');
      const s = await remote.status();
      expect(s.connectionSeq).toBe(1);
      expect(s.devices[0].connected).toBe(true);
      expect(audit.filter((a) => a.action === 'remote.connect')).toHaveLength(1);
    });

    it('too many failed attempts turn Remote off', async () => {
      await remote.enable({ kind: '2h' });
      for (let i = 0; i < MAX_AUTH_FAILURES; i++) await call(port, 'POST', '/m/api/session', { body: { deviceId: 'nope', secret: 'nope' } }).catch(() => {});
      await vi.waitFor(async () => expect((await remote.status()).active).toBe(false));
      expect((await remote.status()).lastStop?.reason).toBe('too-many-failures');
    });
  });

  describe('route whitelist on the Remote listener', () => {
    const blocked = [
      ['POST', '/api/connector/coder/runs/push'],
      ['POST', '/api/connector/coder/runs'],
      ['POST', '/api/connector/confluence/publish'],
      ['POST', '/api/connector/confluence/save-token'],
      ['POST', '/api/connector/jira/save-token'],
      ['POST', '/api/connector/gitlab/save-token'],
      ['POST', '/api/connector/jira/transition'],
      ['POST', '/api/connector/wa/send'],
      ['POST', '/api/connector/ai/assistant/chat'],
      ['POST', '/api/connector/ai/claude-cloud/start'],
      ['POST', '/api/connector/open-external'],
      ['POST', '/api/connector/qa/runs'],
      ['POST', '/api/connector/agent-tasks'],
      ['POST', '/api/connector/remote/enable'],
      ['POST', '/api/connector/remote/pair'],
      ['POST', '/api/connector/remote/settings'],
      ['GET', '/api/connector/audit'],
      ['GET', '/api/connector/drafts'],
      ['GET', '/m/api/../../api/connector/audit'],
      ['DELETE', '/m/api/projects'],
      ['PUT', '/m/api/report/send'],
      ['GET', '/src/main.ts'],
      ['GET', '/m/../package.json'],
    ] as const;

    it('serves none of the desktop connector routes, even with a valid session and app headers', async () => {
      await remote.enable({ kind: '2h' });
      const { token } = await pairAndSession();
      for (const [method, path] of blocked) {
        const r = await call(port, method, path, {
          token,
          body: method === 'GET' ? undefined : { token: 'x', key: 'ABC-1', id: '1' },
          headers: { 'x-tlc-client': '1', origin: `http://127.0.0.1:${port}` },
        });
        expect([404, 302], `${method} ${path}`).toContain(r.status);
        if (r.status === 404) expect(r.body?.code, `${method} ${path}`).toBe('not-found');
      }
      for (const fn of Object.values(data)) expect(fn).not.toHaveBeenCalled();
    });

    it('serves the PWA and the mobile API only', async () => {
      await remote.enable({ kind: '2h' });
      for (const p of ['/m/', '/m/app.js', '/m/app.css', '/m/sw.js', '/m/manifest.webmanifest', '/m/icon-512.png', '/m/apple-touch-icon.png']) {
        const r = await call(port, 'GET', p);
        expect(r.status, p).toBe(200);
      }
      const page = await call(port, 'GET', '/m/');
      expect(page.text).not.toMatch(/<script>[^<]/);
      const { token } = await pairAndSession();
      for (const p of ['/m/api/projects', '/m/api/agent-tasks', '/m/api/mrs', '/m/api/e2e', '/m/api/status']) expect((await call(port, 'GET', p, { token })).status, p).toBe(200);
      expect(audit.filter((a) => a.action === 'remote.action').length).toBeGreaterThanOrEqual(4);
    });

    it('answers only to its own host name (DNS rebinding) and same-origin requests', async () => {
      await remote.enable({ kind: '2h' });
      expect((await call(port, 'GET', '/m/', { headers: { host: 'evil.example:1234' } })).status).toBe(421);
      const { token } = await pairAndSession();
      expect((await call(port, 'GET', '/m/api/projects', { token, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    });
  });

  describe('progress report from the phone', () => {
    it('sends only the drafted text, only to the group set on the laptop, once, after confirmation', async () => {
      await remote.enable({ kind: '2h' });
      const { token } = await pairAndSession();

      const noTarget = await call(port, 'POST', '/m/api/report/draft', { token, body: { projectId: 'p1' } });
      expect(noTarget.status).toBe(200);
      expect((await call(port, 'POST', '/m/api/report/send', { token, body: { draftId: noTarget.body.draftId, confirm: true } })).status).toBe(409);

      await remote.saveSettings({ reportTargets: { p1: { jid: '120363000000000000@g.us', name: 'Squad Payment' } } });
      await expect(remote.saveSettings({ reportTargets: { p1: { jid: '6281234567890@s.whatsapp.net', name: 'DM' } } })).rejects.toThrow(/grup/);

      const draft = await call(port, 'POST', '/m/api/report/draft', { token, body: { projectId: 'p1' } });
      expect(draft.body).toMatchObject({ target: 'Squad Payment', text: expect.stringContaining('Progress Report') });
      expect((await call(port, 'POST', '/m/api/report/send', { token, body: { draftId: draft.body.draftId } })).status).toBe(400);
      const sent = await call(port, 'POST', '/m/api/report/send', { token, body: { draftId: draft.body.draftId, confirm: true, text: 'injected', jid: 'x@g.us' } });
      expect(sent.status).toBe(200);
      expect(data.sendWhatsApp).toHaveBeenCalledWith({ jid: '120363000000000000@g.us', name: 'Squad Payment' }, '🚀 *Project Progress Report — Payment*');
      expect((await call(port, 'POST', '/m/api/report/send', { token, body: { draftId: draft.body.draftId, confirm: true } })).status).toBe(410);

      // Another device cannot send someone else's draft.
      const other = await pairAndSession('iPad');
      const d2 = await call(port, 'POST', '/m/api/report/draft', { token, body: { projectId: 'p1' } });
      expect((await call(port, 'POST', '/m/api/report/send', { token: other.token, body: { draftId: d2.body.draftId, confirm: true } })).status).toBe(410);
      expect(data.sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(audit.some((a) => a.action === 'remote.action' && a.title.includes('Kirim Progress Report') && a.actor === 'remote:iPhone Willy')).toBe(true);
    });
  });

  describe('desktop control routes', () => {
    it('live on the local connector behind the app origin check', async () => {
      const mw = connectorMiddleware({}, { readToken: async () => null, appendAudit: async () => {}, readAudit: async () => [], logError: () => {}, remote: () => remote });
      const server = http.createServer((req, res) => mw(req, res, () => ((res.statusCode = 404), res.end())));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const local = (server.address() as AddressInfo).port;
      try {
        const app = { 'x-tlc-client': '1', origin: 'http://localhost:5173' };
        expect((await call(local, 'POST', '/api/connector/remote/enable', { body: { duration: { kind: '2h' } } })).status).toBe(403);
        expect((await call(local, 'POST', '/api/connector/remote/enable', { body: { duration: { kind: '2h' } }, headers: { 'x-tlc-client': '1', origin: 'https://evil.example' } })).status).toBe(403);
        const on = await call(local, 'POST', '/api/connector/remote/enable', { body: { duration: { kind: '2h' } }, headers: app });
        expect(on.status).toBe(200);
        expect(on.body.active).toBe(true);
        const pairing = await call(local, 'POST', '/api/connector/remote/pair', { body: {}, headers: app });
        expect(pairing.body.url).toBe(`http://127.0.0.1:${port}/m/#pair=${pairing.body.code}`);
        const off = await call(local, 'POST', '/api/connector/remote/disable', { body: {}, headers: app });
        expect(off.body.active).toBe(false);
        await refused(call(port, 'GET', '/m/'));
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });
});
