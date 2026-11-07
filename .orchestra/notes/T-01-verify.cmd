cd /d "%~dp0..\.." && pnpm --filter @lims/api exec vitest run src/core/__tests__/boot.test.ts src/modules/catalog/__tests__/unit
