APPROVE

T8 review (reviewer), diff 064f6fba..HEAD.
- Names verbatim: resolveSession/logoutSession, `touch`, ResolvedSession fields, auth.session_expired / auth.account_locked / identity.tenant_suspended / common.dependency_unavailable, revoke reasons `logout`/`refresh_failed`, events `session_expired_idle|_absolute`, `refresh_failed`, `logout`, job `identity.gotrue_signout`, env LIMS_IDENTITY_TOUCH_INTERVAL_SECONDS (02-TRD s11 table) all found in spec.
- done_when: refresh decided and GoTrue called under `loadSession ... FOR UPDATE OF s` (02-TRD s4.7); ctl.noRetry() prevents replaying a rotated refresh token; touch only when touch=true and now-last_seen_at >= 60 s (03-APP-FLOW s3.5.1).
- Tenancy: session from DEFINER app.identity_session_by_token(sha256); bindTenant(session.tenant_id) for tenant kinds (D-212); no tenant taken from request. No DDL/RLS changes in this task.
- LD-81: patient/staff_mobile excluded via KINDS_FOR_KEY (no GoTrue refresh for patient kind) — cited in service header.
- P-42: expiry / refresh_failed writes kept through the 401 (commitOnError + error returned out of tx).
- No PHI/secrets logged; tokens only hashed / sealed. Paths: all under services/api/src/modules/identity (C2-owned); mfa.repo.ts / verifyMfaChallenge.ts edits are C2 files (export + extra columns), acceptable.
- Tests: ran T8-verify set, 120/120 pass (109 s). Cover AC-A4.1-3 (injected clock, background flag), AC-A5.1, parallel resolves -> one refresh/touch.
Non-blocking notes: (a) a non-LimsError thrown by gotrue.refresh is treated as an outage (falls through) — fine if the gateway always wraps; (b) live-DB check of extended LOAD_SQL joins (core.memberships/core.tenants under bindTenant RLS) not done — pgTAP/integration owner should cover; (c) spec-gap items in T8-tests.md (logout repeat = 204, mfa_pending resolve) are [CONV], CR if lead disagrees.
