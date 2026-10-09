/**
 * Entry point of the connector bundled into the macOS app (see vite.connector.config.ts).
 * The Tauri shell starts it with the user's Node and keeps its stdin open; when the app quits
 * or crashes, stdin closes and the connector exits instead of lingering on the port.
 */
import { startStandaloneServer } from './standalone-server.ts';

process.env.TLC_RUNTIME ??= 'desktop';
const port = Number(process.env.CONNECTOR_PORT || 5174);
const server = startStandaloneServer(port);

server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(`[connector] ${e.code === 'EADDRINUSE' ? `Port ${port} sudah dipakai proses lain.` : e.message}`);
  process.exit(1);
});

const shutdown = () => process.exit(0);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (process.env.TLC_EXIT_WITH_STDIN === '1') {
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}
