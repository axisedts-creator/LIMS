# VERIFY-GREEN-5 dispute (debugger, round 8, 2026-11-19 12:27)
Verify log: 2 red of 60. vg5 typecheck test green; no VG5 implementation fault.
1. rs-c6.screens `worklist` snapshot still lacks `button Ready to release` (.snap not re-recorded; git status clean). LD-413 already authorises tester `vitest run -u` (CI unset) on rs-c6.screens only. Not done yet.
2. NEW: rs-c6.static `data_files` pin fails: `portal/src/middleware.ts` hash changed. Cause: SEC-HDR-1 (commit d537ac9c8) added 3 lines of security headers to apps/portal/src/middleware.ts. Not VG5, not LD-405. Reverting it would undo SEC-HDR-1 security work.
Ask: lead rules on a baseline re-pin of that one hash in rs-c6.baseline.json (tester-owned), citing SEC-HDR-1. Writer/debugger may not edit baseline or tests.
