import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RemoteDuration } from '../../src/lib/remote/types.ts';
import { RemoteAuthError } from './auth.ts';
import { RemoteInputError, type RemoteAccess } from './manager.ts';

/**
 * Laptop-side control of Remote Access under /api/connector/remote/*. These routes live on the
 * local connector only (127.0.0.1 + app origin + X-TLC-Client); the Remote listener never routes
 * here, so a phone can never turn Remote on, pair itself, or change the report targets.
 */

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new RemoteInputError('Payload terlalu besar.', 413);
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new RemoteInputError('Body bukan JSON yang valid.');
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export async function handleRemoteRoutes(route: string, req: IncomingMessage, res: ServerResponse, remote: RemoteAccess): Promise<void> {
  try {
    if (route === 'GET /remote/status') return send(res, 200, await remote.status());
    if (route === 'POST /remote/enable') {
      const b = await body(req);
      return send(res, 200, await remote.enable(b.duration as RemoteDuration));
    }
    if (route === 'POST /remote/disable') return send(res, 200, await remote.disable('desktop', 'desktop'));
    if (route === 'POST /remote/pair') return send(res, 200, await remote.pairStart());
    if (route === 'POST /remote/devices/revoke') {
      const b = await body(req);
      if (typeof b.deviceId !== 'string') throw new RemoteInputError('deviceId wajib.');
      return send(res, 200, await remote.revoke(b.deviceId));
    }
    if (route === 'GET /remote/settings') return send(res, 200, await remote.settings());
    if (route === 'POST /remote/settings') return send(res, 200, await remote.saveSettings(await body(req)));
    return send(res, 404, { error: `Route tidak dikenal: ${route}`, code: 'not-found' });
  } catch (e) {
    if (e instanceof RemoteInputError) return send(res, e.status, { error: e.message, code: 'bad-request' });
    if (e instanceof RemoteAuthError) return send(res, e.status, { error: e.message, code: e.code });
    throw e;
  }
}
