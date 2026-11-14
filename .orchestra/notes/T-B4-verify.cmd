cd /d "%~dp0..\.." && pnpm --dir services/worker exec vitest run src/jobs/engagement/__tests__/booking_jobs.test.ts
