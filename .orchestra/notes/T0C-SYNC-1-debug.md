## Debugger run (T0C-SYNC-1)
- Verify log has no test failure: codegen 88/88 pass, then "The system cannot find the path specified." (cmd step 2 cd/launch, not a test).
- Re-ran by hand: API step 826/826 pass; DB suite T0C-SYNC-1 runs clean; codegen 88/88 pass.
- Only red: contracts/__tests__/registry-equality.test.ts "routes.yaml == IC §7" — 28 extra staff.* routes (ADMINPAGE/T0D-ACCT commits) not in spec IC §7. Pre-existing; our commits do not touch contracts/routes.yaml.
- No impl change made: not caused by SYNC-1, and fix belongs to spec IC §7 (read-only) or the routes owner. Lead decides.
## Round 2
- Root cause of the log's last line: T0C-SYNC-1-verify.cmd (tester file) chains `cd /d "%~dp0..\..\X"` with relative paths. Step 1 (tools/codegen) passes; step 2 `cd /d ...\..\..\contracts` then resolves from tools/codegen, path missing, so the chain stops with "The system cannot find the path specified." No test ran or failed; impl is fine.
- No impl fix possible (harness, tests off-limits). Tester must rewrite the .cmd with `pushd "%CD%"`-free absolute paths (e.g. `cd /d "%~dp0..\.."` first, then `cd tools\codegen`, `cd ..\..\contracts`). The registry-equality step would still fail (28 pre-existing routes, round 1), so lead should drop it from this verify or rule on IC §7.
## Round 3
- Re-ran verify steps by hand: codegen 88/88, contracts registry-equality 13/14. Only red: "routes.yaml == IC §7", 28 extra staff.* routes; contracts/routes.yaml last touched by T0D-ACCT-1/ADMINPAGE commits, never by SYNC-1.
- Round 2 diagnosis of the .cmd path was wrong: %~dp0 is absolute, so the cd works; the chain stops at step 2 because that test fails (the "path" line is cmd noise).
- No impl change: not SYNC-1's cause. Lead must drop registry-equality from verify.cmd or add the staff.* routes to spec IC §7 (read-only here).
