# T0B-STALE-1 tests (tester)
- tests/db/T0B-STALE-1.static.test.mjs: 4 node tests, static reads of the 3 pgTAP files (pgTAP is not run in the lane).
- Run: node --test tests/db/T0B-STALE-1.static.test.mjs (also .orchestra/notes/T0B-STALE-1-verify.cmd).
- Now fail 4/4 for the right reason: the grants generic no-UPDATE check does not exclude reporting.provider_events and no TRUE grant check exists; the C16 trigger list lacks number_counters__patient_no_decrease (8 triggers) and the function list lacks guard_counter_decrease; the SEC1 tenant-bound check does not allow number_counters__(select|insert|update)__nonstaff_keys.
- Also required: each change has a comment naming LD-257 and the migration (20261116020000 / 20261116030000); the original checks are kept.
- Not covered: "no policy/grant/migration change" (review by diff); the out-of-scope failures (partners DELETE 135/308/481, C16 96/137/139).
