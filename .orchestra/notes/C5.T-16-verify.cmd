cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/lab/service/__tests__/result.service.verify.test.ts src/modules/lab/handlers/__tests__/verify.handlers.test.ts
