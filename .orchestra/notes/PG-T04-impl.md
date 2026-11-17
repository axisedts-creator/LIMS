# PG-T04 impl (writer)
- Added `services/api/src/modules/payments/gateways/http.ts` (redactResponse, callGateway) and `repository/gatewayCalls.repo.ts` (insertGatewayCall).
- Ran vitest on unit gateways/repository + integration: 43 passed, 5 skipped (live DB, needs LIMS_TEST_DATABASE_URL/LIMS_TEST_APP_DATABASE_URL + C0 DDL). tsc: no errors in my files (pre-existing errors in contracts/shared-ts).
- [CONV] fetch with AbortController per class, redirect:'manual', 1 MiB cap -> invalid_response; sink/log failures swallowed; allowlist re-applied in repo.
- [CONV] stored JSON capped at 2000 bytes (jsonb::text adds padding vs the 2048 CHECK); 5xx -> service_unavailable, status-bearing body -> answer, esewa code:0 -> service_unavailable.
- Open: integration test not run against a real DB; sink is not wired to the repo (caller's job, later task).
