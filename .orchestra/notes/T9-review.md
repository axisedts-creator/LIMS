APPROVE
Range 2b023d77..ef95fd4a reviewed against 08 A38-1..A38-6, LD-99, 03-APP-FLOW s3.7, T9-ruling.md.
- Migration: both DEFINERs match A38-1(a)/(b) verbatim (names, signatures, return types, SET search_path = '', pre_user_id set/cleared, P0001 identity_platform_auth_write_invalid_input, state filter, no support_sessions touch); REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO lims_api; no policy change, no other migration line.
- mfa.repo.ts: platform branches call the DEFINERs with ::uuid casts; malformed result fails closed with common.internal; tenant path unchanged.
- setPasswordFromSetup.ts: no identity.gotrue_signout for platform (A38-2); tenant payload/job key unchanged; no absolute_expires_at key in patch (A38-3).
- Tests: pgTAP file covers every LD-99 tester item (revoke set, except id, reason guard, skip revoked/expired, other user/tenant untouched, PUBLIC/lims_api grants, direct UPDATE refused); API tests cover A38-1/2/3 + tenant unchanged. Ruling changes applied as directed (sentinel 11 code points; test-env.ts per setup-env.ts convention, synthetic value).
- No PHI/password in logs, no secrets, owned paths only (C0 migration under LD-99).
Ran: T9 verify vitest set -> 7 files, 117 passed, 5 skipped.
Not run (env, not a defect): pgTAP T9-A38 file (no LIMS_TEST_DB_URL); live GoTrue 60-min TTL leg (no LIMS_TEST_GOTRUE_*) — must be run before close.
