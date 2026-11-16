# T0D-WAKE-1 debug
Cause: only 2 failures in verify log, both rs-c2.static baseline drift (actions.ts, messages.ts hashes + new waking/page.tsx route). wake1 config and ui lint pass. Baseline is stale, not the code.
Fix: none in implementation (nothing to change; brief allows these diffs). Test-side: tester must re-record rs-c2.baseline.json (RS_C2_RECORD=1) per ruling round 2 item 1. Dispute written: T0D-WAKE-1-dispute.md. Then re-run T0D-WAKE-1-verify.cmd.

Round 4: same log, same cause. 2 failures only, both rs-c2.baseline.json drift (actions.ts hash, messages.ts hash, new waking/page.tsx route). Baseline last committed ec073f164, not re-recorded. No implementation change. Dispute: T0D-WAKE-1-dispute-202611162147.md. Needs tester RS_C2_RECORD=1 re-record.

Round 5: same 2 failures (rs-c2.static: actions.ts hash, messages.ts hash, new waking/page.tsx route). Baseline still ec073f164, not re-recorded. No implementation change possible or needed; tester must run RS_C2_RECORD=1 (see T0D-WAKE-1-ruling.md item 1). Dispute: T0D-WAKE-1-dispute-202611162147.md.

Round 6: same log, same 2 failures (rs-c2.static baseline drift: actions.ts hash, messages.ts hash, new waking/page.tsx route). No implementation change. Dispute stands: T0D-WAKE-1-dispute-202611162147.md. Tester must run RS_C2_RECORD=1 (ruling item 1); debugger may not edit tests.

Round 7: verify log now 3 reds in rs-c2.static, not 2. New one: `same form field names` (baseline has x-forwarded-for, x-real-ip). Cause: T0A-CLIENTIP-1 (c069f7ecd) moved those header reads to core/api/client-context.ts, outside rs-c2 ROOTS; actions.ts has 0 matches. Not a WAKE-1 change. Baseline last commit still ec073f164.
Fix: none in implementation (re-adding the reads would undo CLIENTIP-1). Tester must re-record once with RS_C2_RECORD=1; LD-298 allowed diff needs the field_names entry added by lead. Dispute: T0D-WAKE-1-dispute.md (writer, 23:45) stands.
