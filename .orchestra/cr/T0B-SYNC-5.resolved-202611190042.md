Title: CR-C0-T0B-SYNC-5-001: DELETE path for the sync ledger retention job (lims_worker only)
From chunk: C0 (T0B-SYNC-5, lane C0-0H)            To owner: C0-0B (db) + lead/arbiter (supersedes pinned assertions)
Type: schema
Blocking? yes: T0B-SYNC-5 done_when (3) RETENTION (retention.live.test.ts: every purge needs DELETE on 5 core.sync_* tables as lims_worker)

Problem:
- done_when (3) and the pinned surface (kit.ts header) require purgeSyncLedger to delete from core.sync_operation, core.sync_conflict,
  core.sync_signoff_outcome, core.sync_print_marker, core.sync_alert as lims_worker, while lims_api keeps NO DELETE.
- All five tables have FORCE ROW LEVEL SECURITY and no DELETE policy, so ANY delete (lims_worker grant, or a lims_owner DEFINER) needs a DELETE
  policy. No role has BYPASSRLS.
- That contradicts EXISTING pinned tests and metadata (done_when 6 says existing suites stay green unchanged):
  * db/tests/core/T0C-SYNC-2_sync_operations_conflicts.test.sql line 87 "every policy on <t> is TO lims_app only" and line 91
    "<t> has no DELETE / ALL policy" (sync_operation, sync_conflict);
  * db/meta/tables.yaml core.sync_operation / core.sync_conflict retention "never deleted";
  * db/policies/core.sql comments "no DELETE policy" (T0C-SYNC-2, T0B-SYNC-4).

Proposed change (exact), migration db/migrations/20261119000000_core__grant_sync_retention_delete_to_worker.sql:
  SET LOCAL ROLE lims_owner;
  GRANT DELETE ON core.sync_operation, core.sync_conflict, core.sync_signoff_outcome, core.sync_print_marker, core.sync_alert TO lims_worker;
  -- for each t of the five, guarded by pg_policy:
  CREATE POLICY <t>__delete__tenant ON core.<t> FOR DELETE TO lims_worker
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
  plus: db/policies/core.sql lines for the 5 policies; db/meta/tables.yaml retention text "180 days after confirmation / resolution
  (T0B-SYNC-5 core.sync_retention)"; T0C-SYNC-2 pgTAP lines 87 and 91 changed to "every policy is TO lims_app, except <t>__delete__tenant
  TO lims_worker" and "the only DELETE policy is <t>__delete__tenant TO lims_worker"; lims_app DELETE stays false (line 93 unchanged).
Backward compatible? yes for code (additive grant/policy). Breaking for two pinned pgTAP assertions and the tables.yaml retention text -> needs the
  lead/arbiter ruling that those pins are superseded by the T0B-SYNC-5 contract (precedent LD-358).
Tenant/security impact: RLS change (new DELETE policy, tenant + system actor bound, lims_worker only; lims_api/lims_app still no DELETE,
  REQ-SEC-016 default deny kept for requests). Row audit triggers stay; audit.* is never touched.
Alternatives considered: (a) DEFINER owned by lims_owner with __delete__owner_only policies bound to app.maintenance (02-CONVENTIONS §5.12 class A
  path): still a DELETE policy and not TO lims_app, so it breaks the same two pgTAP lines; (b) NO FORCE RLS: DDL toggle at run time, rejected;
  (c) no retention: fails done_when (3).
Tests that will prove it: services/api/src/core/sync/__tests__/hardening/retention.live.test.ts (incl. lims_api DELETE -> 42501), pgTAP T0C-SYNC-2
  as amended.
Status in the lane: the migration file was applied on the throwaway PG17 to verify retention.ts, then REMOVED from db/migrations so the existing
  pgTAP suite stays green; it is re-added verbatim once this CR is approved.
