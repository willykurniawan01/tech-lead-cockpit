/**
 * Resolves API endpoint URL depending on environment.
 * - In browser (Vite dev server): relative path '' works via Vite devConnector.
 * - In Tauri desktop app (production bundle): connects to local standalone connector on port 5174.
 */
export function api(path: string): string {
  if (typeof window === 'undefined') return path;
  // There is no Vite dev server proxying endpoints, so requests go to the standalone connector on port 5174.
  return `${isDesktopBundle() ? 'http://127.0.0.1:5174' : ''}${path}`;
}

/** Packaged Tauri app: the origin is tauri://localhost (macOS) or http://tauri.localhost (Windows). */
export function isDesktopBundle(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.protocol === 'tauri:' || window.location.protocol === 'asset:' || window.location.hostname === 'tauri.localhost';
}

/** Shown when the connector can't be reached; what to do differs between the browser and the Mac app. */
export function connectorDownMessage(): string {
  return isDesktopBundle()
    ? 'Connector aplikasi belum berjalan. Tutup lalu buka ulang Tech Lead Cockpit; detailnya ada di ~/.tech-lead-cockpit/logs/connector.log.'
    : 'Connector lokal tidak berjalan. Jalankan "npm run dev".';
}
