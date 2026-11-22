// T0D-BUILD-5 test-only vitest config (tester-owned). Run from the repo root via .orchestra/notes/T0D-BUILD-5-verify.cmd:
//   pnpm --dir apps/web exec vitest run --config src/features/quality/__tests__/vitest.t0dbuild5.config.ts
// Runs this task's t0dbuild5.* files plus the auto-verification overview file whose "5xx" case this task changes (LD-455: a failure is shown in its section).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/quality/__tests__/t0dbuild5.*.test.{ts,tsx}',
      'src/app/**/quality/autoverify/__tests__/av-t23.overview.test.tsx', // no literal "(staff)": parentheses are glob syntax
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
