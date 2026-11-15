// WEB-STYLE-3 test-only vitest config (tester-owned; same shape as vitest.web-style-2.config.ts).
// Runs web-style-3.test.ts plus web-style (STYLE-1), web-style-2, build-config and build-boundaries (must stay green).
// Run via .orchestra/notes/WEB-STYLE-3-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/__tests__/web-style-3.test.ts',
      'src/__tests__/web-style-2.test.ts',
      'src/__tests__/web-style.test.ts',
      'src/__tests__/build-config.test.ts',
      'src/__tests__/build-boundaries.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
  },
});
