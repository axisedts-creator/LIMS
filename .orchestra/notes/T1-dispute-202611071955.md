# T1 dispute (writer, 2026-11-07)
Live run vs pinned v2.197.0 (temp same-image container): 36/38 pass. Two tests assume behaviour the real container does not have; so `Live contract run: PASS` cannot be truthfully written and mapping.test "passing live contract run" fails.

1. contract.suite.ts:91 "reuse of a rotated-out token … → reused, and the family dies" — wrong for the pinned version.
   Live: reusing t0 after ONE rotation (t0→t1) past the 10 s interval → 200 (GoTrue re-accepts the parent of the active token by design). Reusing t0 after TWO rotations → 400 `refresh_token_already_used` (gateway maps to `reused`), but t2 still refreshes (no family revocation).
   Ask: rotate twice before reuse; make "family dies" conditional on mapping verdict REFRESH_REUSE (REFUTED, CR `.orchestra/cr/T1.md` b), like the TTL test.
2. http.live.test.ts:37 `ageEmailTokens` ages `auth.one_time_tokens.created_at`; GoTrue measures `GOTRUE_MAILER_OTP_EXP` from `auth.users.recovery_sent_at` (invite: `confirmation_sent_at`/`invited_at`). Probe: ageing `recovery_sent_at` by 3601 s → 403 `otp_expired`; ageing only `one_time_tokens` → still 200.
   Ask: `update auth.users set recovery_sent_at = recovery_sent_at - interval 'N seconds', confirmation_sent_at = confirmation_sent_at - interval 'N seconds', invited_at = invited_at - interval 'N seconds'` (plus the existing one_time_tokens update).
3. Minor: http.live.test.ts calls `describeGatewayContract(…, liveHarness)` → `make()` runs at collection even when skipped, so `createHttpGoTrueGateway({url: undefined})` ran; gateway made tolerant (no test change needed).
Fake follows the suite as written (strict reuse + family revoke), so it is stricter than real GoTrue until 1 is ruled.
