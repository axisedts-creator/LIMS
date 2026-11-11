APPROVE

PG-T01 review (diff 2cab7725..bc290272).

Checked against 06-PLAN row PG-T01, 02-TRD §9.1/§9.3/§8.3 (systemPermissions), 01-PRD US-PG-15, contracts/errors.yaml, contracts/permissions.yaml, core/auth/resolvers.ts.
- §9.3 boot rules all enforced in `config.ts` and each has a unit test: KEK missing/unparseable/active != 32 bytes; production + `uat.esewa.com.np`/`dev.khalti.com` host; uat + production host; `ESEWA_FORM_URL` empty (uat); `PUBLIC_BASE_URL` not https. Host compare uses URL.hostname, not a substring. Import-time boot failure tested in API and worker.
- AC-PG-15.1 / AC-PG-15.2 covered (positive + negative cases). §9.1 defaults match verbatim.
- Manifest: produces `payments.intent.settled.v1`; one port `PaymentProviderPort`; resolver `paymentCallback` returns undefined, so core throws auth.unauthenticated (fail closed); `systemPermissions: []` matches TRD §8.3 / CR-C15-005.
- Port impl rejects `payments.gateway_not_available` (errors.yaml, owner C15) for every method; `phase1Stub` contract subset passes. Handler placeholders use `common.service_unavailable` (errors.yaml, C0); handler set equals the payments.yaml operationIds (test).
- Permissions are the 7 codes from permissions.yaml, verbatim.
- `phase-stubs.ts` edit is the paired C0-0D change the brief authorises (P-20).
- No SQL in this task, so no RLS checks. No secrets: test KEKs are random bytes in tmpdir. Errors never echo KEK content (tested). Nothing logged.
- LD-26: the C2 port does not expose a training-mode flag, so this is correctly deferred via CR-C15-011 (non-blocking for the skeleton). The merchant-account task must close it.

Runs (reviewer):
- api `vitest run src/modules/payments src/core/ports/__tests__/phase-stubs.test.ts`: 522 passed, 17 skipped.
- tsc --noEmit on api and worker: no errors in payments or phase-stubs files.
- Full worker suite: 62 tests fail in 20 files, none of them payments. Causes: catalog xlsx tests (missing `@lims/shared-ts/spreadsheet`), live tests with no DB, and 5 s timeouts in the frontdesk/reporting/identity/instruments suites. None of these failures mention LIMS_PAYMENTS. I did not run them on the base commit to prove they were there before this change.

Non-blocking note: in production an empty `LIMS_PAYMENTS_ESEWA_FORM_URL=""` falls back to the documented production default instead of failing. This is acceptable under §9.1 (production has a default).
