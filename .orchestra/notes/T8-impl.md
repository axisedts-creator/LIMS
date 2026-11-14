# T8 impl (writer)
Files: service/session.service.ts (new: resolve/logout under one identityAuthTx, row lock via loadSession FOR UPDATE), handlers/resolveSession.ts, handlers/logoutSession.ts (new), handlers/index.ts (registered), repository/mfa.repo.ts (loadSession + state/last_seen_at/idle_timeout_minutes/membership locked_at/tenant status; touchSession, expireSession; patch lastSeenAt/idleExpiresAt; revoke reasons logout/refresh_failed), handlers/verifyMfaChallenge.ts (export sessionToken, gw - reuse only).
[CONV] order under lock: expiry (absolute wins) > locked/tenant 403 > refresh (<=120 s) > touch (>= LIMS_IDENTITY_TOUCH_INTERVAL_SECONDS, default 60). GoTrue refresh is called while holding the row lock (that is the serialisation).
[CONV] logout: unknown token 401; revoked/expired/vanished row 204 no-op; lapsed-but-active row revoked `logout`. Sign-out job key `signout:<user_id>:<reason>` (T7 convention).
[CONV] tokenReused (CR-C2-018) treated as unknown (401), no reuse-revoke: staff_web/partner tokens are not rotated (T31 owns rotation). mfa_pending etc. resolve 200 with their state/aal1.
[CONV] tenant status != 'active' -> identity.tenant_suspended; expiry reason only in the auth event (no column).
Tests: T8-verify.cmd 120/120 pass; identity suite all pass; tsc no errors in modules/identity.
Open: core boot/errors/health/openapi/http tests time out at 30 s (cold app boot ~43 s here) - not baselined against HEAD; eslint not installed in services/api. Not tested: real SQL of extended LOAD_SQL (pgTAP/live DB), RLS on core.tenants/memberships join under bindTenant.
