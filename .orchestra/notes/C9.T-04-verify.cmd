cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/quality/domain/__tests__/assembly.test.ts src/modules/quality/domain/__tests__/run.state.test.ts
