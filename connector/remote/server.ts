import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MobileAgentTask, MobileE2E, MobileMr, MobileProject, RemoteReportTarget } from '../../src/lib/remote/types.ts';
import { RemoteAuthError } from './auth.ts';
import type { RemoteAccess } from './manager.ts';
import { pwaAssets } from './pwa-assets.ts';

/**
 * The Remote listener's whole surface. Routing is a closed table: the PWA's static files and the
 * mobile API below. Nothing here reaches the desktop connector's routes (coder push, publish,
 * Jira transitions, token saving, …), so those cannot be called through Remote at all.
 */

export interface MobileData {
  projects(): Promise<MobileProject[]>;
  agentTasks(): Promise<{ counts: Record<string, number>; tasks: MobileAgentTask[] }>;
  mrs(): Promise<MobileMr[]>;
  e2e(): Promise<MobileE2E[]>;
  /** The Progress Report text for a project (same builder as the desktop modal). */
  reportText(projectId: string): Promise<{ projectName: string; text: string }>;
  sendWhatsApp(target: RemoteReportTarget, text: string): Promise<void>;
}

const MAX_BODY = 16 * 1024;

/** Routes the phone may call; everything else is a 404 from this listener. */
export const MOBILE_API_ROUTES = [
  'POST /m/api/pair',
  'POST /m/api/session',
  'GET /m/api/status',
  'GET /m/api/projects',
  'GET /m/api/agent-tasks',
  'GET /m/api/mrs',
  'GET /m/api/e2e',
  'POST /m/api/report/draft',
  'POST /m/api/report/send',
  'POST /m/api/remote/disable',
] as const;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function baseHeaders(res: ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const fail = (res: ServerResponse, status: number, error: string, code: string) => json(res, status, { error, code });

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new RemoteAuthError('Payload terlalu besar.', 413, 'limit');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    throw new RemoteAuthError('Body bukan JSON yang valid.', 400, 'limit');
  }
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

export async function handleRemoteRequest(req: IncomingMessage, res: ServerResponse, remote: RemoteAccess): Promise<void> {
  baseHeaders(res);
  remote.checkExpiry();
  if (!remote.isActive) return fail(res, 503, 'Remote Cockpit sedang nonaktif.', 'inactive');

  // DNS rebinding guard: answer only to this Mac's own Tailscale name/IP.
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!remote.allowedHosts().has(host)) return fail(res, 421, 'Host tidak dikenal.', 'bad-host');

  const url = new URL(req.url ?? '/', 'http://remote.invalid');
  const path = url.pathname;
  const route = `${req.method} ${path}`;

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (path === '/' || path === '/m') {
      res.statusCode = 302;
      res.setHeader('Location', '/m/');
      return void res.end();
    }
    const file = pwaAssets().get(path);
    if (file) {
      res.statusCode = 200;
      res.setHeader('Content-Type', file.type);
      res.setHeader('Cache-Control', file.type === 'image/png' ? 'max-age=86400' : 'no-cache');
      if (path === '/m/sw.js') res.setHeader('Service-Worker-Allowed', '/m/');
      return void res.end(req.method === 'HEAD' ? undefined : file.body);
    }
  }

  if (!(MOBILE_API_ROUTES as readonly string[]).includes(route)) return fail(res, 404, 'Tidak tersedia lewat Remote.', 'not-found');

  // Same-origin only: a browser sending a foreign Origin is another site.
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      /* invalid origin */
    }
    if (!remote.allowedHosts().has(originHost)) return fail(res, 403, 'Origin ditolak.', 'forbidden');
  }

  try {
    if (route === 'POST /m/api/pair') {
      const body = await readBody(req);
      const { device, secret } = await remote.auth.pair(body.code, body.name);
      await remote.audit('remote.pair', `Perangkat dipasangkan: ${device.name}`, { actor: `remote:${device.name}` });
      return json(res, 200, { deviceId: device.id, deviceName: device.name, secret });
    }
    if (route === 'POST /m/api/session') {
      const body = await readBody(req);
      const s = await remote.auth.createSession(body.deviceId, body.secret);
      remote.noteConnection(s.device.name, s.isNew);
      return json(res, 200, { token: s.token, expiresAt: new Date(s.expiresAt).toISOString(), remoteExpiresAt: new Date(remote.expiresAt ?? s.expiresAt).toISOString(), deviceName: s.device.name });
    }

    const device = await remote.auth.authenticate(bearer(req));
    if (!device) return fail(res, 401, 'Sesi tidak berlaku. Sambungkan ulang.', 'unauthorized');
    const actor = `remote:${device.name}`;
    const audit = (title: string, extra = {}) => remote.audit('remote.action', title, { actor, ...extra });

    if (route === 'GET /m/api/status') {
      const s = await remote.status();
      return json(res, 200, { expiresAt: s.expiresAt, deviceName: device.name, devices: s.devices.length, https: s.https });
    }
    if (route === 'GET /m/api/projects') {
      void audit('Lihat proyek');
      return json(res, 200, await remote.deps.data.projects());
    }
    if (route === 'GET /m/api/agent-tasks') {
      void audit('Lihat agent tasks');
      return json(res, 200, await remote.deps.data.agentTasks());
    }
    if (route === 'GET /m/api/mrs') {
      void audit('Lihat MR terbuka');
      return json(res, 200, await remote.deps.data.mrs());
    }
    if (route === 'GET /m/api/e2e') {
      void audit('Lihat hasil E2E');
      return json(res, 200, await remote.deps.data.e2e());
    }
    if (route === 'POST /m/api/report/draft') {
      const body = await readBody(req);
      const projectId = typeof body.projectId === 'string' && /^[\w-]{1,64}$/.test(body.projectId) ? body.projectId : '';
      if (!projectId) return fail(res, 400, 'Proyek tidak valid.', 'bad-request');
      const { projectName, text } = await remote.deps.data.reportText(projectId);
      const target = (await remote.settings()).reportTargets[projectId];
      const draft = remote.saveDraft({ projectId, projectName, text, target, deviceId: device.id });
      void audit(`Draft Progress Report: ${projectName}`);
      return json(res, 200, { draftId: draft.id, projectId, text, target: target?.name, expiresAt: new Date(draft.expiresAt).toISOString() });
    }
    if (route === 'POST /m/api/report/send') {
      const body = await readBody(req);
      if (body.confirm !== true) return fail(res, 400, 'Konfirmasi pengiriman wajib.', 'bad-request');
      // The phone can only send the text the connector drafted, to the group set on the laptop.
      const draft = remote.takeDraft(body.draftId, device.id);
      if (!draft) return fail(res, 410, 'Draft kedaluwarsa atau sudah dikirim. Buat draft baru.', 'expired');
      if (!draft.target) return fail(res, 409, 'Grup WhatsApp tujuan belum diatur untuk proyek ini (atur di laptop: Remote → Tujuan laporan).', 'not-configured');
      try {
        await remote.deps.data.sendWhatsApp(draft.target, draft.text);
      } catch (e) {
        await audit(`Kirim Progress Report: ${draft.projectName} → ${draft.target.name}`, { result: 'failure', error: (e as Error).message });
        return fail(res, 502, `Gagal mengirim: ${(e as Error).message}`, 'upstream');
      }
      await audit(`Kirim Progress Report: ${draft.projectName} → ${draft.target.name}`);
      return json(res, 200, { ok: true, target: draft.target.name });
    }
    if (route === 'POST /m/api/remote/disable') {
      const body = await readBody(req);
      if (body.confirm !== true) return fail(res, 400, 'Konfirmasi wajib.', 'bad-request');
      await audit('Matikan Remote dari HP');
      // After the response is flushed: disabling closes this very connection.
      res.once('finish', () => void remote.disable('phone', actor));
      return json(res, 200, { ok: true });
    }
    return fail(res, 404, 'Tidak tersedia lewat Remote.', 'not-found');
  } catch (e) {
    if (e instanceof RemoteAuthError) return fail(res, e.status, e.message, e.code);
    remote.deps.log(`[remote] ${route}: ${(e as Error).message}`);
    return fail(res, 500, `Gagal: ${(e as Error).message}`.slice(0, 300), 'internal');
  }
}
