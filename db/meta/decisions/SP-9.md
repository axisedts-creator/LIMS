# SP-9 — Transaction-local claims through PgBouncer + node-postgres

- Date run: 2026-11-07 · Plan row: `spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md` SP-9 · 04 S8/S9, REQ-ARCH-015/016, AC-0D-2.3, 07-SECURITY AB-8, R-8
- **Outcome: pass.** Zero leaks in 1,000 interleaved transactions for tenants A and B, with and without protocol-level prepared statements.

Decision: max_prepared_statements = 200

| Item | Value |
|---|---|
| PgBouncer | `PgBouncer 1.26.1` (PGDG Debian package; must be ≥ 1.21 per 04 S8) |
| node-postgres | `pg 8.23.1` (installed with `--save-exact`) |
| PostgreSQL | 17.11 |
| pool_mode | `pool_mode = transaction` |
| Server connections | `default_pool_size = 2`, `max_db_connections = 2` (2 server connections) |
| Prepared statements | `max_prepared_statements = 200` (PgBouncer tracks named Parse/Bind statements per client and re-prepares them on whichever server connection it assigns) |
| Claims | `set_config('request.jwt.claims', $1, true)` inside `BEGIN … COMMIT` (= `SET LOCAL`); never session-level: no bare `SET`, no `set_config(…, false)` (02-CONVENTIONS lint, 04 S9) |

## Results

| Run | PgBouncer setting | Client statements | Txns | Leaks | Outside-txn non-NULL | RLS row mismatch | Errors | Backend pids / both tenants |
|---|---|---|---|---|---|---|---|---|
| 1 | `max_prepared_statements = 200` | named (protocol-level prepared) | 1000 | 0 | 0 | 0 | 0 | 2 / 2 |
| 2 | `max_prepared_statements = 200` | unnamed | 1000 | 0 | 0 | 0 | 0 | 2 / 2 |
| 3 | `max_prepared_statements = 0` (disabled) | unnamed | 1000 | 0 | 0 | 0 | 0 | 2 / 2 |
| 4 | `max_prepared_statements = 0` (disabled) | named | 1000 | 0 | — | — | 978 | 2 / 2 |
| control | `max_prepared_statements = 0` | unnamed, `set_config(…, false)` (session-level, banned) | 1000 | n/a | 2000 | 0 | 0 | 2 / 2 |

- Zero leaks with prepared statements enabled (runs 1–2): leak count 0.
- Zero leaks without prepared statements (run 3): leak count 0.
- Run 4: named statements with the setting disabled fail with `prepared statement "sp9_set" already exists` (statement created on one server connection, reused on another). So C1 must not run with 0 if any code uses `name:`.
- Control: the harness is not vacuous. With session-level `set_config(…, false)` every outside-transaction read (2000 of 2000) returned a tenant id, so a leak would be caught.

## Method

- Concurrency 50 node-postgres clients (`pg.Pool max: 50`) over 2 server connections, so transactions interleave on the same server connection. Evidence: `pg_backend_pid()` per transaction showed exactly 2 backend pids, each serving both tenant A and tenant B.
- Each transaction: `client = await pool.connect()`; `BEGIN`; `set_config('request.jwt.claims', '{"tenant_id": …}', true)`; random 0–3 ms await (yield); assert `app.current_tenant_id()` = caller tenant; RLS cross-check `SELECT tenant_id FROM app.sp9_rows` returns exactly the caller's 5 rows under a `FORCE ROW LEVEL SECURITY` policy `tenant_id = (SELECT app.current_tenant_id())` (role `lims_api`, `NOBYPASSRLS`); `COMMIT`; `client.release()`.
- Outside a transaction (autocommit), on the same client after `COMMIT` and through `pool.query`: assert `app.current_tenant_id()` is NULL and 0 RLS rows visible (AC-0D-2.3).
- Helpers copied from 02-CONVENTIONS §5.8 (`app.current_claims()`, `app.current_tenant_id()`). Tenants are synthetic uuids `00000000-0000-4000-8000-00000000000a` / `…0b`.

## node-postgres pitfalls (for T0D-03)

- One `pool.connect()` client per transaction; all statements of the txn on that `client.query`. Never `pool.query('BEGIN')`: each `pool.query` may pick a different client.
- `pool.query` is fine only for statements that need no claims (it sees NULL claims, by design).
- A `name:` (statement name) in a query config creates a protocol-level prepared statement; it needs `max_prepared_statements > 0` in PgBouncer. Statements with `values` but no `name` use the unnamed statement and work in both settings.

## Evidence

Stack: throwaway `postgres:17` container (`sha256:748a18a54d3842d43bc156f0840d78029b8d349e0feca98c12b9c4ce3404a6b3`) with `apt-get install pgbouncer`; two PgBouncer instances (ports 6432 with `max_prepared_statements = 0`, 6433 with `= 200`), `auth_type = trust` on loopback, synthetic data only. Node 25.8.0. Container removed afterwards; harness `run.mjs` lived in a scratch dir outside the repo (the permanent CI test replaces it).

```sh
$ pgbouncer --version
PgBouncer 1.26.1
libevent 2.1.13-stable
$ psql -h 127.0.0.1 -p 6433 -U lims_api lims -Atc 'select version()'
PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu, ...
$ node -p "require('pg/package.json').version"
8.23.1
$ node run.mjs 56433 named
{"mode":"named","pg":"8.23.1","txns":1000,"concurrency":50,"leaks":0,"outsideNonNull":0,"rlsMismatch":0,"errors":0,"distinctBackendPids":2,"pidsServingBothTenants":2}
$ node run.mjs 56432 unnamed
{"mode":"unnamed","pg":"8.23.1","txns":1000,"concurrency":50,"leaks":0,"outsideNonNull":0,"rlsMismatch":0,"errors":0,"distinctBackendPids":2,"pidsServingBothTenants":2}
```

## Hand-off

- **C1** PgBouncer settings: `pool_mode = transaction`, `max_prepared_statements = 200`, version pinned at ≥ 1.21 (tested 1.26.1). Workers and migrations stay on direct connections (04 S8).
- **T0D-03** is gated by this record: transaction wrapper uses one client per txn and `set_config(…, true)` only.
- The interleaving check is kept as a permanent CI test (AC-0D-2.3, AC-0B-3.7, AB-8, R-8): same workload against the CI PgBouncer.
- Failure path: if a leak is ever seen, it fails the spike and CI; fallback is "unnamed only" (`max_prepared_statements = 0`, ban `name:`) plus a CR.
