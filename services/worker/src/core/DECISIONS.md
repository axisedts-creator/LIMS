# Worker core decisions

## SP-2 — Graphile Worker 0.18.0 (outcome: partial)

Full record: `db/meta/decisions/SP-2.md`.

- **Residual privilege (07-SECURITY §6, D-201):** `lims_worker` inherits `lims_queue` (05-SCHEMA §1). It can therefore CREATE/ALTER/DROP objects in schema `graphile_worker` and ALTER/DROP `app.enqueue_job` / `app.queue_depth`. It has no CREATE on `app`, on any other schema, or on the database. This is needed because the `graphile_worker._private_*` tables have RLS on and no policies, so only the owner can use them (a DML-only role was tested and fails). The worker **runs** no DDL at startup when the schema is current. CR to CV §5.9: `.orchestra/cr/SP-2.md`.
- Schema install is a migration-runner step (`PGOPTIONS='-c role=lims_queue' graphile-worker --schema-only`, as `lims_migrator`, direct connection), never done at worker start.
- Cron: pass `parsedCronItems: parseCronItems([...])` from code. The text crontab syntax rejects `.` in task identifiers.
- Permanent failure: the dead-letter wrapper checks `helpers.job.attempts >= helpers.job.max_attempts` before rethrow [CONV]. The `job:failed` event also fires, but its listeners are not awaited.
- Backoff: built-in `exp(least(attempts, 10))` seconds. Retries are found by polling (`pollInterval`), not NOTIFY.
- Completed jobs are deleted by Graphile Worker. Permanently failed jobs stay until `DELETE_PERMAFAILED_JOBS` cleanup.
