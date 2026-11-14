// C13.T18 test-only vitest config (tester-owned). Run from repo root via .orchestra/notes/C13.T18-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const partner = fileURLToPath(new URL('../../', import.meta.url)); // apps/partner/

export default defineConfig({
  root: partner,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${partner}src/` } },
  test: { include: ['tests/t18/*.test.{ts,tsx}'], environment: 'node', restoreMocks: true, testTimeout: 180000, hookTimeout: 60000 /* first render cold-compiles @lims/ui + react-aria */ },
});
