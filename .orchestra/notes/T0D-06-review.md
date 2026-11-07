APPROVE

Round 2. Both round-1 items fixed:
1. `services/api/src/core/ratelimit/pg.ts:18` — counter now `hit(keyHash, limit * ttlSeconds + 1, limit)`; previous-window weight stays > 1 - 1/limit for one TTL, so `otp_verify` on pg can no longer exceed 5 attempts per 600 s OTP lifetime.
2. `services/api/src/core/ratelimit/__tests__/backends.test.ts:98` — boundary-burst case added for counter tier on pg, sweeping first-burst offset 0..3050 s across the 3001 s window, asserting 5+10 attempts 540 s apart total ≤ 5 (alignment-independent).

Rest unchanged from round 1 (tier limits/keys verbatim, fail-open only `general`, 503 `common.dependency_unavailable` otherwise, 429 `common.rate_limited` + Retry-After, HMAC'd keys, no PHI/secrets, owned paths only, RLS N/A).
Verify cmd: 50 passed / 4 skipped (live Redis, env-gated).
Note (not a defect): pg `otp_verify` Retry-After can now exceed the OTP lifetime (up to ~3001 s); OTP expires first, so harmless.
