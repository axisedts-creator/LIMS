cd /d "%~dp0..\.." && pnpm exec vitest run --root services/worker src/jobs/micro/__tests__/unit src/jobs/micro/__tests__/integration src/jobs/micro/__tests__/helpers
