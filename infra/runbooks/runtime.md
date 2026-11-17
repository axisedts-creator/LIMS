# Runtime runbook (`runtime`)

Owner C1. One section per alert in `monitoring/rules/runtime.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2). Imported module runbooks link here for `WorkerDown` and `QueueBacklog`.
Containers run on the app role host (`prod-1` in profile `lean`, `app-1` in `full`; LD-45). Container names come from `docker ps`.

## WorkerDown
Severity: page   Owner: C1   Last tested: never
**Means:** a worker container is down for 2 min (`up{service=~"worker.*"} == 0`).  **Impact:** background jobs (reports, imports, event fan-out) stop; users see stale results.
**Check first:** `docker ps -a --filter name=worker` (state and exit code); `docker logs --tail 50 <name>`.
**Fix:** 1. A restart usually works: `docker restart <name>` (workers are stateless; jobs are retried). 2. If it crash-loops, read the last log lines: bad config after a deploy (`DeployRolledBack` may follow), database unreachable (`db.md#postgresdown`), out of memory (`host.md#hostmemorypressure`). 3. Never delete the job table rows by hand.
**Escalate when:** down over 15 min, or dead letters appear -> the C2 platform console (dead letters) and the module owner; secondary on-call.
**Close-out:** ops log line with container, cause, action.

## QueueBacklog
Severity: warn   Owner: C1   Last tested: never
**Means:** a queue holds more than 500 jobs for 10 min.  **Impact:** delays in reports, notifications or imports for the tasks in that queue.
**Check first:** Grafana D4 (`lims_queue_depth{task}`, `lims_jobs_total`); `docker logs --tail 50 <worker>` for errors.
**Fix:** 1. If the workers are healthy but busy, wait or add a worker replica if the memory budget allows (`host.md#hostmemorypressure`). 2. If one task fails and retries, hand the task name to its owner; dead letters are handled in the C2 console. 3. If `WorkerDown` is firing, fix that first.
**Escalate when:** backlog still growing after 30 min -> secondary on-call and the task owner.
**Close-out:** ops log line with the task, peak depth, cause.

## RendererRestarting
Severity: warn   Owner: C1   Last tested: never
**Means:** a renderer or pdf-sandbox container restarted more than 3 times in an hour.  **Impact:** report PDFs are delayed or fail; C6 raises its own `ReportingRendererDown` if it stays down.
**Check first:** `docker ps -a --filter name=renderer`; `docker inspect <name> --format '{{.State.OOMKilled}} {{.RestartCount}}'`; Grafana D10 (memory vs limit).
**Fix:** 1. `OOMKilled true`: the template or input is too large; hand the failing report type to C6. Do not raise the memory limit above the budget without a decision (renderer 1.5 GiB, sandbox 512 MiB). 2. Crash on start: check the image digest of the last deploy and consider `infra/ci/rollback.sh` (`deploy.md`). 3. Do not give the renderer network access to make it work.
**Escalate when:** restarts continue for over 1 h -> C6 owner through the LIMS provider on-call.
**Close-out:** ops log line with container, cause, and hand-off.

## ScannerDown
Severity: page   Owner: C1   Last tested: never
**Means:** the malware scanner (clamd) is down for 1 min.  **Impact:** uploads are quarantined or refused (fail closed); no file is released unscanned.
**Check first:** `docker ps -a --filter name=clamd`; `docker logs --tail 50 <name>`; `docker stats --no-stream` (clamd needs about 3 GiB in profile lean).
**Fix:** 1. `docker restart <name>`; start-up loads signatures and can take minutes. 2. If it is killed by memory, see `host.md#hostmemorypressure`. 3. Do not disable scanning or let uploads through to clear the alert.
**Escalate when:** down over 30 min -> secondary on-call (lab uploads blocked).
**Close-out:** ops log line with the outage window and cause.

## ScannerSignaturesStale
Severity: warn   Owner: C1   Last tested: never
**Means:** scanner signatures are older than 3 days.  **Impact:** newer malware may not be detected.
**Check first:** `docker exec <clamd> freshclam --version` and the signature date; `docker logs <freshclam container or clamd> | grep -i update`.
**Fix:** 1. Updates go through the ops proxy mirror: check the egress allow list entry and `edge.md#egressdenied`. 2. Run the update: `docker exec <name> freshclam`. 3. If the mirror is down, record it and retry later; do not open direct egress.
**Escalate when:** over 7 days stale -> secondary on-call.
**Close-out:** ops log line with signature date after the fix.

## StudioEnabled
Severity: info   Owner: C1   Last tested: never
**Means:** Supabase Studio is enabled (break-glass). It must be off after use.  **Impact:** an admin UI is reachable on the ops network; SEV4.
**Check first:** who enabled it: `ops_audit` entry from the break-glass playbook; `docker ps --filter name=studio`.
**Fix:** 1. If the work is finished, disable it with the break-glass procedure (`studio.md`). 2. If nobody enabled it, treat it as a security event: `incident-response.md`.
**Escalate when:** enabled over 8 h or without a record -> secondary on-call.
**Close-out:** ops log line with the disable time.

## ValkeyDown
Severity: page   Owner: C1   Last tested: never
**Means:** Valkey (the rate-limit backend) is down for 1 min.  **Impact:** logins and OTP fail closed: users cannot sign in or verify codes.
**Check first:** `docker ps -a --filter name=valkey`; `docker exec <name> valkey-cli ping` (expect `PONG`).
**Fix:** 1. `docker restart <name>`. There is no state to restore: counters restart from zero. 2. If it will not start, read `docker logs --tail 50 <name>` (memory limit 0.3125 GiB, config path). 3. Never disable rate limiting in nginx or the API to let logins through.
**Escalate when:** not back in 10 min -> secondary on-call (SEV2; sign-in is blocked).
**Close-out:** ops log line with the outage window.

## DeployRolledBack
Severity: page   Owner: C1   Last tested: never
**Means:** `infra/ci/rollback.sh` rolled back a deploy in the last 10 min (smoke test failed or manual rollback).  **Impact:** the previous version is running; the new release is not live.
**Check first:** the deploy log (`deploy.md`) and the smoke output; `docker ps --format '{{.Names}} {{.Image}}'` (image digests should match the previous release).
**Fix:** 1. Confirm service is healthy on the old version (`Edge5xxRate` quiet). 2. Read why the smoke test failed and hand the failure to the release owner. 3. Do not retry the same release before the cause is understood; a stuck environment lock is handled in `deploy.md`.
**Escalate when:** the rollback itself failed or left mixed versions -> secondary on-call.
**Close-out:** ops log line with release id, reason, and the ticket for the fix.
