# T9 impl (writer)
Files: handlers/{requestPasswordRecovery,confirmEmailToken,setPasswordFromSetup}.ts (new), handlers/index.ts (registered), repository/mfa.repo.ts (+loginContext/insertSession/insertPlatformSession delegates, revokeOtherSessions, acceptInvitation), handlers/verifyMfaChallenge.ts (export envHmac), worker jobs/identity/tasks/send_recovery.ts (new; not registered: no identity worker manifest exists yet).
[CONV] confirm: usable account = 1 membership, tenant active, not locked, status active|invited; else the same type-specific 400. Non-staff_web BFF -> same 400.
[CONV] setPassword: non-password_setup state -> 409 common.version_conflict; consumes login tier a:<hmac>; keeps 15-min expiry; per-session signout job payload {user_id, tenant_id, session_id} (platform {user_id}).
[CONV] request: limiter before the tx; 429 writes nothing.
Open: 2 tests disputed (.orchestra/notes/T9-dispute.md); platform revoke/accept gaps (.orchestra/cr/T9.md); live GoTrue leg not run (no env).
Checks: 99/101 T9 API tests, 19/19 worker, identity module 2468 pass / 2 fail (the disputed ones); tsc clean on changed files.
