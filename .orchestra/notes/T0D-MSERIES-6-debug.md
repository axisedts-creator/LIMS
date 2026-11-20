Cause: 2 reds are rs-c2.static baseline drift from T0D-WAKE-1 (actions.ts, messages.ts hashes, new auth/waking route), not MSERIES-6 code.
Fix: none in implementation (nothing to change). Dispute written: T0D-MSERIES-6-dispute.md. Tester must re-record rs-c2.baseline.json (RS_C2_RECORD=1) per T0D-WAKE-1 ruling item 1, then re-run verify.

Round (2026-11-17 02:1x): verify log 02:13 shows 3 reds, all rs-c2.static (api paths/data files, routes, field_names x-forwarded-for/x-real-ip): stale rs-c2.baseline.json, not MSERIES-6 code.
Fix: none in implementation; the baseline is a test fixture, debugger may not edit it. TESTER stage must re-record with RS_C2_RECORD=1 per LD-298/LD-303/LD-306 (allowed diff: actions.ts + messages.ts hashes, route auth/waking, field_names minus the two headers, platform actions.ts/shared.ts hashes from 9677e24a3).

Round (2026-11-17 02:15 verify): same 3 reds, all rs-c2.static (routes +auth/waking, field_names -x-forwarded-for/-x-real-ip, data_files hashes). Cause: stale rs-c2.baseline.json (test fixture), not MSERIES-6 code.
Fix: none; no implementation change can fix it and debugger may not edit tests. Needs TESTER stage with RS_C2_RECORD=1 per LD-298/LD-303/LD-306. Dispute stands: T0D-MSERIES-6-dispute-202611170211.md.

Round (2026-11-17 04:4x verify): 1 red, m6.photo.test.tsx "no remote image URL" timed out at 60000ms (sync file scan; 16 workers, ~23s startup each, 179s run under load). Not a code fault.
Fix: none. Test alone passes in ~3s; full web m6 re-run 16 files, 425 of 425 passed (110s). rs-c2.static now green after founder re-record. Load-induced flake: re-run verify with the machine idle.
