# Staging worker (T0B-ASYNC-1, audit RS-10 / RS-11)

Jobs the API queues (for example `identity.send_invitation` from provisionTenant, `identity.send_recovery` from a password
recovery request) run only when a worker is connected to the same database. render.yaml has no worker service (a hosted
worker is a founder cost decision), so on staging the worker runs from a PC or a host you control.

## 1. Fill the task registry (once per deploy)

`app.enqueue_job` refuses any identifier without an active row in `core.g_task_registry`. Fill it for every manifest in
`services/worker/src/manifests.ts` with one command, as the migrator login (it does `SET LOCAL ROLE lims_owner`):

    pnpm --filter @lims/worker registry-sync

Environment: `LIMS_MIGRATOR_DATABASE_URL` (direct Postgres URL of the migrator login). If it is unset, the libpq `PG*`
variables are used (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`; TLS from `PGSSLMODE`). The command is
idempotent: a second run upserts the same rows and deactivates nothing. An identifier no manifest declares any more is set
`is_active = false`, never deleted.
Expected output: `registry-sync upserted <n> deactivated <m>`. A non-zero exit means nothing was committed.

The command connects with a plain pg client, not graphile-worker (T0B-ASYNC-3, LD-281): `lims_migrator` needs no rights
on schema graphile_worker for it. It reads only task identifiers, so no payments, mail, SMS or storage variable is needed:
the payments config check (`LIMS_PAYMENTS_*`) runs at worker start (step 2), not here (LD-341).

Cloud run from PowerShell (the value comes from your secret store, never from the repository):

    $env:LIMS_MIGRATOR_DATABASE_URL = <direct URL of lims_migrator from your secret store>
    pnpm --filter @lims/worker registry-sync; if ($LASTEXITCODE -ne 0) { throw "registry-sync failed" }
    Remove-Item Env:LIMS_MIGRATOR_DATABASE_URL

## 2. Run the worker

    pnpm --filter @lims/worker start

Environment variable names (set them in your shell or the host's secret store, never in the repository):

- `LIMS_CORE_ENV` (`staging`)
- `LIMS_CORE_WORKER_DATABASE_URL` (direct Postgres URL as `lims_worker`, not PgBouncer)
- `LIMS_CORE_METRICS_PORT`, `LIMS_CORE_WORKER_CONCURRENCY`, `LIMS_CORE_SHUTDOWN_GRACE_S`, `LIMS_CORE_LOG_LEVEL` (optional)
- `LIMS_CORE_EGRESS_PROXY_URL` when outbound HTTP must go through the proxy
- Payments (the worker validates the payments config at start, before it takes any job, so it refuses to start without
  them): `LIMS_PAYMENTS_PUBLIC_BASE_URL`, `LIMS_PAYMENTS_KEK_FILE`,
  `LIMS_PAYMENTS_RETURN_URL_ALLOWLIST`, `LIMS_PAYMENTS_ESEWA_FORM_URL`
- Any provider variables the module jobs read (mail, SMS, storage) as for the API.

From a PC: the database must accept direct connections from your address. Stop the worker with Ctrl+C (SIGINT drains
within `LIMS_CORE_SHUTDOWN_GRACE_S`). Liveness: `GET /health/live` on `LIMS_CORE_METRICS_PORT`.

## 3. What to look for in the logs

- API, HTTP 503 `common.service_unavailable` with an error line `enqueue_unknown_task_identifier` carrying
  `task_identifier` and `operationId`: the registry has no active row for that task. Run step 1, then retry.
- Worker: a job line for `identity.send_invitation` / `identity.send_recovery` after an invitation or a recovery request;
  failures retry and land in the dead letter after the last attempt.
- Worker exits at start with a payments config error: one of the `LIMS_PAYMENTS_*` names above is missing.
- Payments tasks fail with "runtime not bound": known gap, the payments runtime is not bound in the worker yet.

## 4. Deploy script

Add after the migrations step of push-cloud.ps1 (lead):

    pnpm --filter @lims/worker registry-sync; if ($LASTEXITCODE -ne 0) { throw "registry-sync failed" }
