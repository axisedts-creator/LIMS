Title: CR-C0-T0B-REVIEW-1-003: identity.mfa_factors tenant-less row visible to platform aal1 / non-platform-scope claims (LD-232 item 4; C2_policies tests 63 and 72)
From chunk: C0 (lane C0-0B, T0B-REVIEW-1)            To owner: C0-0B (lead; founder yes needed, policy change)
Type: security (narrowing)
Blocking? no (LD-232: report only; no migration, policy, grant, test or code was changed)

## Intent
- C2 05-SCHEMA §11 test 3: `__platform` policies are false when claims `aal = 'aal1'`, when `platform_staff_id` is inactive, or when `scope` ≠ `platform`.
- C2 05-SCHEMA §5.3 (08 A28.1): platform rows after login (tenant_id IS NULL) are read and written through `mfa_factors__select__platform` / `__insert__platform` / `__update__platform` (`tenant_id IS NULL AND app.is_platform_actor()`, which requires scope platform AND aal2 AND an active platform_staff row).
- C2 05-SCHEMA §5.4 (08 A15.2, A28.1) and LD-216: before aal2 a platform user's tenant-less factors are reached only through the owner DEFINERs (`mfa_factors__select__owner_only`, `app.identity_platform_auth_read_mfa_factors`, `app.identity_platform_auth_write_mfa_factor`).
- C2 05-SCHEMA §5 `mfa_factors__select__own` comment: "user's own factors, tenant or tenant-less; partner self-service"; C2 07-SECURITY REQ-SEC-011–016: partner access only through `__own`. The tenant-less half of `__own` contradicts §11 test 3 and the A28.1 / A15.2 design; LD-232 asks which is intended.

## Current behaviour
- `mfa_factors__select__tenant` (db/policies/identity.sql:11, `tenant_id = current tenant AND is_staff_or_system()`) is false for a NULL tenant and `mfa_factors__select__platform` (line 115) is false at aal1 / scope ≠ platform, so neither admits the row; the leak is `__own` only.
- `mfa_factors__select__own` / `__insert__own` / `__update__own` (db/policies/identity.sql:103, :105, :107): `user_id = app.current_actor_id() AND tenant_id IS NOT DISTINCT FROM app.current_tenant_id()`. With claims that carry no tenant_id, `NULL IS NOT DISTINCT FROM NULL` is true, so any claims whose `sub` is the platform user see (and can insert / update) that user's tenant-less factor, whatever `aal` or `scope` says.
- db/tests/identity/T0B-10.C2_policies.test.sql tests 63 (`cplat('aal1','platform',…)`, line 151) and 72 (`cplat('aal2','tenant',…)`, line 153) expect 0 rows from identity.mfa_factors and get 1: fixture row uid(35) (tenant_id NULL, user_id uid(101) = the claims `sub`) passes `__own`, not `__platform`.
- Impact: a platform staff token at aal1 (password only, MFA not yet passed) can read its own factor metadata and, through `__update__own`, change its own tenant-less factor row (e.g. status) without the DEFINER path; that bypasses the A28.1 "only through app.identity_platform_auth_write_*" rule (C2 07-SECURITY AU-T24).

## Callers
- Tenant factors (tenant_id = claims tenant, unaffected by the proposal): services/api/src/modules/identity/repository/mfa.repo.ts:57 (FACTORS_SQL, used with a tenant at line 210), services/api/src/modules/identity/repository/mfa.repo.ts:218 (insert, tenant only), services/api/src/modules/identity/repository/mfa.repo.ts:227 (verify, tenant only), services/api/src/modules/identity/repository/self.repo.ts:52, services/worker/src/jobs/identity/tasks/remove_mfa_factors.ts:37.
- Tenant-less factors before aal2: DEFINERs only, services/api/src/modules/identity/repository/mfa.repo.ts:210 (PLATFORM_FACTORS_DEFINER when tenantId is null), services/api/src/modules/identity/repository/mfa.repo.ts:223 and services/api/src/modules/identity/repository/mfa.repo.ts:234 (FACTOR_DEFINER).
- Tenant-less factors after aal2: services/api/src/modules/identity/repository/platform-staff.repo.ts:83 (admin reset, platform actor, covered by `mfa_factors__update__platform`).
- No lims_app path needs the tenant-less half of `__own`. Policies: db/policies/identity.sql:103, db/policies/identity.sql:115, db/policies/identity.sql:167.

## Proposal
Drop the tenant-less branch of `__own` (tenant-less rows stay reachable through `__platform` after aal2 and through the owner DEFINERs before it). Additive migration plus the same text in db/policies/identity.sql:
```sql
-- LD-232 item 4 (CR-C0-T0B-REVIEW-1-003): __own covers tenant rows only; tenant-less rows only via __platform (aal2) or the owner DEFINERs
ALTER POLICY mfa_factors__select__own ON identity.mfa_factors
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
ALTER POLICY mfa_factors__insert__own ON identity.mfa_factors
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
ALTER POLICY mfa_factors__update__own ON identity.mfa_factors
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
```
This only narrows (equality is false for NULL). Spec follow-up for the lead: C2 05-SCHEMA §5 `mfa_factors __own` comment "tenant or tenant-less" becomes "tenant rows of the calling tenant".

## Tests
- db/tests/identity/T0B-10.C2_policies.test.sql tests 63 and 72 must pass unchanged (0 rows at aal1 and at scope ≠ platform); the partner test at line 192 (n=1 own row) and the platform aal2 test at line 162 (n=1 via `__platform`) must stay green.
- New assertions: claims `{sub: uid(101), aal: aal1, scope: platform}` → UPDATE of the tenant-less factor → n=0; INSERT of a tenant-less factor under those claims → 42501.
- db/tests/identity/AUTH-MFA-COMPLETE-1 and the platform login suites (DEFINER path) stay green.
