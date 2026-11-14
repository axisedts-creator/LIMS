// C13.T20 test-only vitest config (tester-owned). Run from repo root via .orchestra/notes/C13.T20-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const partner = fileURLToPath(new URL('../../', import.meta.url)); // apps/partner/

export default defineConfig({
  root: partner,
  resolve: { alias: { '@': `${partner}src` } }, // layout.tsx imports '@/core/pwa'
  test: { include: ['tests/t20/*.test.ts'], environment: 'node', testTimeout: 30000 },
});
