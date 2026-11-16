# AUTH-MFA-PERSIST-1 tests (tester) - LD-248
Files: `services/api/src/modules/identity/handlers/__tests__/mfa.persist.test.ts` (14 tests, PASS now), `apps/web/src/features/admin/auth/__tests__/t12.mfa-409.test.tsx` + `t12.mfa-409.actions.test.ts` (11 tests, FAIL now: no `refreshSessionStateAction`, no `refreshAction`/`navigate` props).
Run: `.orchestra\notes\AUTH-MFA-PERSIST-1-verify.cmd` (api via the package, web via vitest.t12.config.ts). Only the 409 recovery is red; nothing in the API is red.

## Result 1: no TypeScript or SQL defect found in the persistence path
Per account type (platform-only, tenant with mfa_required role, platform row + tenant membership = tenant path) loginStaff -> startMfaEnrolment -> completeMfaEnrolment -> resolveSession active, then a SECOND loginStaff = `mfa_pending`, verifyMfaChallenge activates, a third login is `mfa_pending` again; one factor row, no re-enrolment, no `adminDeleteFactor`. Mutation check: matching NULL with `=` instead of IS NOT DISTINCT FROM turns the platform tests red.

## Result 2: how NULL tenant_id is matched, per query (read against the TypeScript)
| query | NULL match | platform-only user |
|---|---|---|
| `app.identity_login_context` (20261105000800 l.113) | `f.tenant_id IS NOT DISTINCT FROM v_one.tenant_id`; `pre_tenant_id` = '' when no membership | v_one NULL -> tenant-less factor found |
| policy `mfa_factors__select__owner_only` (20261105001300) | `tenant_id IS NOT DISTINCT FROM nullif(pre_tenant_id,'')::uuid` | same predicate, admits NULL |
| `app.identity_platform_auth_read_mfa_factors` (20261115156000) | `f.tenant_id IS NULL`, `pre_tenant_id` = '' | found; used by repo.factors(tenantId null) |
| `FACTORS_SQL` (mfa.repo.ts) | `tenant_id IS NOT DISTINCT FROM $1`, tenant branch only | not reached (null -> DEFINER) |
| `FACTOR_VERIFY_SQL` | `tenant_id = $1`, reached only when tenantId is non-null | null -> `identity_platform_auth_write_mfa_factor` (`f.tenant_id IS NULL`) |
| `identity_platform_auth_write_mfa_factor` | insert refuses non-NULL tenant; update `f.tenant_id IS NULL` | writes the row the login context reads |
A user with a platform row AND a tenant membership logs in on the tenant path and sees only tenant factors (by design, LD-248 FACT).

## Result 3: the live cause of "new authenticator every login" is not in the code
Characterisation test: GoTrue accepts the code, the mirror transaction rolls back (the 2026-11-15 `platform_events` RLS failure) -> the mirror row stays `unverified`, GoTrue holds it `verified`, the next login is `mfa_enrolment_required`, startMfaEnrolment deletes the GoTrue factor and enrols a NEW one. AUTH-MFA-COMPLETE-1 (migration 20261115157000 + a deploy) removes the failure. **No code change can repair a staging database that has not received that migration.** Founder steps: push-cloud.ps1, ONE deploy snapshot, sign in once (re-enrols cleanly), every later sign-in goes straight to the code step.

## Web 409 contract (writer must match or dispute)
`startMfaEnrolmentAction` already returns `{ok:false, code:'common.version_conflict'}` (test passes). New: server action `refreshSessionStateAction()` (POST session/resolve {touch:false}; returns only `{ok:true,state}`/`{ok:false,code}`, never the token) and optional props `refreshAction`, `navigate` on MfaEnrolment (page wires them). On 409: refresh once; `mfa_pending` -> navigate('/auth/mfa'); `active` -> '/'; otherwise (or refresh fails) one role=status line mentioning "authenticator" plus a "Sign in" link to /auth/login (a new login reaches the code step). My reading of "shows the code step": the code step is /auth/mfa; verifyMfaChallenge answers 409 for a session not in `mfa_pending`, so a stale `mfa_enrolment_required` session needs a fresh login.

## Not verified
The SQL running against Postgres (pgTAP cannot run in the lane); live GoTrue; the staging database state.
