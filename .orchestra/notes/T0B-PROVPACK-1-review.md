APPROVE

Reviewed `git diff 3616141b..HEAD` (tenant.service.ts + tests + CR) against task brief, LD-301, 11-ROLE-MATRIX R6.
- Grants: only tenant_admin changes (`grantsOf`); TENANT_ADMIN_GRANTS = catalogue minus `platform.*` minus actor-only (`roles: []`). Other default roles keep ROLE_GRANTS; pack roles come unchanged from role-packs.data.yaml. mfa_required untouched.
- Pack: reuses role-pack.service (no copy), DEFAULT_ROLE_PACK constant, insert-only + ON CONFLICT DO NOTHING; existing roles skipped (R6). Runs inside withTenantScope at provisioning and activation (repair path). Idempotent: missing-only grants, audit row only when something is written.
- Audit: role.change access-log rows per created role / admin grant top-up; no PHI, no secrets. No RLS/schema change. Paths owned.
- Checks run: verify set (provpack, realchain, activate, tenant.service/handlers/integration/static, role-packs/*) 892 pass; tsc --noEmit clean. 9 failures in role-packs/apply-role-pack.script.test.ts (ADMINPACK-2/4 runbook + package.json) are outside this diff and outside the verify set (pre-existing).

Non-blocking notes (no change required for this task):
1. CR item 4 says tenant_admin "is not listed in each code's roles:" — it is listed on many codes; wording should read "not on every tenant code".
2. CR item 2 (R2/R5a separation-of-duties conflict) needs a lead ruling; LD-301 currently overrides.
