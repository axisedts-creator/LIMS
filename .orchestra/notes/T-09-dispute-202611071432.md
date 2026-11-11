# T-09 dispute: test contradicts LD-34
- Test: infra/tests/static/test_t09_pgbackrest.py `DecisionTest.test_records_wal_per_day_measured` (lines 485-490) requires `WAL volume per day (measured ...): <n> MiB|GiB/day`.
- LD-34 (2026-11-07, binding, T-09 brief): measured WAL GiB/day is deferred until data-1/dr-1 exist (B12); "those tests are marked skip with reason `needs data-1/dr-1 hosts (B12)`"; "Never invent measured values."
- Test has no skip, so it fails against correct impl. DECISION.md already lists WAL/day as open (B12).
- Ask: tester adds `@unittest.skip("needs data-1/dr-1 hosts (B12)")` to this test (and to the check/full/incr test if tightened).
