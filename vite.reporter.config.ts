import { defineConfig } from 'vite';

/**
 * Bundles the scheduled progress reporter (reporter/tad-progress.ts) into one ESM file that runs
 * on plain `node` on the VPS, next to Hermes. It shares the report builder with the app.
 */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'reporter/tad-progress.ts',
    outDir: 'dist-reporter',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: { entryFileNames: 'tad-progress.mjs', codeSplitting: false },
    },
  },
  ssr: { target: 'node', noExternal: true },
});
