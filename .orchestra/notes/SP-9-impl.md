# SP-9 impl
- File: db/meta/decisions/SP-9.md (live run 2026-11-07: postgres:17 + PGDG PgBouncer 1.26.1, pg 8.23.1, 2 server conns, 50 clients, 1,000 txns A/B).
- Result: 0 leaks, 0 outside-txn non-NULL, 0 RLS mismatches with max_prepared_statements=200 (named + unnamed) and =0 (unnamed). Negative control set_config(..,false) caught 2000/2000.
- [CONV] Decision: max_prepared_statements = 200 for C1; with 0, named (`name:`) queries break ("prepared statement already exists").
- [CONV] T0D-03: one pool.connect client per txn, set_config(..,true) only; pool.query only for claim-free statements.
- Tests: node --test tests/spikes/*.test.mjs → 105/105 pass (SP-9 17/17).
- Open: permanent CI interleaving test (AC-0D-2.3/R-8) not built here; harness scratch dir left in %TEMP%\sp9h (rm needed approval). Not committed.
