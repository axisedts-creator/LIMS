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
## Round 4
- Cause: registry-equality "routes.yaml == IC §7" was red only for 28 staff.* routes missing from IC §7 (LD-337). Spec commit e4f095ae (in this branch) adds them; re-ran registry-equality now: 14/14 green. Codegen 88/88 green; API 826/826 and DB suite clean in rounds 1-3.
- No impl change needed; SYNC-1 code was never at fault. Verify should now pass end to end.
## Round 5
- Re-ran contracts registry-equality on this branch (includes spec e4f095ae, LD-337): 14/14 green. The log line "cannot find the path" is cmd noise after step 1; no test failed on SYNC-1 code.
- No impl change needed. Earlier rounds: codegen 88/88, API 826/826, pgTAP clean. Could not rerun the full verify.cmd here (command approval denied).
## Round 6
- Log (20:55) ends after step 1 (codegen 88/88) with "The system cannot find the path specified."; no test failed. registry-equality now 14/14 green here (spec e4f095ae in branch, LD-337).
- Likely harness cause: T0C-SYNC-1-verify.cmd runs `npx`/`pnpm` (.cmd shims) without `call`, so cmd transfers control and the batch ends/errs after step 1. Tester file, off-limits for me; fix = prefix each npx/pnpm with `call`.
- No impl change: SYNC-1 code not at fault (codegen 88/88, API 826/826, pgTAP clean in earlier rounds).
## Round 7
- verify.cmd now has `call` on every npx/pnpm line and absolute-%~dp0 cd (tester rewrite per LD ruling); the log still holds the old run (one line, "cannot find the path"), no test failed.
- No impl change: SYNC-1 code not at fault (codegen 88/88, API 826/826, pgTAP clean, registry-equality 14/14). Rerun verify to refresh the log.
## Round 8
- Log (21:52) is still the old one-line "The system cannot find the path specified."; no test failed. Cause: old verify.cmd ran npx/pnpm without `call`; tester rewrite (call prefix + cd /d) is in place.
- No impl change: SYNC-1 code not at fault (codegen 88/88, API 826/826, pgTAP clean, registry-equality 14/14). Could not rerun verify.cmd here (command approval denied); lead/queue must rerun it to refresh the log.
## Round 9
- Cause: old verify.cmd ran npx/pnpm without `call`, batch ended after step 1 ("cannot find the path"); log is stale, no test failed.
- Fix (tester, already in place): verify.cmd has `call` on every npx/pnpm line, `cd /d` first, all 5 steps kept. Debugger changes no file per ruling.
- SYNC-1 code not at fault (codegen 88/88, API 826/826, pgTAP clean, registry-equality 14/14). Rerun verify to refresh log.
## Round 10 (single-line verify.cmd now runs; real failure)
- Log: registry-equality 12/14. Red: `errors.yaml == IC §8` (7 extra codes engagement.broadcast_* x6, partners.ticket_invalid_transition) and `permissions.yaml == IC §11` (partner role has partners.ticket.read/manage). Both come from T0C-MSGDESK-1 (lane C0-0C) via the main merge; IC §8/§11 and the test allow-lists (registry-equality.test.ts:100,193) lack them. SYNC-1's 5 codes and 3 permissions pass.
- No impl change: removing the MSGDESK codes would violate LD-330 (keep both sides). Test is stale, off-limits for me: see T0C-SYNC-1-dispute.md. Lead: add MSGDESK allow-list to the test or the codes to IC §8/§11 (as LD-337), or run only `-t` cases for SYNC-1 in verify.
