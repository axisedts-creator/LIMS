cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/quality/__tests__/autoverify src/core/__tests__/errors.test.ts
