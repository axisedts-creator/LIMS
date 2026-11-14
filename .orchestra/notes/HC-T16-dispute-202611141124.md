# HC-T16 dispute (writer, 2026-11-14 11:12)
Reran `bash tests/homecollection/HC-T16.pg.sh` on f7433e70: Test Files 1 failed | 5 passed; Tests 1 failed | 60 passed.
Only failure: anonymise_definer.live.test.ts:46-49. The pg_policies query (`schemaname = 'homecollection' AND policyname LIKE '%__owner_only'`) also returns `event_inbox__delete__owner_only` / `event_inbox__select__owner_only`.
Those policies come from C0 `db/migrations/20261105001000_core__create_event_inboxes.sql` (per-schema event_inbox, C0 05-SCHEMA), not from HC-T16 code or §4.2 DDL. The four expected visits/handover_items policies are present and correct; FORCE-RLS assertion (:45) passes.
Test defect (query too broad). Fix, same as tester's dispute-202611141115: add `AND tablename IN ('visits','handover_items')` to the query at :46; assertions unchanged.
No implementation change made (LD-167). Awaiting arbiter ruling.
