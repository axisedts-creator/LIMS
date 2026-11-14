cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/core/observability/__tests__ src/core/__tests__/health.test.ts
