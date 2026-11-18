# T0B-GREEN-1: pgTAP suites of C9..C15 (quality, micro, anatomic, inventory, smartreport, payments), tester pass
Authority: LD-268, LD-273, founder 2026-11-16 10:08 NPT. No policy, grant, migration, seed or contract was edited. Suite list derived by running the six directories (LD-273): 12 suites, all 12 had failures.
Method: `bash db/tests/run-suites.sh <12 files>` on the lane worktree, pinned image supabase/postgres:17.6.1.136, before and after. Before: 107 `not ok`. After: 5, all REAL (left red, unedited, CR written).

## Per suite (not ok before -> after)
| suite | before | after | remaining |
|---|---|---|---|
| anatomic/T0B-13.C11_schema | 1 | 0 | |
| anatomic/T0B-13.C11_behaviour | 12 | 1 | 432 REAL |
| payments/T0B-13.C15_schema | 1 | 0 | |
| payments/T0B-13.C15_behaviour | 55 | 1 | 373 REAL |
| inventory/T0B-13.C12_schema | 2 | 0 | |
| inventory/T0B-13.C12_behaviour | 3 | 0 | |
| micro/T0B-13.C10_schema | 1 | 0 | |
| micro/T0B-13.C10_behaviour | 12 | 0 | |
| quality/T0B-13.C9_schema | 1 | 0 | |
| quality/T0B-13.C9_behaviour | 11 | 0 | |
| smartreport/T0B-13.C14_schema | 1 | 0 | |
| smartreport/T0B-13.C14_behaviour | 7 | 3 | 357, 370, 373 REAL |
Totals: STALE 38, HARNESS 64, REAL 5 (= 107). Numbers are the TAP numbers of the BEFORE run.

## STALE (38): expectation older than an approved migration or ruling
- DELETE-policy checks, 6 (C11 s140, C15 s68, C12 s153, C10 s186, C9 s114, C14 s70): migration 20261105001000 (core__create_event_inboxes) puts `event_inbox__delete__owner_only` on every schema's event_inbox. Now: the original check runs with `tablename <> 'event_inbox'` (unchanged meaning for every business table) and a new assertion pins the inbox policy to exactly `event_inbox__delete__owner_only|{lims_owner}` (so a DELETE policy for any other role on the inbox is caught).
- Device actor, 32 (C11 b149,153,161,165,169,173,189,197,201; C15 b119,123,127,131,135,139,143,147,151,155,159 reads and b248,252,256,260,264,268,272,276,280,284,288 inserts; C9 b166): 08-CR-REGISTER R10 item 5 / CR-C13-011 (ACCEPT) and 05-SCHEMA `app.is_staff_or_system()` = actor_type IN ('user','system','device'); C12 check 11 already expects it. Now: partner/portal/patient keep "0 rows / cannot INSERT" (unchanged); device is asserted to read exactly what the system actor reads of tenant-scoped tables (C11, C9, C15), 0 rows of centre-scoped tables with no centre claim (C11: no all-centres scope, 08 R3), never another tenant (check 9 / 1, unchanged); C15 also asserts the device UPDATE of merchant_accounts is admitted (rc=2) and the device INSERT is not refused by RLS (42501), both inside a rolled-back sub-block (`pg_temp.xr`) so no fixture changes. C14 (smartreport) excludes device on purpose (08 A19 D-109): its device assertions pass unedited.
  Spec conflict found: 01-PRD AC-0B-3.6a still says device reads 0 rows; and the database lets a device credential write payments.* and anatomic.*. See CR -004 (security question for the lead / founder).

## HARNESS (64): fixture, helper or call defect, fixed in the tests
- `pg_temp.x` default mode is `n` (count of a query); 17 calls pass an UPDATE / INSERT / DELETE without mode `w`, giving E42601 syntax error: C11 b266,267; C15 b182-185; C12 b175,176,327; C10 b233,234; C9 b164,165; C14 b181-184. Fix: pass `'w'`. (C14's device update now correctly returns n=0: smartreport excludes device.)
- C15 b404-474 (18 allowed intent pairs), b480-514 (8 allowed refund pairs), b517, b518: the second fixture block inserted intents / refunds with order ids and parent intent ids that never existed; PostgreSQL re-checks every FK on UPDATE of a row inserted by the same transaction, so each allowed pair failed with intents__order__fk / refunds__intent__fk (forbidden pairs passed because the guard trigger fires first). Fix: the block now inserts the real parents (frontdesk.orders 82000+n and 86000+n, settled parent intents 84000+n). All 18 + 8 allowed pairs now move their row and the 54 + 34 forbidden rows keep their status (b517/518 green with the original counts).
- C10 b350,359-363,384-387 (12 with 233,234): same FK re-check on pass-case UPDATEs of cultures / instrument_records / the isolate counter. Fix (C11 precedent): drop, for the rolled-back transaction only, the FKs towards frontdesk orders / items / patients, catalog tests and instruments, and build the lab.specimens parents so `cultures__specimen__fk` and `specimen_isolate_counters__specimen__fk` stay live (check 14 "re-point to uid(1) stops on the missing lab.specimens parent" still proves that FK).
- C9 b248,250,256,257,272,273,274,276: same cause; the FKs towards instruments, catalog tests / analytes, lab.qc_results and the never-built control levels / lots are dropped for the transaction only; in-chunk FKs and the cross-tenant composite-FK probe (b189) stay live.
- C12 s753: the expectation compared `proconfig::text` with `{search_path=""}`; PostgreSQL 17 renders `{"search_path=\"\""}`. Now compares `proconfig = ARRAY['search_path=""']` (same property: SECURITY INVOKER, empty search_path, owner lims_owner, integer).

## REAL (5): database does not do what the contract says; left red, CR written (nonblocking)
- C14 b357, b370, b373 -> CR-C0-T0B-GREEN-1-001 (.orchestra/cr/T0B-GREEN-1.smartreport-check-null.nonblocking.md): rules__followup_fields__ck, library_versions__hash__ck, summaries__score__ck evaluate to NULL (accepted) for a follow-up rule without interval_days, a non-draft library without content_sha256, a score value without a band. Evidence: the TAP output (rows accepted / reached a later unique index) and the CHECK text in 20261115140000.
- C15 b373 -> CR -002 (.orchestra/cr/T0B-GREEN-1.payments-static-qr-generated-column.nonblocking.md): app.enforce_mutable_columns rejects every UPDATE of payments.static_qr_reconciliations (is_active can never change) because of the STORED generated column difference_paisa. Evidence: diagnostic run, a temp table with a generated column and `enforce_mutable_columns('flag')` raised immutable_row on a flag-only UPDATE; a plain insert then `SET is_active = false` raised the same. Check core.memberships.is_active and the billing table at 20261105001700:440 for the same class.
- C11 b432 -> CR -003 (.orchestra/cr/T0B-GREEN-1.lims-analytics-views.nonblocking.md): lims_analytics cannot read ANY v_pub_* view (security_invoker views; the role has no base-table or app-schema privileges by design). Evidence: diagnostic run, E42501 on anatomic, reporting, instruments, micro and quality views. GREEN-2 / -3 will see the same.

## Not reproduced / not in scope
- Brief: "quality.v_pub_qc_summary does not exist": the view exists on the pinned image after the migrations (diagnostic). Not in these 12 suites; db/tests/views/C9-T20.v_pub_qc_summary.test.sql and the `*__owner_only ... TO lims_owner only` checks live in other directories (T0B-GREEN-2 / -3 or a views task): re-derive there.
- Isolation probes (db/tests/isolation) not run here. Side finding: every `run-suites.sh` run regenerates db/tests/fixtures/probe-rows/engagement.sql (+9 lines) and partners.sql (+12 lines) differently from the committed copies (migrations 20261117240000 / 20261117210000 added columns after the last commit of the fixtures); they are left modified in the worktree (the revert was not permitted here); they are generator output, not this task's work: discard with `git checkout -- db/tests/fixtures/probe-rows/engagement.sql db/tests/fixtures/probe-rows/partners.sql`, or commit them if the generator owner wants them current.
- The 770 s total run time and the 10 minute CI budget are untouched.
