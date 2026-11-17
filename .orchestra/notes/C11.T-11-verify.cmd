cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/anatomic/__tests__/config.handlers.test.ts src/modules/anatomic/__tests__/integration/config.live.test.ts
