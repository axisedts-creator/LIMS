Title: CR-C17-HC-T30-C00A: nightly wiring + compose seed for the C17 E2E scenario (02-TRD §15 "E2E nightly")
From chunk: C17
To owner: C0-0A
Type: shared-lib
Blocking? yes - HC-T30 done_when "TRD 15 scenario green on compose stack" cannot be met from C17-owned paths.
Problem: the scenario `apps/web/src/features/homecollection/tests/e2e/HC-T30.nightly.spec.ts` (+ `playwright.config.ts`) exists, but
  (1) `@playwright/test` is not installed in the workspace (`pnpm exec playwright` -> "Command \"playwright\" not found");
  (2) there is no `test:e2e` script in apps/web/package.json and no nightly workflow job running it;
  (3) the compose stack (API + C4/C5/C16 seed) is not provided; locally only the Supabase containers run, so the LIMS_E2E_* env the spec needs is unset and it skips.
  Serves DoD-3.8 / DoD-5 (02-TRD §15 E2E nightly, Device row).
Proposed change (exact):
  - root devDependency `@playwright/test` (version per C0-0A pin policy) + `pnpm exec playwright install chromium` in the nightly job.
  - nightly job (linux): bring up the compose stack, run the compose seed, export LIMS_E2E_API_URL, LIMS_E2E_STAFF_TOKEN, LIMS_E2E_BOOKING_VISIT_ID,
    LIMS_E2E_PHLEBO_MEMBERSHIP_ID, LIMS_E2E_DEVICE_TOKEN, LIMS_E2E_DEVICE_ID, LIMS_E2E_RECEIVING_CENTRE_ID, LIMS_E2E_RECEIVER_TOKEN,
    LIMS_E2E_PAYMENT_METHOD_CODE (meanings in the spec header), then `pnpm exec playwright test --config apps/web/src/features/homecollection/tests/e2e/playwright.config.ts`.
    The job must FAIL (not skip) when any LIMS_E2E_* var is empty.
  - same job, Android emulator step: `flutter test integration_test/hc_t30_offline_visit_test.dart` in apps/phlebo_app.
Backward compatible? yes (additive dev dependency and job).
Tenant/security impact: none; synthetic seed only, tokens are CI secrets never committed. Exercises REQ-SEC-103 (encrypted stores) on device.
Alternatives considered: adding the script/workflow from C17 (paths not owned by C17, 01-CHUNK-MAP §3).
Tests that will prove it: the first nightly run of the job - Playwright scenario passes (not skipped) and the Dart integration_test passes on the emulator.
