# C6-T01 tests (tester)
Paths per TRD §3.2/§3.3: `modules/reporting` = services/api/src/modules/reporting, `jobs/reporting` = services/worker/src/jobs/reporting.
- services/api/src/modules/reporting/__tests__/config.test.ts — `loadReportingConfig(env)`: OTP TTL<=600, attempts=5, ALLOW_REAL_PROVIDERS (true only in prod, required there), key file >=32 B, defaults, junk ints.
- services/api/src/modules/reporting/__tests__/manifest.test.ts — `manifest` (validateManifest, produces, systemPermissions, portalSession), `REPORTING_PERMISSIONS` (20 IC §11 codes), every operationId stub -> 501, no input echo.
- services/worker/src/jobs/reporting/__tests__/manifest.test.ts — worker `manifest` passes validateManifests, per_tenant crons.
- services/api/src/core/__tests__/boot.test.ts — LEAD AUTO 2026-11-07T19:17:46: 5 sample-module bootstrap() cases (lines 146,161) add `modulesDir: fixturesShared() + '/does-not-exist'`; assertions unchanged. 22/22 pass.
Run: `.orchestra\notes\C6-T01-verify.cmd`. Assumption: "production" = LIMS_CORE_ENV=production (tests also set NODE_ENV).
