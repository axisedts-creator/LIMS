Title: CR-C0-T0B-PROVFIX-1-001: provisionTenant cannot insert identity.ird_annex_records under ANY ordering (platform INSERT policy vs. audit_log owner policy)
From chunk: C0 (lane C0-0B, task T0B-PROVFIX-1, LD-294)   To owner: C0-0B (audit policy) / C2 (identity policies) — founder/lead decides
Type: schema (RLS policy)
Blocking? YES — T0B-PROVFIX-1 done_when (founder can provision a tenant on staging). The brief ruled "needs a migration => nonblocking", but this one is the barrier itself; no code-only fix exists in the owned paths.

Problem:
 Statement: INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES ($1,$2,$3,$4,$4)
 (tenant.service.ts createTenantRepo().seedIrdAnnexes, called by provisionTenant). Two failing checks, one per placement:
 (a) OUTSIDE withTenantScope (main 9f570b767, staging 2026-11-16 22:00:24): ird_annex_records__insert__platform passes
     (is_platform_actor() true), then trigger ird_annex_records__audit -> app.tg_row_audit() inserts audit.audit_log as lims_owner with
     tenant_id = new tenant; audit_log__insert__owner_only fails: app.current_tenant_id() IS NULL and the A12.5 clause is core.tenants only. 42501.
 (b) INSIDE withTenantScope (this task's fix): core/db/tx.ts:186 replaces the claims with {sub: identity system actor, actor_type:'system',
     tenant_id} — no scope='platform', no aal2, sub not in identity.platform_staff — so app.is_platform_actor() is FALSE
     (20261105000100_app__create_context_helpers.sql:36-45). The only INSERT policy on identity.ird_annex_records is
     ird_annex_records__insert__platform (20261115191000_identity__add_platform_policies.sql:35) -> WITH CHECK fails, 42501 -> common.not_found.
 The LD-294 premise "app.is_platform_actor() stays true inside the scope" is false.

Proposed change (pick ONE; recommendation = 1, it mirrors the existing 08 A12.5 clause and keeps annex rows platform-write-only):
 1. audit_log__insert__owner_only: add a clause for platform-context rows of identity.ird_annex_records, and move seedIrdAnnexes back OUTSIDE the scope:
      OR ((SELECT app.current_tenant_id()) IS NULL AND schema_name = 'identity' AND table_name = 'ird_annex_records'
          AND (SELECT app.is_platform_actor()))
    (DROP/CREATE POLICY in a new audit migration + db/policies/audit.sql; spec 08 A12.5 text extended.)
 2. Or: new policy on identity.ird_annex_records FOR INSERT TO lims_app WITH CHECK (tenant_id = app.current_tenant_id()
    AND app.current_actor_type() = 'system' AND app.current_actor_id() = <identity system actor>) and keep the call inside the scope
    (current code). Widens annex writes to the identity system actor of any tenant scope; weaker.
 3. Or: SECURITY DEFINER app.identity_seed_ird_annexes(tenant uuid) setting app.maintenance (A28.5 clause), EXECUTE to lims_app,
    guarded by is_platform_actor() of the caller — most code, no policy widening.
Backward compatible? yes (additive clause / policy).
Tenant/security impact: RLS change on audit.audit_log (option 1) or identity.ird_annex_records (option 2). Option 1 admits only rows whose
 table is ird_annex_records and only for a verified platform actor; tenant_id stays the row's own.
Alternatives considered: code-only placements (a) and (b) both fail as above; core withTenantScope keeping platform claims = core change, out of scope.
Tests that will prove it: db/tests SQL: as a platform actor (no tenant claim) INSERT into identity.ird_annex_records succeeds and writes one
 audit_log row with tenant_id = the row's tenant; as a tenant staff user the same INSERT is refused; then founder retry of POST /v1/identity/platform/tenants -> 201.

Also (nonblocking, item 4 of the brief): same outside-the-scope pattern elsewhere in tenant.service.ts — see .orchestra/notes/T0B-PROVFIX-1-review.md "Other operations". No audited tenant-table WRITE runs outside a scope there; only reads (load/find, findSettings, readiness) and core.tenants update (A12.5 covered). Nothing else to change.
