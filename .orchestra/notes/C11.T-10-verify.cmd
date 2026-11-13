cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/anatomic/__tests__/images && pnpm --dir services/worker exec vitest run src/jobs/anatomic/__tests__/process_image.test.ts
