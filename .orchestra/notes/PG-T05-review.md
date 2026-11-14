APPROVE

PG-T05 review (diff c58823e1..HEAD: esewa.sim.ts, khalti.sim.ts only; both task-listed, LD-104 cited in headers).
- done_when: code:0 `{"code":0,"error_message":"Service is currently unavailable"}` (01-PRD.md:114), AMBIGIOUS verbatim, HTTP 400 `User canceled`, `{"detail":"Invalid token.","status_code":401}`, `{"detail":"Not found.","error_key":"validation_error"}` (TRD V11) all scriptable per test; status strings match TRD §7.2.4/§7.3 mapping tables.
- Self-tests: `npx vitest run src/modules/payments/__tests__/sim` -> 2 files, 53 tests passed. `tsc --noEmit` reports no errors in sim files.
- Loopback-only (127.0.0.1:0), no secrets (synthetic key lives in test), no PHI, no logging. RLS/permissions/idempotency/rate tier/error codes: N/A (test-only simulators, no routes or tables).
- Nothing invented beyond test-helper names defined by the PG-T05 test contract.
