# SP-2 — Graphile Worker 0.18.0 least-privilege + `add_job` mapping

- Date run: 2026-11-06 · Plan row: `spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md` SP-2 · 04 D6, IC §12, 08 A25 D-201, 07-SECURITY §6, REQ-ARCH-042
- **Outcome: partial.** The worker runtime runs **no DDL** (schema current), `lims_api` can enqueue **only** through `app.enqueue_job` (direct `add_job` denied), and `job_key` dedupe with `unsafe_dedupe` works as documented. But the worker **needs** the ownership rights it inherits from `lims_queue`: every `graphile_worker._private_*` table has RLS enabled with zero policies, so only the owner can use them. A DML-only role was tested and fails. Residual privilege below. It is recorded in `services/worker/src/core/DECISIONS.md`, needs a line in 07-SECURITY §6 (D-201), and goes to CV §5.9 as a CR (`.orchestra/cr/SP-2.md`).

## Decision

| Item | Value |
|---|---|
| Version | `graphile-worker@0.18.0` (npm); schema migration id after install = 20 |
| Schema install | as `lims_migrator`, on a **direct** connection (not PgBouncer), session role `lims_queue` set by `PGOPTIONS='-c role=lims_queue'`, **between** the D-201 grant and revoke: `PGOPTIONS='-c role=lims_queue' graphile-worker --schema-only -c postgres://lims_migrator@<host>:<port>/<db>` (password from `PGPASSWORD` / secret store, never in the DSN) |
| D-201 window shape | The install runs on its own connection, so the grant must be **committed** first. Order: (1) migration commits `GRANT CREATE ON DATABASE … TO lims_queue` + `GRANT CREATE ON SCHEMA app TO lims_queue`; (2) runner runs the install command; (3) migration creates `app.enqueue_job` / `app.queue_depth` as `lims_queue`, then revokes both CREATEs. It cannot be one transaction as the 05-SCHEMA §10 comment implies. The runner must re-run the revokes if step 2 or 3 fails (else CREATE stays standing). After step 3: `has_database_privilege('lims_queue', db, 'CREATE') = f`, `has_schema_privilege('lims_queue','app','CREATE') = f` (verified). |
| Ownership after install | schema `graphile_worker`, all its tables/views/sequences/types/functions: owner `lims_queue` |
| `graphile_worker.jobs` | a **view**; columns: `id, queue_name, task_identifier, priority, run_at, attempts, max_attempts, last_error, created_at, updated_at, key, locked_at, locked_by, revision, flags` (no payload). `app.queue_depth()` columns `task_identifier, run_at, locked_at, attempts, max_attempts` confirmed; body works unchanged as `lims_worker`. |
| `graphile_worker.add_job` | `(identifier text, payload json, queue_name text, run_at timestamptz, max_attempts integer, job_key text, priority integer, flags text[], job_key_mode text) RETURNS graphile_worker._private_jobs`, SECURITY INVOKER. `max_attempts` is `integer` in 0.18.0 (05-SCHEMA's `::smallint` cast still works; can be dropped). `job_key_mode` ∈ `replace`, `preserve_run_at`, `unsafe_dedupe` (else error `GWBKM`). The 05-SCHEMA §10 `app.enqueue_job` body was created and run unchanged. |
| `unsafe_dedupe` | `INSERT … ON CONFLICT (key) DO UPDATE SET revision = revision + 1, updated_at = now()`. Payload, `run_at`, `attempts` are unchanged; NOTIFY only on a real insert. Verified: a second enqueue with the same key leaves a single job (first payload kept), and re-enqueue of a **permanently failed** job keeps `attempts = 2/2` (no reset). Side effect: a permanently failed keyed job blocks that key until the row is deleted. |
| Completed jobs | **deleted** (`complete_job` = `DELETE FROM _private_jobs`); verified, row gone. Permanently failed jobs are **kept** (`attempts >= max_attempts`) until cleanup (`graphile-worker --cleanup DELETE_PERMAFAILED_JOBS` / `cleanup()`). |
| Permanent failure detection | Both work: the events API emits `job:failed` right after `job:error` on the final attempt; inside the handler `helpers.job.attempts >= helpers.job.max_attempts` is already true on the final attempt (attempts is incremented at lock). [CONV] T0D-09 dead-letter wrapper uses the in-handler attempts check before rethrow: it runs inside the job with its context and can be awaited. EventEmitter listeners are not awaited. |
| Backoff (built-in, not overridden) | `run_at = greatest(now(), run_at) + exp(least(attempts, 10)) * interval '1 second'` (attempt 1 → e¹ ≈ 2.7 s, cap e¹⁰ ≈ 6.1 h). Retries have a future `run_at`, so no NOTIFY; they are found by polling (`pollInterval`, default 2000 ms). |
| Crontab | supplied from code: `run({ parsedCronItems: parseCronItems([{ task, match, identifier, options, payload }]) })` was accepted and registered (`_private_known_crontabs` row `sp2.cron`). The **text** crontab syntax rejects `.` in task names (`CRONTAB_COMMAND = /^([_a-zA-Z][_a-zA-Z0-9:/_-]*)…/`), so LIMS identifiers like `core.retention_purge` must use `parsedCronItems`, not a crontab string (REQ-ARCH-042). |
| LISTEN/NOTIFY | worker runs `LISTEN "jobs:insert"; LISTEN "worker:migrate";` on its **direct** connection. A job enqueued via `app.enqueue_job` as `lims_api` was picked up in 16 ms with `pollInterval: 60000`, so NOTIFY works. |
| Worker startup DDL | none: as `lims_worker` the statement log shows no CREATE/ALTER/DROP/GRANT; startup only reads `server_version_num` and `max(id)` from `graphile_worker.migrations`, inserts task names into `_private_tasks` (DML), and LISTENs. |

## Residual privilege (why partial)

`lims_worker` is in `lims_queue` `WITH INHERIT TRUE` (05-SCHEMA §1). It therefore holds the owner rights on the queue objects. Probed as `lims_worker` (each in a rolled-back transaction):

| Statement | Result |
|---|---|
| `CREATE TABLE graphile_worker.sp2_probe(i int)` | succeeds (residual) |
| `ALTER TABLE graphile_worker._private_jobs ADD COLUMN …` | succeeds (residual) |
| `ALTER FUNCTION app.enqueue_job(...) SECURITY INVOKER` | succeeds (residual; also DROP) |
| `CREATE FUNCTION app.sp2_probe() …` | `permission denied for schema app` |
| `CREATE SCHEMA sp2_probe` | `permission denied for database lims` |

Alternative tested: a synthetic login with only `lims_app` plus `USAGE` on `graphile_worker` and `SELECT, INSERT, UPDATE, DELETE` on all its tables. All five DDL probes were denied. But the worker could not run: `new row violates row-level security policy for table "_private_known_crontabs"`, and no job was picked up. The `_private_*` tables have `relrowsecurity = t` with 0 policies. Adding policies would change the vendor schema, so it was rejected. Decision: keep the 05-SCHEMA §1 membership and record the residual (no extra CREATE anywhere; ownership limited to `graphile_worker` objects and the two `app` wrappers).

## Evidence

Stack: throwaway `postgres:17` container (`sha256:748a18a54d3842d43bc156f0840d78029b8d349e0feca98c12b9c4ce3404a6b3`) on `127.0.0.1:55432`, `log_statement = all`, `log_line_prefix = 'U=%u '`. Roles and grants copied from 05-SCHEMA §1 / `01_database.sql`. Synthetic stubs: `core.g_task_registry` rows `sp2.ok` (max 3), `sp2.fail` (max 2), `platform` scope; `app.current_tenant_id()`. Node 25.8.0, `graphile-worker@0.18.0`, `pg`. Synthetic payloads only. Container and scratch files removed afterwards.

Commands:

```sh
docker run -d --name sp2_pg -p 127.0.0.1:55432:5432 postgres:17
psql -U postgres -f 01_setup.sql                       # roles per 05-SCHEMA §1, CREATE DATABASE lims, 01_database grants
psql -U lims_migrator -d lims -f 02_schemas.sql        # SET ROLE lims_owner; schemas; stubs; D-201 grants (committed)
PGOPTIONS='-c role=lims_queue' graphile-worker --schema-only -c postgres://lims_migrator@127.0.0.1:55432/lims
psql -U lims_migrator -d lims -f 04_wrapper.sql        # 05-SCHEMA §10 enqueue_job + queue_depth as lims_queue; revoke CREATEs
psql -U lims_api -d lims -f 05_api.sql                 # direct add_job, SELECT jobs, enqueue_job x4
node worker.mjs lims_worker                            # run({ taskList, parsedCronItems, pollInterval: 60000 }) + events
psql -U lims_worker -d lims -f 06_probe.sql            # DDL probes (rolled back)
node worker.mjs sp2_worker_dml                         # DML-only alternative
docker logs sp2_pg | grep 'U=lims_worker'              # statement log
```

Output (trimmed):

```text
install: exit 0 "Schema updated"
graphile_worker owner: lims_queue (tables, views, sequences, types, functions)
after revoke: q_db_create_after = f, q_app_create_after = f
lims_api> SELECT graphile_worker.add_job('sp2.ok','{}')     ERROR: permission denied for schema graphile_worker
lims_api> SELECT count(*) FROM graphile_worker.jobs          ERROR: permission denied for schema graphile_worker
lims_api> SELECT app.enqueue_job('sp2.nope','{}')            ERROR: unknown_task_identifier
lims_api> app.enqueue_job('sp2.ok',{"n":1},'k1'); app.enqueue_job('sp2.ok',{"n":2},'k1')
jobs: id 1 sp2.ok key k1 attempts 0/3 revision 1 payload {"n": 1}   -- one job, first payload kept
worker (lims_worker):
  ok {"n":1} key k1 -> Completed task 1 (row deleted)
  fail attempt 1 of 2 final? false ; EVENT job:error sp2.fail 1/2
  fail attempt 2 of 2 final? true  ; EVENT job:error sp2.fail 2/2 ; EVENT job:failed (permanent) sp2.fail kf 2/2
  NOTIFY latency ms (pollInterval 60000): 16
  queue_depth as lims_worker: [{"task_identifier":"sp2.fail","ready":"0","locked":"0","failed":"1"}]
  after re-enqueue kf (unsafe_dedupe): [{"key":"kf","attempts":2,"max_attempts":2,"revision":1}]
  known crontabs: [{"identifier":"sp2.cron"}]
statement log U=lims_worker CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT|TRUNCATE: 0
statement log U=lims_worker: LISTEN "jobs:insert"; LISTEN "worker:migrate";
parseCrontab('*/5 * * * * sp2.ok …') -> Error: Invalid command specification in line 1 of crontab.
sp2_worker_dml: Cron hit an error … new row violates row-level security policy for table "_private_known_crontabs"; NOTIFY latency: NOT PICKED UP
pg_class graphile_worker._private_{jobs,job_queues,tasks,known_crontabs}: relrowsecurity t, policies 0
```

## Open points

- 05-SCHEMA §10 comment "(graphile_worker schema installation by the runner happens here)" sits inside one `SET LOCAL ROLE` transaction. SP-5 / the runner must split it into the three-step window above (CR `.orchestra/cr/SP-2.md`).
- Who deletes permanently failed jobs after the dead-letter wrapper has copied them to `core.dead_letters` (T0D-09: `cleanup({ tasks: ['DELETE_PERMAFAILED_JOBS'] })` in `core.retention_purge` is the obvious slot). Until then they count as `failed` in `app.queue_depth()` and block their `job_key`.
- Spike ran on stock `postgres:17`, not `supabase/postgres:17.6.1.136`, and without PgBouncer. Re-check the install on the pinned image in T0A-09.
