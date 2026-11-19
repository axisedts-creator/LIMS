Title: CR-C0-T0B-GREEN-3-001: platform claims cannot INSERT/UPDATE audited tenant rows (support_sessions, ird_annex_records, feature_flags, tenant_settings): audit_log__insert__owner_only refuses the audit row (pgTAP evidence for CR-C0-T0B-PROVFIX-1-002)
From chunk: C0 (lane C0-0B, T0B-GREEN-3)   To owner: C0-0B (audit policy) / C2 (identity) — migration is a lead decision (T0B-PROVFIX-3); no policy, grant or migration was edited here
Type: schema (RLS policy)
Blocking? no (the tests stay RED and are listed as REAL; the app avoids the case by scoping the writes, see CR-C0-T0B-PROVFIX-1-002)

Problem: the database does not do what db/tests/identity/PLATFORM-DDL-1_policies.test.sql (05-SCHEMA s5.3, LD-223) names: a verified platform actor (claims scope=platform, aal2, no tenant) may INSERT support_sessions / ird_annex_records and UPDATE
 feature_flags / support_sessions / ird_annex_records / tenant_settings. The __platform policies admit the row, then the AFTER row trigger app.tg_row_audit() (SECURITY DEFINER, lims_owner) inserts audit.audit_log with tenant_id = the row's tenant and
 audit_log__insert__owner_only (20261105000600:41) admits only tenant_id = app.current_tenant_id() (NULL here), the 08 A12.5 core.tenants clause, or a maintenance DEFINER -> E42501 "new row violates row-level security policy for table audit_log".
Evidence (pinned image supabase/postgres:17.6.1.136, lane worktree, 2026-11-18, `bash db/tests/run-suites.sh db/tests/identity/PLATFORM-DDL-1_policies.test.sql`): not ok 105 (support_sessions INSERT), 113 (feature_flags UPDATE), 115 (support_sessions UPDATE),
 117 (ird_annex_records UPDATE), 135 (tenant_settings UPDATE), 198 (ird_annex_records INSERT x3, annex_2/3/7 of a tenant without annex rows), 202 (E42501 instead of the unique-key E23505, because 198 left no row), 203 (0 rows instead of 3, same cause). Every one reports have E42501.
 Isolation probe (scratch suite, not kept): platform claims INSERT identity.ird_annex_records for tenant b001 -> "E42501 new row violates row-level security policy for table audit_log"; the same statement after
 `ALTER TABLE identity.ird_annex_records DISABLE TRIGGER ird_annex_records__audit` (inside a rolled-back transaction) -> n=1. So the platform policies are fine; the audit policy is the wall.
Proposed change (exact): as CR-C0-T0B-PROVFIX-1-002 (one additional clause in audit_log__insert__owner_only for a verified platform actor writing identity.ird_annex_records / support_sessions), and decide feature_flags + tenant_settings: today only a
 system actor inside withTenantScope can update them (their __platform UPDATE policies are dead letters for a bare platform session); either extend the clause to those two tables or drop the __platform UPDATE policies of 05-SCHEMA s5.3 for them.
Backward compatible? yes (additive clause).
Tenant/security impact: RLS change on audit.audit_log; admits audit rows only for the named tables and a verified platform actor; tenant_id stays the row's own.
Alternatives considered: weaken the 8 assertions to expect E42501 (rejected: that would pin the defect); delete them (rejected). They stay red until the lead decides.
Tests that will prove it: the 8 assertions above go green unchanged (db/tests/identity/PLATFORM-DDL-1_policies.test.sql); harness fix already made there: the 198/202/203 provisioning rows now target the new tenant c001 because the fixture annex_2 of tenant B collided (E23505).
