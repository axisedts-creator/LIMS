## Debugger run (T0C-SYNC-1)
- Verify log has no test failure: codegen 88/88 pass, then "The system cannot find the path specified." (cmd step 2 cd/launch, not a test).
- Re-ran by hand: API step 826/826 pass; DB suite T0C-SYNC-1 runs clean; codegen 88/88 pass.
- Only red: contracts/__tests__/registry-equality.test.ts "routes.yaml == IC §7" — 28 extra staff.* routes (ADMINPAGE/T0D-ACCT commits) not in spec IC §7. Pre-existing; our commits do not touch contracts/routes.yaml.
- No impl change made: not caused by SYNC-1, and fix belongs to spec IC §7 (read-only) or the routes owner. Lead decides.
