cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/identity/service/__tests__/ird.service.test.ts src/modules/identity/service/__tests__/ird.readiness.test.ts
