import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DATA_DIR, PROFILE } from './paths.ts';

/**
 * Reads an environment variable from process.env, or directly from .env.local
 * (checking both project root and ~/.tech-lead-cockpit/.env.local).
 * This ensures credentials and base URLs are picked up even if the Node process
 * was started before the file was written, or if Vite didn't pass it into process.env.
 */
export function readEnvLocalVar(key: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const existing = env[key];
  if (existing && existing.trim()) return existing.trim();
  if (process.env.VITEST) return undefined;
  // A profile (npm run dev:fresh) starts like a fresh install: no .env files.
  if (PROFILE) return undefined;

  const candidates = [
    path.resolve(process.cwd(), '.env.local'),
    path.join(DATA_DIR, '.env.local'),
    path.resolve(process.cwd(), '.env'),
  ];

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const line of lines) {
          const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
          if (m && m[1] === key) {
            let val = (m[2] || '').trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (val) return val;
          }
        }
      }
    } catch {
      /* ignore file read errors */
    }
  }

  return undefined;
}
