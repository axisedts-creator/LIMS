## Debugger round 1 (2026-11-17 16:05 NPT)
- Verify log: 2153 passed, 1 failed: billing boot.test BL-T01 "bootstrap resolves..." Test timed out in 60000ms. No assertion failed; no ACCT-2 test failed.
- Cause: host load, not product code. The 71 inject requests take 1-9 ms each (log durations); the time is core bootstrap of all modules (about 1 s per module). Run alone with -t it PASSED in 50.8 s (close to the 60 s limit); a second unfiltered alone run under load took 155 s.
- Fix: none in implementation code (nothing to fix); test timeouts must not be weakened (LD-328 item 5). Re-run verify on a quiet host, or the lead may pass a larger --testTimeout in the verify command (harness side, not a test edit).

## Debugger round 2 (2026-11-17 16:25 NPT)
- Verify log (16:08): 2153 passed, 1 failed: same billing boot.test BL-T01 timeout at 60000ms. No ACCT-2 or other assertion failed.
- Cause: unchanged, host load. Test bootstraps every module (about 1 s each); alone it PASSED 9/9 in 58.6 s, only 1.4 s under the limit. The 71 requests take 1-9 ms each. Not a product defect.
- Fix: none in implementation code. Timeout not weakened (LD-328 item 5). Needs a quiet host, or the lead raises --testTimeout in the verify command (harness side).

## Debugger round 3 (2026-11-17 16:30 NPT)
- Verify log (16:21): 2154 passed, 1 failed: dailySummary.test.ts refund-only day, `expected -1 to be >= 0` (entry_count). Boot timeout is gone.
- Cause: not a code bug. expenses.repo.ts:98-102 returns the signed net (done_when 4, reconciles with getDailyCash), billing.yaml:9587-9595 and :9615-9619 say `minimum: 0`. Both specs cannot hold on a refund-only day. Test follows the contract and is right.
- Fix: none. Clamping would break reconciliation, and billing.yaml is owned by C0-0C. CR .orchestra/cr/T0B-ACCT-2.md (option a signed net / b separate refund fields) has no lead ruling yet. After the ruling: apply (a) yaml edit by C0-0C, no API change; or (b) split gross/refund sums in the repo.
