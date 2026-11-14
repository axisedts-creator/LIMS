cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/quality/__tests__/plan src/modules/quality/__tests__/boot.test.ts
