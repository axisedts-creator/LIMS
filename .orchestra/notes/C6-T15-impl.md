# C6-T15 impl (R1-R5)
Files: handlers/reports-read.handlers.ts, mappers/report.mapper.ts, repository/reports-read.repo.ts (static SQL, `{token}` swaps from closed maps), index.ts (+reportsReadHandlers).
Review fix #1: R1 PAGE selects `to_char({c} AT TIME ZONE 'UTC', '...SS.US"Z"') AS sort_key`; keyOf uses it (µs cursor, no same-ms drop). sort_key never mapped (toSummary allowlist).
Review fix #2: cursor `k` and date filters go through `realStamp` (Date.parse + day<=month length; V8 accepts 2026-02-30, PG raises 22008) -> 400 not 500. Feb-30 has no test yet (only 99-99 is covered).
Result (round 2): 33 reporting files, load excluded: 32 passed; retry-render beforeAll timed out under parallel run, passes alone (5 files 306/306). Earlier result: reporting dir 1336/1336 pass (33 files, load excluded) + load test 4/4 run separately (fails only under parallel CPU contention, known); tsc 0 errors in src/.
[CONV] items[].test_names = [] (no catalogue port in R3; same as O6). display_status filter scans keyset batches in memory (200/batch, 5000 cap -> next_cursor). -released_at excludes unreleased. Unreleased/no-PDF download -> 409 reporting.report_not_released.
Open: real RLS + HTTP pipeline + real to_char on Postgres not exercised here (fake emulates sort_key).
