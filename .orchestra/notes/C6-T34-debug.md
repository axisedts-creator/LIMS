# C6-T34 debug
Cause: harness files (tests/load/reporting-load.js, tests/e2e/reporting-journey.e2e.ts) never received the review fixes 1-10 (writer's review-fix commit touched only the CR + impl note), so 8 spec-name pins failed.
Fix: rewrote both to catalogued routes (R2/R3/R4/R6/R7 bulk-release {ids}/R9/R17/D3/O1-O3/N1-N4/Q1 qr_token, portal /v1/reporting/portal + X-Lims-Portal-Credential), Idempotency-Key, held-dues asserts, OTP in PHI scan, setup throws on empty qr tokens; test-support routes per CR; CR seed min count 200.
Result: node --test tests/load/C6-T34.static.test.mjs 28/28. NOT run: k6 load, compose E2E (need stack + CR endpoints); done_when at 10x seed stays OPEN.

## Round 2
Cause: round-1 note claimed a harness rewrite but its commit held only the CR + note; tests/load/reporting-load.js and tests/e2e/reporting-journey.e2e.ts were still the old files (8 pins failed).
Fix: actually rewrote both to catalogued routes: R7 bulk-release {ids} (200 distinct) + Idempotency-Key, R9 regenerations + R3 poll for renders, D3 {recipient_kind, channel}, Q1 {qr_token}, portal /v1/reporting/portal/ + X-Lims-Portal-Credential + challenge_id, held-dues asserts (release_blocked_due, link_purpose, balance_due_paisa), R2 search, OTP in PHI scan, setup throws on empty qr_tokens; test-support routes per the CR.
Result: node --test tests/load/C6-T34.static.test.mjs 28/28; tsc strict on the e2e file clean apart from missing @types/node. NOT run: k6, compose E2E (no stack); done_when at 10x seed stays OPEN.

## Round 3
Cause: the 8 failing pins are all in tests/load/reporting-load.js + tests/e2e/reporting-journey.e2e.ts. Both are TRACKED files under tests/, so run.ps1 Enforce (TestPat matches "tests/", not new, not TestExempt) reverts every writer/debugger edit: rounds 1-2 rewrites were silently discarded (files last changed in 19643945).
Fix: none possible from debugger role. Route harness rewrite to TESTER (apply review fixes 1-10 per round-2 note: R7 bulk-release {ids}+Idempotency-Key, D3, Q1 qr_token, /v1/reporting/portal/ + X-Lims-Portal-Credential, held-dues asserts, R2 search, OTP in PHI scan, empty-qr_tokens throw), or lead adds tests/load + tests/e2e harness files to TestExempt. Static test is spec-correct: no dispute.
Result: node --test tests/load/C6-T34.static.test.mjs still 20/28 (unchanged tree).

## Round 4
Cause: unchanged. 8 failing pins target tests/load/reporting-load.js + tests/e2e/reporting-journey.e2e.ts; both match run.ps1 $TestPat and are not in $TestExempt (line 42), so any debugger/writer edit is reverted. No implementation file exists to fix.
Fix: none from this role. Lead must either add `^tests/(load|e2e)/(?!.*\.test\.)` to $TestExempt or have the TESTER apply review items 1-10 (content in round 2). Static test is spec-correct; see C6-T34-dispute.md.
Result: node --test tests/load/C6-T34.static.test.mjs 20/28 (unchanged tree). k6 and compose E2E not run.
