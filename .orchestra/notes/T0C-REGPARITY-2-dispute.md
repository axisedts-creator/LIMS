# T0C-REGPARITY-2 dispute (writer, 2026-11-17) — 3 test defects, implementation otherwise green
Results: vitest 773/776 pass (3 files); lint clean for frontdesk/billing; codegen fresh. pgTAP: migration applies; suite aborts at line 256 (defect 1).
With only defect 1 cast-fixed in a throw-away copy (deleted): 348/350 pass (incl. RLS probes, audit exclusion, idempotent re-apply); the 2 failures are defect 2.

1. pgTAP line 256: `cmp_ok((SELECT count(*) ...), '>=', 1, ...)` -> `ERROR: function cmp_ok(bigint, unknown, integer, unknown) does not exist`; the transaction aborts, every later assert is lost.
   Fix: `count(*)::int`.
2. pgTAP lines 278 + 285: `UPDATE frontdesk.orders SET priority = 'urgent'` on order uid(12), which the fixture inserts with status 'registered'.
   The existing frontdesk.orders_lifecycle_guard (20261105001600, C4 05-SCHEMA) allows a priority change only while status = 'pre_registered', so the result is
   `EP0001|immutable_row` (want n=1) and the follow-up ok() is NULL. Not a product defect; changing the guard is out of scope.
   Fix: give fixture 12 `'status','pre_registered','registered_at',NULL` (orders__registered__ck allows it), or update another mutable column the guard allows on a registered order (e.g. requires_credit_note).
3. vitest regparity2 "OrderDto read payload ... validates": the `base` fixture's patient object is a PatientSummary shape (age_display, phone_masked, is_anonymised),
   but the unchanged OrderDto.patient is closed and requires `age_at_order` (no age_display / phone_masked / is_anonymised). Error: `must have required property 'age_at_order'`.
   Fix: patient `{ id, patient_code, full_name, sex, age_at_order: "43 Years" }`.
Not a test defect, for the lead: node db/tools/check-registry.ts is red: 6 new tables + the new columns (and REGPARITY-1's 13 patients columns) lack db/meta/tables.yaml rows
(policies also not mirrored to db/policies/frontdesk.sql). Not in this task's file list; needs a ruling (class / phi_class per column) or a follow-up task.
