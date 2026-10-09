import http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { connectorMiddleware } from './dev-connector.ts';
import { CONFLUENCE_SERVICE, readKeychain } from './keychain.ts';
import { appendAudit, readAudit } from './audit.ts';
import { shutdownRemote } from './remote/manager.ts';

const APP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'tauri.localhost']);

function isAppOrigin(origin: string): boolean {
  try {
    return APP_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Reads .env.local from the working directory (the desktop app runs the connector in ~/.tech-lead-cockpit). */
function loadLocalEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  const envFile = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        env[key] = val;
      }
    }
  }
  return env;
}

export function startStandaloneServer(port = 5174): http.Server {
  const env = loadLocalEnv();
  const deps = {
    readToken: () => readKeychain(CONFLUENCE_SERVICE),
    appendAudit,
    readAudit,
    logError: (msg: string) => console.error('[connector]', msg),
  };

  const middleware = connectorMiddleware(env, deps);

  const server = http.createServer((req, res) => {
    // CORS only for the app itself (tauri://localhost on macOS); other sites get no CORS headers.
    const origin = req.headers.origin;
    if (origin && isAppOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TLC-Client');
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    middleware(req, res, () => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Endpoint not found', code: 'not-found' }));
    });
  });

  // Remote Access lives and dies with the connector; it is never resumed on start.
  server.on('close', () => void shutdownRemote('connector-stop'));

  server.listen(port, '127.0.0.1', () => {
    console.log(`[connector] Standalone server running at http://127.0.0.1:${port}`);
    // Only once the port is ours: a second copy must not open another WhatsApp socket.
    if (process.env.TLC_NO_WA_RESUME === '1') return;
    import('./whatsapp/session.ts')
      .then((m) => m.resumeWhatsAppIfLinked())
      .catch((e) => console.error('[whatsapp]', e.message));
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('standalone-server.ts')) {
  const port = Number(process.env.CONNECTOR_PORT || 5174);
  startStandaloneServer(port);
}
