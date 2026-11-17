APPROVE
Reviewer T7 round 2 (diff 50f4444d..HEAD; fixes 12f38885..46aab0b8). Ran T7-verify set: 147 pass / 5 skipped (live GoTrue leg not run).
Prior items resolved:
1. Rate tier `login`: `MfaDeps.limits` now includes `consumeAttempt`; `mfaOperation` calls `consumeAttempt(hmac(email))` before any GoTrue call/write (verifyMfaChallenge.ts:123); production wiring uses `createAuthLimits` (implements it). Tests: 429 + Retry-After, no GoTrue call, nothing written, for all three ops.
2. Re-enrol lockout: GoTrue 404 on `adminDeleteFactor` treated as removed (startMfaEnrolment.ts:22-24); test covers mirror row marked `re_enrol` and enrolment success.
3. completeMfaEnrolment wrong-state now 404 `common.not_found` (on-contract); test updated, asserts no GoTrue call.
Open (non-blocking, lead): CR-C2-T7-a (.orchestra/cr/T7.nonblocking.md).
