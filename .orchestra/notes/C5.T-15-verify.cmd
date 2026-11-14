cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/lab/service/__tests__/critical.service.test.ts src/modules/lab/handlers/__tests__/critical.handlers.test.ts
