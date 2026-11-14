APPROVE
HC-T06 review (diff d4be7892..0700cd26).
- Names verbatim: event `frontdesk.order.created.v1` payload fields (03-IC §3.1: collection_mode, source, source_ref_id, registered_at, referrer_id, branch_id, centre_id), task `homecollection.refresh_visit_specimens`, job_key `refresh:<visit_id>` (02-TRD §10), SpecimenRef fields (03-IC §4.5 / 08 CR-C10-003), error `common.version_conflict`, flag `address_missing`, kind `front_desk`.
- US-02-1/2/3 match 01-PRD L110-112 and 02-TRD §8.2 row; refresh enqueued on both paths; else ignored.
- Tenant: consumer + task reject tenant_id != ctx.tenantId; all repo calls tenant-scoped; no new tables (no RLS change needed). Idempotency: per-order advisory lock + existing-visit check; home_collection path no-ops when already stamped; job_key dedupes refreshes.
- No PHI/barcode logged or stored (no barcode column; port result discarded after upsert). No secrets (pg.sh generates random pw). Paths are C17-owned.
- Tests: 28 cases cover home/front_desk, home_collection source, walk_in ignored, duplicate + concurrent, tenant isolation, refresh semantics. Writer reports 28/28 via HC-T06.pg.sh; reviewer did not re-run (docker).
- Non-blocking: manifest wiring (TRD §3.2) not in this task's files; HC-T05.pg.sh runs the whole __tests__ dir and HC-T06 count asserts can race with HC-T05 inserts in the same tenant (tester follow-up).
