# T7 impl (writer)
Files: handlers/{verifyMfaChallenge,startMfaEnrolment,completeMfaEnrolment}.ts, repository/mfa.repo.ts (new), handlers/index.ts (3 ops registered).
[CONV] shared plumbing (mfaOperation envelope, failCode, checkCode, activate, wire) lives in verifyMfaChallenge.ts; no service file (plan lists none).
[CONV] P-42 like loginStaff: wrong code -> attempts+1, account failure (createAuthLimits, hmac(email)), mfa_challenge_failed; 5th -> revoke mfa_failed + session_revoked + identity.gotrue_signout; commitOnError, err returned out of tx.
[CONV] multiple verified factors -> newest verified challenged; none -> 409; tokenReused token -> 401 session_expired (reuse revoke left to resolveSession); idle/absolute expiry -> 401.
[CONV] account failures cleared on login_succeeded; complete on voluntary (active) enrolment writes mfa_enrolled only; platform_mfa_enrolled detail = {factor_id}.
Review fixes: consumeAttempt(hmac(email)) in mfaOperation (login tier, 429 pre-GoTrue); startMfaEnrolment GoTrue 404 on delete = already removed; completeMfaEnrolment bad state -> 404 not_found. identity module 2249 pass / 67 skipped; tsc 25 pre-existing.
Tests: T7-verify set 142 pass / 5 skipped (live GoTrue leg, env not set); identity module 2244 pass. tsc: 25 errors, all pre-existing in contracts/ports, none in T7 files. No eslint installed.
Open: CR .orchestra/cr/T7.md (platform pre-auth RLS for loadSession/factors/platform_events; session read not via DEFINER). Not handled: expired GoTrue access token (no refresh -> 503); GoTrue factor orphaned if tx fails after mfaEnrollTotp.
