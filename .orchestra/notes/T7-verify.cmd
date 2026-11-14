cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/identity/handlers/__tests__ src/modules/identity/repository/__tests__/mfa.repo.test.ts
