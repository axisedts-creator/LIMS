# T0B-ACCT-2 dispute (writer): 2 test defects, 0 product defects. Whole billing suite on PG17: 2150 pass, 4 fail = these 2 + repo.static (fixed) + boot.test 60 s timeout under full suite load (passes alone, LD-328 5).

1. expenses.test.ts:23 `posts ONE debit entry ...`: `expected '2026-11-16' to be '2026-11-17'`.
   The stored entry_date IS 2026-11-17 (localDate of 2026-11-17T06:00Z in Asia/Kathmandu). The test reads it through superTx raw `pg`, which parses a `date` column
   as a JS Date at LOCAL midnight; on this host (TZ +05:45) `.toISOString()` gives 2026-11-16T18:15Z -> slice = '2026-11-16'. Fails on any host east of UTC.
   Fix (test side): `SELECT entry_date::text` in that query, or compare `le.entry_date.toLocaleDateString('en-CA')`.

2. dailySummary.test.ts:64-77 `the summary total equals getDailyCash net ...`: `error: reversal_mismatch` thrown by the FIXTURE insert, before any handler runs.
   payment() passes `uid()` as order_id on every call, so the reversal row has a different order_id than the payment it reverses; the existing guard
   (20261105001700_billing__create_billing_schema.sql:412-418) requires order_id / centre / method / collector / branch to match -> refused.
   Fix (test side): let payment() accept an `orderId` and pass the original's order_id to the reversal (and the same cash_session_id rule, line 424-429, if it bites next).

No product change can make either pass without writing wrong data or weakening a DB guard. Writer stopped here; everything else in the accounts suite is green (185/187).
