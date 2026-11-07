cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/reporting/__tests__ && pnpm exec vitest run --root services/worker src/jobs/reporting/__tests__
