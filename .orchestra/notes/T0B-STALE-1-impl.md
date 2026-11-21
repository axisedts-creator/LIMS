# T0B-STALE-1 impl (writer)
- Files changed by writer: none (LD-306 item 3: tester owns the three pgTAP edits, commit 7450d65cb). Only this note.
- Verified: node --test tests/db/T0B-STALE-1.static.test.mjs = 4/4 pass. pgTAP not run in lane (per brief).
- Read against migrations: names provider_events__update__tenant, number_counters__(select|insert|update)__nonstaff_keys, guard_counter_decrease, number_counters__patient_no_decrease match 20261116020000 / 20261116030000 verbatim.
- [CONV] All 3 files use no_plan(), so no plan count change; grants file swaps 3 FALSE rows for 3 TRUE rows (same count).
- No policy, grant, migration or product code changed.
- Open (lead): out-of-scope fails stay listed per brief: partners.manifest_lines DELETE 135/308/481, C16 96/137/139, other suites; founder pgTAP run confirms.
