Title: CR-C0-T0B-PROVFIX-1-002: audit_log__insert__owner_only refuses the audit row of platform-context writes to audited identity tables (for T0B-PROVFIX-3)
From chunk: C0 (lane C0-0B, task T0B-PROVFIX-1, LD-295)   To owner: C0-0B (audit policy) / C2 (identity policies) — migration is a human decision (T0B-PROVFIX-3)
Type: schema (RLS policy)
Blocking? NO (LD-295: provisionTenant no longer seeds annex rows; this CR is for the later migration T0B-PROVFIX-3).

Problem (static, no database in the lane):
 Platform requests run with platform claims and app.current_tenant_id() IS NULL. A write to an audited tenant table fires app.tg_row_audit()
 (SECURITY DEFINER, lims_owner) which inserts audit.audit_log with tenant_id = the row's tenant; audit_log__insert__owner_only
 (20261105000600_audit__create_audit_tables.sql:41) admits it only for tenant_id = current tenant, the 08 A12.5 core.tenants clause, or a
 maintenance DEFINER -> 42501 -> common.not_found. Inside withTenantScope the claims become the identity system actor (core/db/tx.ts:186), so
 app.is_platform_actor() is false and the __platform policies of 20261115191000_identity__add_platform_policies.sql refuse instead.
 Proven failing: INSERT INTO identity.ird_annex_records (staging 2026-11-16 22:00:24 NPT, LD-294/LD-295).

Proposed change (option 1 of the archived CR-C0-T0B-PROVFIX-1-001, extended):
 New audit migration + db/policies/audit.sql (DROP/CREATE POLICY audit_log__insert__owner_only), adding one clause:
   OR ((SELECT app.current_tenant_id()) IS NULL AND schema_name = 'identity'
       AND table_name IN ('ird_annex_records','ird_annex_events','ird_annex_documents') AND (SELECT app.is_platform_actor()))
 spec 08 A12.5 text extended accordingly. Then T0B-PROVFIX-3 restores repo.seedIrdAnnexes in provisionTenant OUTSIDE the scope.
 Note: today only ird_annex_records has an audit trigger (ird_annex_records__audit, 20261105001300:956); ird_annex_events/documents have none,
 so their clause is forward cover in case triggers are added.

Other tables of 20261115191000 with an audit trigger, platform-only write policy, and the operation that writes them:
 | table | audit trigger | platform write policy | operation (file) | placement | result |
 | identity.ird_annex_records | yes (:956) | insert/update__platform | createPlatformIrdAnnex, updateIrdAnnex, transitionIrdAnnex (ird.service.ts:114/128/154 -> ird.repo.ts:63/74/78) | no scope | audit row refused (same as provisioning) |
 | identity.support_sessions | yes (:955) | insert/update__platform | openSupportSession, activateSupportSession, endSupportSession (support.service.ts:181/217/236 -> :79/88/95) | no scope (only access log + notice are scoped) | audit row refused |
 | identity.feature_flags | yes (:953) | update__platform | setFeatureFlagAsPlatform (tenant.service.ts:570) | INSIDE scope | admitted by feature_flags__update__tenant (is_staff_or_system) — OK |
 | identity.tenant_settings | yes (:952) | update__platform (20261105001300:779) | updateTenantSettingsAsPlatform (tenant.service.ts:542) | INSIDE scope | admitted by tenant_settings__update__tenant — OK |
 For support_sessions either extend the clause above with 'support_sessions' or scope those writes (support_sessions__update__tenant admits the
 system actor; there is no tenant INSERT policy, so INSERT still needs the audit clause).
Backward compatible? yes (additive clause).
Tenant/security impact: admits audit rows only for the named identity tables and only for a verified platform actor; tenant_id stays the row's own.
Tests that will prove it: db/tests SQL as a platform actor (no tenant claim): INSERT identity.ird_annex_records and identity.support_sessions
 succeed and write one audit_log row each with the row's tenant_id; as tenant staff the same INSERT is refused; staging createPlatformIrdAnnex
 and openSupportSession answer 201.
