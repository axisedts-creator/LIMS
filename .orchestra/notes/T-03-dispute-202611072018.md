# T-03 dispute (writer)
- Test: `repository.static.test.ts` › "the spec lists the expected number of lab tables (27 + the 8 coded-set tables, minus event_inbox)" expects `specTables().length >= 34`; actual = 32.
- Why the test is wrong: 05-SCHEMA §1 has 27 `| \`lab.` rows, but two of them ARE the coded-set rows (4 `g_cs_*` + 4 `cs_*` tables). So 25 single-table rows + 8 coded-set tables = 33, minus `lab.event_inbox` = 32. The migration `20261105001800_lab__create_lab_schema.sql` creates exactly these 32 lab tables (event_inbox comes from C0).
- Proposed fix: `toBeGreaterThanOrEqual(32)` (or `toBe(32)`). Not a code issue: every one of the 32 is referenced by a `*.repo.ts` ("every lab table … is read or written" passes).
