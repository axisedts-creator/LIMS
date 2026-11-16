# T0D-WAKE-1 debug
Cause: only 2 failures in verify log, both rs-c2.static baseline drift (actions.ts, messages.ts hashes + new waking/page.tsx route). wake1 config and ui lint pass. Baseline is stale, not the code.
Fix: none in implementation (nothing to change; brief allows these diffs). Test-side: tester must re-record rs-c2.baseline.json (RS_C2_RECORD=1) per ruling round 2 item 1. Dispute written: T0D-WAKE-1-dispute.md. Then re-run T0D-WAKE-1-verify.cmd.
