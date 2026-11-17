cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/anatomic/__tests__/intake.service.test.ts && pnpm --dir services/worker exec vitest run src/jobs/anatomic/__tests__
