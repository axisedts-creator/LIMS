cd /d "%~dp0..\.." && pnpm --dir services/worker exec vitest run src/jobs/engagement/__tests__/reconcile_links.test.ts
