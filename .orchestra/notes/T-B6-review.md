APPROVE
Round 2 (diff 28d3d7de..HEAD). The previous item 1 is fixed. t-b6.bookings.test.tsx:336 now closes the "max 20 tests" `it` with `}, 90_000);` and uses the shorter `Test ${i}` filter. The exact-name option regex `Synthetic Test ${i}$` stays, and the 21st-item assertion is not loosened. Both changes match the ruling.
t-q4.source.test.ts now checks queue sources only (`/queue/i`), as the ruling says. T-Q4 coverage is unchanged and no assertion is weakened. There are no implementation changes. Only owned C16 paths and notes files are touched. No names are invented, and no PHI or secrets are added.
Checks run (2026-11-13 21:41-21:44): kit WeekdayTimeRangeEditor 16/16 pass; t-b6 config (--maxWorkers=1) 92/92 pass; t-q4.source 18/18 pass.
Not rerun: tsc and ESLint. There was no source change since round 1, and ESLint is not installed in the repo.
