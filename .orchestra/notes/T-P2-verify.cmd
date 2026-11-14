cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/engagement/service/__tests__/orders.handlers.test.ts && cd apps\patient_app && flutter test test/features/orders
