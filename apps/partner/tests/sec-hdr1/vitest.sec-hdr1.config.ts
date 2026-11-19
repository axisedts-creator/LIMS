// SEC-HDR-1 test-only vitest config (tester-owned). Run from the repo root via .orchestra/notes/SEC-HDR-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const partner = fileURLToPath(new URL('../../', import.meta.url)); // apps/partner/

export default defineConfig({
  root: partner,
  resolve: { alias: { '@': `${partner}src` } },
  test: { include: ['tests/sec-hdr1/*.test.ts'], environment: 'node', testTimeout: 30000 },
});
