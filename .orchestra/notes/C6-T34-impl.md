# C6-T34 impl (writer) — review pass 1 applied (items 1-10)
Files: tests/load/reporting-load.js, tests/load/README.md, tests/e2e/reporting-journey.e2e.ts, tests/e2e/README.md, .orchestra/cr/C6-T34.md (new). No test files edited; no pending.json change (no stub ops turned real, LD-70).
[CONV] Spec routes only: R2 search, R3/R4, R6 (If-Match), R7 bulk-release {ids} 200 distinct, R9 regenerations, D3 deliveries, O1/O3, N1/N2/N4, Q1 {qr_token}, portal /v1/reporting/portal/* + X-Lims-Portal-Credential; Idempotency-Key on every R op.
[CONV] k6 render timing: ready_to_rendered_ms = R9 trigger -> R3 poll sees new version rendered; render_ms = first `rendering` poll -> `rendered` (250 ms granularity). send_task_ms = D3 enqueue latency (worker metric not scraped).
CR .orchestra/cr/C6-T34.md: test-support scenarios/approve/payments/recorded-messages/qr-token/logs/seed (no catalogued register/approve/pay or recording-provider routes).
Result: `node --test tests/load/C6-T34.static.test.mjs` 28/28 pass; node --check k6 script OK; tsc --strict on journey clean (describe.sequential dropped: installed vitest lacks it; in-file order is sequential by default).
OPEN: done_when (02-TRD §11 targets at 10x seed) NOT verified — k6 15-min run + compose E2E need the stack and the CR endpoints; nightly.yml not C6-owned.
