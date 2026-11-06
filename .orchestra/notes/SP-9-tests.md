# SP-9 tests
- File: tests/spikes/SP-9.decision.test.mjs (node:test, no deps; same layout as SP-5/8)
- Run: `node --test tests/spikes/SP-9.decision.test.mjs`
- Checks db/meta/decisions/SP-9.md: Decision (max_prepared_statements=N>0 | "unnamed only"), PgBouncer >=1.21.0 + pg x.y.z pinned with version output, pool_mode transaction + 2 server conns, 1,000 interleaved txns tenants A/B, app.current_tenant_id() each txn, NULL outside txn, zero leaks in BOTH modes, set_config(..,true)/SET LOCAL only, shared-backend-pid evidence, RLS cross-check, C1/T0D-03 hand-off, permanent CI test, no secrets.
- Expected now: all fail with "db/meta/decisions/SP-9.md must exist".
- Live PgBouncer run not unit-testable here; record checked structurally only.
