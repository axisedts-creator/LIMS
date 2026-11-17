// BL-T20 test-only vitest config (tester-owned). Same shape as WEB-T02's. Run from repo root via .orchestra/notes/BL-T20-verify.cmd.
// Needs apps/web devDependencies (WEB-T02 writer adds them): vitest, msw, jsdom, axe-core, @testing-library/react, @testing-library/user-event.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/billing/__tests__/bl-t20.*.test.{ts,tsx}'],
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 15000,
  },
});
