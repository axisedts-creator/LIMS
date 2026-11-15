-- T0B-HARDEN-1 (LD-231, audit item 1, AC-0B-4.1): BEFORE UPDATE FOR EACH ROW app.enforce_mutable_columns triggers for those of the
-- 44 class C/B tables of LD-231 whose chunk spec defines an always-on mutable-column list. Additive only: no existing policy, grant,
-- trigger or function changes; no CREATE ROLE. The other 39 tables are skipped with .orchestra/cr/T0B-HARDEN-1.<table>.nonblocking.md
-- (spec list missing or state/actor-conditional, or a run-time SET list; LD-231 "NEVER guess a list").
-- Every UPDATE in services/api, services/worker and db/* that targets these tables is checked against the lists by
-- tests/db/T0B-HARDEN-1.mutable-columns.test.mjs (LD-231 SAFETY RULE). Not run against a database in the lane (no Docker; LD-231).
SET LOCAL ROLE lims_owner;

-- C12 05-SCHEMA §2.24 (:259) "Mutable columns: status, store_id, rules_applied, value_paisa_total, reason_code, resolved_at,
-- resolved_by, updated_*, version" (unconditional; inventory.tg_doc_guard keeps the transition checks).
CREATE TRIGGER consumption_facts__mutable_columns BEFORE UPDATE ON inventory.consumption_facts
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('status','store_id','rules_applied','value_paisa_total','reason_code',
  'resolved_at','resolved_by','updated_at','updated_by','version');

-- C13 05-SCHEMA :1040-1045 partners.guard_access_slip_update: every column except this set is frozen in every state
-- (access_slips__guard keeps the state transitions).
CREATE TRIGGER access_slips__mutable_columns BEFORE UPDATE ON partners.access_slips
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('state','link_id','link_expires_at','file_path','file_sha256',
  'file_byte_size','failure_code','issued_at','expired_at','version','updated_at','updated_by');

-- C13 05-SCHEMA §3.6 (:180) "is_open ... (the only updatable column besides updated_*)"; the table has no version column
-- (db/meta/tables.yaml mandatory_column_exceptions).
CREATE TRIGGER pickup_request_manifests__mutable_columns BEFORE UPDATE ON partners.pickup_request_manifests
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('is_open','updated_at','updated_by');

-- C6 05-SCHEMA §5 (:215) reports/report_order_items/narrative_reports: "all except identity/tenant/order keys (enforced by
-- enforce_mutable_columns excluding id, tenant_id, order_id, family, created_*)"; complement taken over the C6 DDL (:560-571, :891-897).
-- [CONV] `family` is not a column of these two tables, so it drops out.
CREATE TRIGGER report_order_items__mutable_columns BEFORE UPDATE ON reporting.report_order_items
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('centre_id','report_id','order_item_id','orderable_id','orderable_kind',
  'test_ids','narrative_test_ids','priority','item_status','requires_lab','requires_narrative','requires_outsourced','lab_ready',
  'narrative_ready','outsourced_ready','ready_marker','approved_results','amendment_pending','specimen_hint','specimen_hint_seq',
  'items_version','version','updated_at','updated_by');

CREATE TRIGGER narrative_reports__mutable_columns BEFORE UPDATE ON reporting.narrative_reports
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('centre_id','report_id','order_item_id','test_id','template_kind',
  'status','current_version_no','signed_version_no','version','updated_at','updated_by');
