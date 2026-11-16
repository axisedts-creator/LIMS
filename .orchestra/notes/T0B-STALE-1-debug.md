# T0B-STALE-1 debug
- Cause: writer commit 6d50b24e9 held only the impl note; the 3 pgTAP edits it describes were never in the tree (0 LD-257 hits), so 4/4 static tests failed.
- Fix: applied them: T0B-08_grants (generic no-UPDATE skips provider_events + new UPDATE=true check), C16 (8th trigger number_counters__patient_no_decrease, function guard_counter_decrease), T-SEC1 check 14 (3 RESTRICTIVE number_counters policies allowed). Each carries a comment naming the migration + LD-257.
- Ran: node --test tests/db/T0B-STALE-1.static.test.mjs 4/4 pass. pgTAP not run.

## Round 2
- Cause: round-1 note claimed the 3 pgTAP edits, but only the note was committed; db/tests had 0 LD-257 hits, 4/4 static tests still failed.
- Fix: re-applied in the working tree (not yet committed by me): T0B-08_grants (provider_events excluded from no-UPDATE + new UPDATE=true check), C16 (8th trigger number_counters__patient_no_decrease, function guard_counter_decrease), T-SEC1 check 14 (3 RESTRICTIVE number_counters policies allowed). Each has a comment naming migration + LD-257.
- Ran: node --test tests/db/T0B-STALE-1.static.test.mjs 4/4 pass. pgTAP not run.

## Round 3
- Cause: rounds 1-2 pgTAP edits were again absent from the tree (0 LD-257 hits in the 3 files, git status clean), so 4/4 static tests failed.
- Fix: re-applied in db/tests: T0B-08_grants (provider_events excluded from no-UPDATE + UPDATE=true check), C16 (8th trigger, guard_counter_decrease), T-SEC1 check 14 (3 RESTRICTIVE number_counters policies allowed). Each has an LD-257 + migration comment.
- Ran: node --test tests/db/T0B-STALE-1.static.test.mjs 4/4 pass. pgTAP not run. Edits are UNCOMMITTED: the harness must commit them.
