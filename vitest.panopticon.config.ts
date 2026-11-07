/// <reference types="vitest" />
// Panopticon fork tests (packages/*/test/**/*.panopticon.test.ts style
// files listed below) run against SOURCE, in jsdom, without building the
// monorepo: `npx vitest run --config vitest.panopticon.config.ts`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) =>
  fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

export default defineConfig({
  // @rrweb/types declares `export const enum`s; vite transforms one file at a
  // time, so keep the enum objects instead of erasing them.
  esbuild: { tsconfigRaw: { compilerOptions: { preserveConstEnums: true } } },
  resolve: {
    alias: {
      'rrweb-snapshot': src('rrweb-snapshot/src/index.ts'),
      '@rrweb/types': src('types/src/index.ts'),
      '@rrweb/utils': src('utils/src/index.ts'),
      rrdom: src('rrdom/src/index.ts'),
      'rrweb-worker': src('rrweb-worker/src/index.ts'),
    },
  },
  test: {
    // inline project: keeps the monorepo's vitest.workspace.ts (whose
    // projects resolve packages through their built dist) out of this run
    projects: [{ extends: true, test: { name: 'panopticon' } }],
    environment: 'jsdom',
    environmentOptions: { jsdom: { pretendToBeVisual: true } },
    setupFiles: ['./test-panopticon.setup.ts'],
    pool: 'forks',
    include: [
      'packages/rrweb/test/record/cross-origin-flag.test.ts',
      'packages/rrweb/test/record/raf-coalesce.test.ts',
      'packages/rrweb/test/record/sliced-snapshot.test.ts',
      'packages/rrweb-snapshot/test/snapshot-sliced.test.ts',
    ],
  },
});
