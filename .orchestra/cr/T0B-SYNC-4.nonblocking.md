# CR T0B-SYNC-4 (non blocking; implemented under LD-310 / LD-322, flagged for lead audit)
Chunk: C0-foundation-contracts. Raised by: writer T0B-SYNC-4. Date: 2026-11-18.

1. NEW STORAGE (no table in the contract): migration `db/migrations/20261118100000_core__add_sync_offline_signoffs.sql` adds
   `core.sync_signoff_outcome` (verify outcomes a print relied on, append only), `core.sync_print_marker` (pending -> confirmed | recall_required,
   trigger guarded), `core.sync_alert` (lab manager alerts: result_locked, verification_policy_failed; ids and codes only, append only), all tenant RLS
   like core.sync_operation, and `reporting.print_jobs.issued_offline boolean NOT NULL DEFAULT false`. Policies mirrored in db/policies/core.sql.
   ASK: record the names in 05-SCHEMA / IC; decide who reads core.sync_alert (no API or notification consumer exists yet).
2. NO ACCESS ACTION for an approval: the offline approval audit event uses `lab_result.view` with detail.event `offline_approval` (SYNC-3 precedent:
   patient.view for sync_operation_applied). ASK: register an approve access action if wanted.
3. NO TENANT SETTING for (a) offline approval (adapter default off = DEFAULT_SYNC_SETTINGS.offlineApprovalAllowed) and (b) "step up to close the day"
   (default off; online closeCashSession needs none). Both are adapter seams. ASK: setting names + source.
4. NO WIRE FIELD names the sign offs a print relied on: the rule uses every verify the printing device synced for the results the report version shows.
5. worklist_item pull mapping (LD-374 ruling 2): NOT implemented here; pullChanges keeps answering auth.forbidden for it (fail closed). ASK: a task row.
6. Render worker (services/worker reporting.render_print) does not yet draw the issued offline watermark from print_jobs.issued_offline (outside the
   brief's files). A marked letterhead print renders a file instead of streaming the canonical PDF.
