# PG-T04 tests (tester)
- `__tests__/unit/gateways/http.redact.test.ts` — redactResponse: per-op allowlists, unknown keys, Khalti `mobile`, esewa totalAmount string, 2048-octet cap.
- `__tests__/unit/gateways/http.call.test.ts` — callGateway vs PG-T05 sims: timeouts per class, outcome mapping, sink row, log-key allowlist, no secrets/body/headers stored.
- `__tests__/unit/repository/gatewayCalls.repo.test.ts` — insertGatewayCall (fake tx): parameterised INSERT, allowlist re-applied, 64-char raw, <=2048 JSON.
- `__tests__/integration/gatewayCalls.live.test.ts` — real DB as lims_app (needs C0 DDL + LIMS_TEST_DATABASE_URL / LIMS_TEST_APP_DATABASE_URL; else skipped).
- Run: `.orchestra/notes/PG-T04-verify.cmd` (pnpm --dir services/api exec vitest run ...).
- Assumed seams (writer may dispute): see header comments of each file (`redactResponse`, `callGateway`, `insertGatewayCall`). Assumed: non-scalar values dropped, >1 MiB response -> invalid_response, ops without allowlist -> null.
