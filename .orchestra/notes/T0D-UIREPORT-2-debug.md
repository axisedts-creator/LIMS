
## debugger 2026-11-20
Cause: only red is rs-c8.static "same bytes": baseline.json pins of report-page.tsx and report-views.ts went stale when the writer changed them in 81e0c69fb after the tester re-pin (7fbac2be7).
Fix: none in implementation (changes are required by ruling). No test edited. Dispute written to T0D-UIREPORT-2-dispute.md: tester must re-pin those two hashes to the final bytes.
