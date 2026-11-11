# C6-T34 debug
Cause: harness files (tests/load/reporting-load.js, tests/e2e/reporting-journey.e2e.ts) never received the review fixes 1-10 (writer's review-fix commit touched only the CR + impl note), so 8 spec-name pins failed.
Fix: rewrote both to catalogued routes (R2/R3/R4/R6/R7 bulk-release {ids}/R9/R17/D3/O1-O3/N1-N4/Q1 qr_token, portal /v1/reporting/portal + X-Lims-Portal-Credential), Idempotency-Key, held-dues asserts, OTP in PHI scan, setup throws on empty qr tokens; test-support routes per CR; CR seed min count 200.
Result: node --test tests/load/C6-T34.static.test.mjs 28/28. NOT run: k6 load, compose E2E (need stack + CR endpoints); done_when at 10x seed stays OPEN.
