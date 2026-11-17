## Debugger run (T0C-SYNC-1)
- Verify log has no test failure: codegen 88/88 pass, then "The system cannot find the path specified." (cmd step 2 cd/launch, not a test).
- Re-ran by hand: API step 826/826 pass; DB suite T0C-SYNC-1 runs clean; codegen 88/88 pass.
- Only red: contracts/__tests__/registry-equality.test.ts "routes.yaml == IC §7" — 28 extra staff.* routes (ADMINPAGE/T0D-ACCT commits) not in spec IC §7. Pre-existing; our commits do not touch contracts/routes.yaml.
- No impl change made: not caused by SYNC-1, and fix belongs to spec IC §7 (read-only) or the routes owner. Lead decides.
## Round 2
- Root cause of the log's last line: T0C-SYNC-1-verify.cmd (tester file) chains `cd /d "%~dp0..\..\X"` with relative paths. Step 1 (tools/codegen) passes; step 2 `cd /d ...\..\..\contracts` then resolves from tools/codegen, path missing, so the chain stops with "The system cannot find the path specified." No test ran or failed; impl is fine.
- No impl fix possible (harness, tests off-limits). Tester must rewrite the .cmd with `pushd "%CD%"`-free absolute paths (e.g. `cd /d "%~dp0..\.."` first, then `cd tools\codegen`, `cd ..\..\contracts`). The registry-equality step would still fail (28 pre-existing routes, round 1), so lead should drop it from this verify or rule on IC §7.
