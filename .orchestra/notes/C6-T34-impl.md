# C6-T34 impl (writer)
Files: tests/load/reporting-load.js, tests/load/README.md, tests/e2e/reporting-journey.e2e.ts, tests/e2e/README.md. No test files edited; no pending.json change (no stub ops turned real).
[CONV] k6: 4 constant-arrival-rate scenarios (42/1m, bulk 200 ids 1/1m, 1/1s deliveries, QR 5/s) x 15m; thresholds = 02-TRD §11; setup() refuses TARGET_ENV outside staging|compose|ci and SEED_COUNT < 10000 (LD-45 pattern).
[CONV] E2E: vitest API journey, env-driven (E2E_BASE_URL, E2E_STAFF_TOKEN_A/B), recording provider + PHI scan.
Result: `node --test tests/load/C6-T34.static.test.mjs` 20/20 pass; node --check on k6 script OK.
OPEN: spec fixes only portal + POST /v1/reporting/verifications routes; staff/test-support routes (seed, recorded-messages, logs, amend, outsourced-merge, narrative/sign, release) are ASSUMED and overridable via env — need real names/test-support endpoints.
NOT RUN: k6 15-min load, compose E2E (need k6 + stack); nightly.yml not edited (not C6-owned).
