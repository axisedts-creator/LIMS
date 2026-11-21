-- T0B-MFAPOL-1 (LD-252, CR-C0-T0B-REVIEW-1-003, LD-232 item 4): narrow the three identity.mfa_factors __own policies to tenant rows.
-- The tenant-less branch `tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id())` let claims without a tenant (a platform
-- user at aal1, before MFA) read/insert/update their tenant-less factor row outside the owner DEFINERs (08 A28.1, A15.2, LD-216, LD-221).
-- Tenant-less rows stay reachable only through the DEFINERs before aal2 and mfa_factors__*__platform after (C2 05-SCHEMA s5.3, s5.4, s11 test 3).
-- Narrowing only: no DROP, REVOKE, GRANT, table, column, function, trigger or other policy change. Same text in db/policies/identity.sql.
-- NOT RUN in the lane: this migration and db/tests/identity/T0B-MFAPOL-1_mfa_factors_own.test.sql; founder runs db/tests/run-suites.sh before push-cloud.ps1.
SET LOCAL ROLE lims_owner;

ALTER POLICY mfa_factors__select__own ON identity.mfa_factors
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
ALTER POLICY mfa_factors__insert__own ON identity.mfa_factors
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
ALTER POLICY mfa_factors__update__own ON identity.mfa_factors
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
