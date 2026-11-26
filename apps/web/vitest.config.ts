// One config for every web test (CI job `ui`, turbo task test:ui). Same settings the per-task tester configs used:
// '@/': src alias, node by default (a component test opts in with `// @vitest-environment jsdom`).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('./', import.meta.url));

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 20000,
  },
});
