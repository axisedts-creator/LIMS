# BL-T04 dispute (writer)
Test: counter.concurrency.test.ts "50 parallel allocations of which every third caller fails afterwards" (line 42). 47 of 48 runnable tests pass; this one fails with `[NaN, …]`.
Cause is `SimDb` in helpers.ts, not the service: on a fresh DB the first caller (i=0, the one that fails) runs UPDATE(0 rows) → INSERT (SimDb makes the row visible at once) → UPDATE. Other txs then see the row and queue on its lock chain. When i=0 rolls back, its undo `rows.delete(k)` removes the row, so the next waiter computes `undefined + 1 = NaN`.
Real Postgres differs: an uncommitted INSERT is invisible to other txs' UPDATE (0 rows), and their `INSERT … ON CONFLICT DO NOTHING` waits for the creator; after its rollback they insert the row themselves. TRD §12 step 2 mandates exactly this INSERT-in-caller-tx, so any spec-conformant service hits the model gap.
Fix (tester): in SimDb, keep a row created by INSERT invisible to other txs until commit (waiters' UPDATE returns 0 rows, their INSERT waits on the creator's chain), or seed the row (`db.rows.set(key, 0)`) before the burst in that test.
Service left as-is. Not edited: any test file.
