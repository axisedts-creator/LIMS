# T-Q5 debug (debugger)
- Cause: no implementation defect. The 2 failures were 5000ms timeouts of the first test(s), which pay the cold dynamic import of route.ts; the verify run had load (parallel source test file, 18s total) and the import exceeded 5s.
- Reproduction: route test alone 7/7 in 0.7s; both T-Q5 files 18/18 in 4.2s. No code change made (route.ts/pairing.ts match the spec'd behaviour and tests).
- Risk: flaky on a cold/loaded machine; a testTimeout bump in vitest config (not a test file) or warm-up would harden it - left to the orchestrator.

## Round 2 (packages/ui verify)
- Cause: test defect, not implementation. queueboard.test.tsx:75-79 expects `/\d{1,2}:05/` for staleSince 09:05Z, but kit shows tenant zone DEFAULT_TZ='Asia/Kathmandu' (UTC+05:45, `_shared/dates.ts:20`, CV §4.8) = 02:50 PM. QueueBoard is correct and consistent with TokenSlip/DateText.
- Fix: none in code (tests off-limits; changing zone would be wrong). Dispute stands in `T-Q5-dispute.md`: tester should expect `/02:50/`, or use staleSince 09:15Z and expect 3:00 PM. The other 9 QueueBoard tests pass.
