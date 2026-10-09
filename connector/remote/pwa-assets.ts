import { readFileSync } from 'node:fs';

/**
 * The mobile PWA's files. In dev and tests they are read from connector/remote/pwa (and the app
 * icons); the desktop connector bundle has no source tree, so vite.connector.config.ts inlines the
 * same files at build time through the `__TLC_PWA_ASSETS__` define.
 */

export interface PwaAsset {
  type: string;
  /** base64 */
  body: string;
}

const FILES: Record<string, { file: string; type: string }> = {
  '/m/': { file: './pwa/index.html', type: 'text/html; charset=utf-8' },
  '/m/app.js': { file: './pwa/app.js', type: 'text/javascript; charset=utf-8' },
  '/m/app.css': { file: './pwa/app.css', type: 'text/css; charset=utf-8' },
  '/m/sw.js': { file: './pwa/sw.js', type: 'text/javascript; charset=utf-8' },
  '/m/manifest.webmanifest': { file: './pwa/manifest.webmanifest', type: 'application/manifest+json' },
  '/m/icon-512.png': { file: '../../src-tauri/icons/icon.png', type: 'image/png' },
  '/m/apple-touch-icon.png': { file: '../../src-tauri/icons/128x128@2x.png', type: 'image/png' },
};

/** Reads every asset relative to this module's source location. */
export function readPwaAssets(base: string | URL = import.meta.url): Record<string, PwaAsset> {
  return Object.fromEntries(Object.entries(FILES).map(([path, f]) => [path, { type: f.type, body: readFileSync(new URL(f.file, base)).toString('base64') }]));
}

declare const __TLC_PWA_ASSETS__: Record<string, PwaAsset> | undefined;

let cache: Map<string, { type: string; body: Buffer }> | null = null;

export function pwaAssets(): Map<string, { type: string; body: Buffer }> {
  if (!cache) {
    const raw = typeof __TLC_PWA_ASSETS__ !== 'undefined' ? __TLC_PWA_ASSETS__ : readPwaAssets();
    cache = new Map(Object.entries(raw).map(([p, a]) => [p, { type: a.type, body: Buffer.from(a.body, 'base64') }]));
  }
  return cache;
}
