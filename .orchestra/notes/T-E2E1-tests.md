# T-E2E1 tests — tester
- `tests/e2e/engagement-journey.static.test.mjs` (verify): nightly.yml has a C16 step running the journey (after dev:up/migrate/seed, inside the nightly job, env E2E_BASE_URL/E2E_TENANT_CODE/E2E_STAFF_TOKEN_A, no continue-on-error, no literal token), existing steps kept, journey contract, CR present. Run: `.orchestra\notes\T-E2E1-verify.cmd`.
- `tests/e2e/engagement-journey.e2e.ts` (nightly, needs compose stack): journey 1 L1 -> E2/E3 -> E14 -> C5/C6 fake events -> E22/E23 (bytes + sha256), 401/404/revoked; journey 2 E30-E33 idempotent -> C4 fake consumer -> reconcile -> completed, 409 slot race; PHI log scan.
- Implementer: add the step to `.github/workflows/nightly.yml` (e.g. `pnpm exec vitest run tests/e2e/engagement-journey.e2e.ts`), supply the three env values from secrets/job, and mount the test-support routes of `.orchestra/cr/T-E2E1.md` in compose.
- Now: static tests FAIL (no C16 step in nightly.yml). The e2e file is not run here (no stack).
- NOT covered: a real run against compose; test-support routes are a CR proposal (assumed Bearer `t.`/`c.` credentials too); the plan lists no ACs.
Review fixes applied: events now carry envelope aggregate_seq + full §3.7/§3.17 payloads; redeem #2 must be 200. CR must add `aggregate_seq` to POST /events and `centre_id`,`specimen_type_code` to /scenarios 201 (CR file not tester-owned; lead to update).
