cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/analytics/__tests__/ops && pnpm exec vitest run --root services/worker src/jobs/analytics/__tests__/observability.test.ts
