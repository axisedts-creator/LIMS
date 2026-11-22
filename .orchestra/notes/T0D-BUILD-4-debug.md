Cause: tests/security/authz-classification.json was stale (no getMisReportPage entry; the file also lagged other wired handlers), so build4-mis-page-openapi.test.ts:201 failed.
Fix: regenerated it with `node tests/security/classify-authz.mjs > tests/security/authz-classification.json`. getMisReportPage = guarded-exact, analytics.dashboard.read. No source or test edited.
Result: build4-mis-page-openapi.test.ts 20/20 pass. Full verify chain (api, web) not re-run by me.
Note: regen also moved ~65 other entries (stale baseline vs merged main); counts guarded-exact 931 to 996, unguarded 47 to 1.

Round 2 (verify log 15:18): only failure = boot.test.ts "AN-T01 boots and mounts ... (31 of 31)", "Test timed out in 60000ms" (cold full-API boot 79-85s, reproduced alone 2x; 117 other tests and the 2nd boot test (33s) pass). Not an implementation defect: the new operation mounts nothing slow, test change vs main is count-only 30->31, and the explicit `}, 60_000)` cap pre-dates this task (vitest.config LD-110 says boot is 100-140s on the shared machine). No source change made.
Needs tester/lead: raise that per-test cap (e.g. 300_000, same as vitest.config) or rerun the verify when the machine is idle. See T0D-BUILD-4-dispute-boot-timeout.md.

Round 3: same single failure (boot.test.ts 60s cap, boot 68s). Test-only; LD-452 item (1) in ruling assigns the raise to 300000 to the TESTER. No source change; dispute-boot-timeout.md stands.
