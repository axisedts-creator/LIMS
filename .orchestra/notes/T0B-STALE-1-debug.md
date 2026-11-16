# T0B-STALE-1 debug
- Cause: writer commit 6d50b24e9 held only the impl note; the 3 pgTAP edits it describes were never in the tree (0 LD-257 hits), so 4/4 static tests failed.
- Fix: applied them: T0B-08_grants (generic no-UPDATE skips provider_events + new UPDATE=true check), C16 (8th trigger number_counters__patient_no_decrease, function guard_counter_decrease), T-SEC1 check 14 (3 RESTRICTIVE number_counters policies allowed). Each carries a comment naming the migration + LD-257.
- Ran: node --test tests/db/T0B-STALE-1.static.test.mjs 4/4 pass. pgTAP not run.
