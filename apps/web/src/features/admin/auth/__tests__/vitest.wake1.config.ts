// T0D-WAKE-1 test-only vitest config (tester-owned). Run from the repo root via .orchestra/notes/T0D-WAKE-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/core/session/__tests__/wake1.*.test.ts',
      'src/__tests__/wake1.*.test.ts',
      'src/features/admin/auth/__tests__/wake1.*.test.{ts,tsx}',
    ],
    environment: 'node', // wake1.component opts in to jsdom
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
