cd /d "%~dp0..\.." && pnpm --dir services/renderer exec vitest run src/templates/__tests__ && pnpm --dir services/api exec vitest run src/modules/reporting/domain/__tests__/templates.test.ts
