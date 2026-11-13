cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/identity/__tests__/role-packs/matrix-replay.test.ts src/modules/identity/__tests__/role-packs/route-guard.test.ts
