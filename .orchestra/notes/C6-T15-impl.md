# C6-T15 impl (R1-R5)
Files: handlers/reports-read.handlers.ts, mappers/report.mapper.ts, repository/reports-read.repo.ts (static SQL, `{token}` swaps from closed maps), index.ts (+reportsReadHandlers).
Result: reports-read + manifest + repository.static = all pass; tsc clean for src/; whole reporting dir (minus load test) 1333/1334 — the 1 failure is a stale test, see C6-T15-dispute.md.
[CONV] items[].test_names = [] (no catalogue port in R3; same as O6). display_status filter scans keyset batches in memory (derived from latest version; 200/batch, 5000 cap -> next_cursor). -released_at excludes unreleased. Unreleased/no-PDF download -> 409 reporting.report_not_released for non-releasers; releasers with no PDF also get it.
Open: cursor timestamps are ms-precision ISO, DB is µs (a tie within the same ms could skip/repeat a row) — same as O6/N1; real RLS + HTTP pipeline not exercised here.
