# Database runbook (`db`)

Owner C1. One section per alert in `monitoring/rules/db.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
PostgreSQL and PgBouncer run on the data role host (`prod-1` in profile `lean`, `data-1` in `full`; LD-45). Never run ad-hoc `UPDATE`/`DELETE` on application tables to "fix" an alert; row changes go through the owning module.

## PostgresDown
Severity: page   Owner: C1   Last tested: never
**Means:** the exporter reports `pg_up == 0` for 1 min.  **Impact:** SEV1 if registration/reporting stop for a tenant: every API call fails.
**Check first:** `systemctl status postgresql` and `pg_isready -h /var/run/postgresql` on the data host (expect `accepting connections`); `journalctl -u postgresql --since -15min`.
**Fix:** 1. If the service is stopped after a clean stop (patching), start it: `systemctl start postgresql`. 2. If it crash-loops, read the last log lines: disk full (`df -h /var/lib/postgresql`, see `host.md#diskfillforecast`), out of memory (`host.md#hostmemorypressure`), or corrupt WAL. 3. DESTRUCTIVE: never delete files under `pg_wal`; if WAL is corrupt or the data directory is lost, stop and follow the restore path in `dr.md` (PITR from pgBackRest; `backup.md`).
**Escalate when:** down more than 10 min -> secondary on-call and founder; data loss suspected -> SEV1, `incident-response.md`.
**Close-out:** ops log line with start/end, cause, action; incident record for any outage over 15 min.

## PostgresConnectionsHigh
Severity: warn   Owner: C1   Last tested: never
**Means:** active connections are above 80 % of `max_connections` for 5 min.  **Impact:** new connections may be refused soon; requests slow down.
**Check first:** `psql -c "select usename, state, count(*) from pg_stat_activity group by 1,2 order by 3 desc"`; `PgBouncerWaiting` firing as well?
**Fix:** 1. Find the role holding most connections (usually one service looping or a stuck worker). 2. Restart the offending container (`docker restart <name>`) if it leaks connections. 3. Do not raise `max_connections` as a first step; check PgBouncer pool sizes in the `pgbouncer` config first.
**Escalate when:** above 95 % for 10 min -> secondary on-call.
**Close-out:** ops log line with the role/service and action.

## PostgresDeadlocks
Severity: warn   Owner: C1   Last tested: never
**Means:** PostgreSQL reported at least one deadlock in the last 5 min.  **Impact:** one transaction was rolled back and retried or failed; usually invisible to users.
**Check first:** `journalctl -u postgresql --since -15min | grep -i deadlock` (the log names the two statements; they contain no row values); `psql -c "select * from pg_stat_database where datname = current_database()"`.
**Fix:** 1. Note the table names from the log and hand them to the module owner; deadlocks are code bugs. 2. If repeating more than 5 times in 5 min, find the job that runs them (`runtime.md#queuebacklog`) and pause that task.
**Escalate when:** repeating for over 30 min -> module owner via the LIMS provider on-call.
**Close-out:** ops log line with tables involved and owner informed.

## LongRunningTx
Severity: warn   Owner: C1   Last tested: never
**Means:** a transaction has been open for more than 5 min.  **Impact:** holds locks, blocks vacuum, can grow WAL and bloat.
**Check first:** `psql -c "select pid, usename, state, now()-xact_start as age, left(query,80) from pg_stat_activity where xact_start is not null order by xact_start limit 5"`.
**Fix:** 1. Identify the owner (`usename`, `application_name`). 2. If it is a known long job (migration, export), wait. 3. DESTRUCTIVE: if it is idle in transaction and blocking others, `select pg_cancel_backend(<pid>)`; use `pg_terminate_backend(<pid>)` only if cancel did not work. Never terminate a migration without the owner.
**Escalate when:** older than 30 min, or a replication slot is also retaining WAL (`ReplicationSlotWalRetained`) -> secondary on-call.
**Close-out:** ops log line with pid, role and action.

## PgBouncerWaiting
Severity: warn   Owner: C1   Last tested: never
**Means:** clients have waited for a PgBouncer server connection for 2 min.  **Impact:** requests slow down or time out.
**Check first:** `psql -h 127.0.0.1 -p <pgbouncer port> pgbouncer -c "show pools"` (look at `cl_waiting` and `sv_active`); `PostgresConnectionsHigh` firing as well?
**Fix:** 1. If PostgreSQL is not at its limit, the pool for that database is too small: raise `default_pool_size` for it in the `pgbouncer` configuration and reload (`systemctl reload pgbouncer`). 2. If PostgreSQL is saturated, find the slow query or long transaction (`LongRunningTx`). 3. A stuck client holding a connection: restart that container.
**Escalate when:** waiting longer than 15 min -> secondary on-call.
**Close-out:** ops log line with the pool setting changed (old and new value).

## ReplicationSlotWalRetained
Severity: page   Owner: C1   Last tested: never
**Means:** a replication slot retains more than 20 GB of WAL for 5 min.  **Impact:** the data disk will fill and PostgreSQL will stop (`PostgresDown`) if the slot's consumer does not catch up.
**Check first:** `psql -c "select slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) from pg_replication_slots"`; `df -h` on the WAL volume.
**Fix:** 1. Find the consumer of the slot (standby, audit logical replication to `lims_audit`; see `audit.md#auditshippingdown`) and restore it. 2. If the consumer cannot return within hours and the disk is under 20 % free: DESTRUCTIVE `select pg_drop_replication_slot('<slot>')` only after the founder or secondary approves, because the consumer must be rebuilt (standby re-basebackup or audit backfill, `audit.md`). 3. Never drop the audit slot without recording it: the audit trail would have a gap.
**Escalate when:** free space under 20 % -> secondary on-call now; under 10 % -> founder.
**Close-out:** ops log line with the slot, cause and whether it was dropped.

## PostgresInvalidIndex
Severity: page   Owner: C1   Last tested: never
**Means:** at least one index has `indisvalid = false` for 5 min (usually a failed `CREATE INDEX CONCURRENTLY`).  **Impact:** queries slower or constraints not enforced by that index.
**Check first:** `psql -c "select indexrelid::regclass, indrelid::regclass from pg_index where not indisvalid"`.
**Fix:** 1. Hand the index name to the module owner who owns that migration. 2. The owner drops and recreates it: `DROP INDEX CONCURRENTLY <name>` then the migration step again. DESTRUCTIVE: do not drop an index that backs a unique constraint without the owner.
**Escalate when:** the invalid index is on an audit or tenant-isolation table -> module owner and founder.
**Close-out:** ops log line with index name and the migration that left it.
