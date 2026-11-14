TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Change: in infra/tests/static/test_t09_pgbackrest.py, decorate `DecisionTest.test_records_wal_per_day_measured` (line 485) with
`@unittest.skip("needs data-1/dr-1 hosts (B12)")`. Body unchanged (keeps R8 check ready for when hosts exist). No other test changes.
Reasons:
- spec/chunks/C1-infrastructure-ops/06-IMPLEMENTATION-PLAN.md:84 (R8) does put "measured in T-09/M2", but the T-09 brief's binding LD-34 overrides spec text for this task: measured WAL GiB/day is deferred to B12, "those tests are marked skip with reason `needs data-1/dr-1 hosts (B12)`", and "Never invent measured values".
- The test (lines 486-489) requires a numeric `WAL volume per day (measured ...)` line and forbids "NOT measured", so a correct impl that follows LD-34 cannot pass it without inventing a value.
- LD-43 (2026-11-07) already rules exactly this: skip only this test with that reason; "every other test stays".
- The line-22 header "Missing file = FAIL (never skip)" is about missing files; a skip ordered by LD-34/LD-43 does not conflict with it.
- Out of scope here: `test_check_ok_both_repos_and_full_incr_recorded` (line 492) is also deferred by LD-34, but LD-43 keeps it; raise a new dispute if it fails against a correct impl.
