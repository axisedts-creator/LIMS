// C13.T05 test-only vitest config (tester-owned). Run from repo root via .orchestra/notes/C13.T05-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const partner = fileURLToPath(new URL('../../', import.meta.url)); // apps/partner/

export default defineConfig({
  root: partner,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${partner}src/` } },
  test: {
    include: ['tests/t05/*.test.{ts,tsx}'],
    environment: 'node', // components are rendered with react-dom/server (no jsdom in this package)
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
