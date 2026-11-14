cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/analytics/service/__tests__/labels.service.test.ts src/modules/analytics/repository/__tests__/labels.repo.test.ts
