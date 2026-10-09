/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { devConnector } from './connector/dev-connector.ts';

export default defineConfig(({ mode }) => {
  // A profile (npm run dev:fresh) starts like a fresh install: .env files are not read.
  const env = process.env.TLC_PROFILE ? (Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>) : loadEnv(mode, process.cwd(), '');
  for (const [k, v] of Object.entries(env)) {
    process.env[k] ??= v;
  }
  return {
    plugins: [svelte(), devConnector(env)],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    test: { environment: 'jsdom', include: ['src/**/*.test.ts', 'connector/**/*.test.ts'] },
  };
});
