# T-A3 impl (writer)
Files: `service/auth.service.ts` (+`verifyOtp`), `handlers/auth.handlers.ts` (+`verifyPatientOtp`), NEW `repository/accounts.repo.ts`, `repository/otp.repo.ts` (+`loadForVerify`, `recordMismatch`, `markVerified`).
[CONV] LD-140 UI-only, n/a. Mismatch: attempts/status + `auth.otp_failure` + `commitOnError()` + 401; expired/non-pending/missing = 401 `auth.otp_invalid`, no write (metric `expired` vs `invalid` only).
[CONV] Match: challenge -> verified+consumed FIRST (PRE_ACC), then live account by phone or INSERT id = challenge id; provision only if no membership_id; one `recordLogin` UPDATE. Any error after match -> bare `common.internal`, no commitOnError.
Tests: auth.verify 35/35; engagement dir 1050 pass, 1 fail = boot.test PHASE_STUBS expects ['QualityPort'] but gets [] (core phase-stubs.ts, not touched here).
Open: two concurrent verifies of one new phone can hit the accounts unique index -> 500, retry works. C2 fake tokens are not 43 chars (tester's note). pgTAP `T-A3_pre_acc.test.sql` not run (no live DB). No timing/last_app_version.
