cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/lab/__tests__ && pnpm exec vitest run --root services/worker src/jobs/lab/__tests__
