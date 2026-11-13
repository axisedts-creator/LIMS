cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/identity/__tests__/role-packs/role-pack.service.test.ts src/modules/identity/__tests__/role-packs/apply-role-pack.cli.test.ts
