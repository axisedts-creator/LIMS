REM C3 T-01
cd /d "%~dp0..\.." && pnpm --filter @lims/api exec vitest run src/core/__tests__/boot.test.ts src/core/__tests__/errors.test.ts src/core/__tests__/health.test.ts src/core/__tests__/openapi.test.ts src/core/observability/__tests__/http.test.ts src/modules/catalog/__tests__/unit || exit /b 1
REM C5 T-01
cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/lab/__tests__ && pnpm exec vitest run --root services/worker src/jobs/lab/__tests__
