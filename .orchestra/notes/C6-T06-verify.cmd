cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/reporting/domain/__tests__/document.test.ts src/modules/reporting/__tests__/assembly.service.test.ts
