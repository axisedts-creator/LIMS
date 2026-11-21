# SEC-ENV-1 tests (tester)
Seam assumed: `isProductionEnv(env)` exported from services/api/src/core/config.ts (true if LIMS_CORE_ENV or NODE_ENV is exactly `production`); the 4 sites use it. Payments key is `LIMS_PAYMENTS_GATEWAY_ENV`.
- services/api/src/core/__tests__/production-env.test.ts (helper table, loadConfig responseValidation table, static "no direct NODE_ENV compare" for the 3 other sites)
- services/api/src/modules/reporting/__tests__/callbacks-prod-env.test.ts (callbackAdapter table)
- services/api/src/modules/payments/__tests__/unit/config-prod-env.test.ts (LIMS_CORE_ENV x NODE_ENV x GATEWAY_ENV; production boot refuses unless GATEWAY_ENV=production)
- services/worker/src/jobs/reporting/__tests__/send_delivery.prod-env.test.ts (worker provider choice table; recording unreachable in production; agrees with the API helper)
Run: `.orchestra\notes\SEC-ENV-1-verify.cmd` (api via `pnpm --dir services/api exec vitest run ...`, then worker via `pnpm --dir services/worker exec vitest run ...`).
Now: 48 api + 7 worker tests fail (right reason: helper missing / LIMS_CORE_ENV=production ignored); staging and NODE_ENV=production cells pass (unchanged behaviour).
Not covered: `.env.example` comment (file unreadable to the tester session); boot-level (full real-modules) refusal, covered at loadPaymentsConfig level only.
