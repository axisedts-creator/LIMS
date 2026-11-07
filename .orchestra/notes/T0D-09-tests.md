# T0D-09 tests (tester)
Files: services/worker/src/core/__tests__/{helpers.ts, fanout,consumer,deadletter,cron,retention,registry-sync}.test.ts. Run: `.orchestra\notes\T0D-09-verify.cmd` (root vitest, `--root services/worker`; worker has no package.json yet). Now: 67/67 fail on missing `../tasklist.js` / `../registry-sync.js`.
Covers AC-0D-5.4/5.5/5.6/5.15/5.16, job_key copy (A23.2), platform DL via `app.dl_insert_platform`, AB-22 payload leak, JobContext storage/files/audit, fault-injected-clock capped resume (D-200).
Assumed seams (spec gives shapes, not constructors): `tasklist.ts` `buildTaskList(deps, manifests)` -> `{ taskList, registry[{identifier,module,kind:'core'|'task'|'consumer',scope,maxAttempts}], taskOptions, cronItems[{task,match}], cronTick(identifier, Date) }`; `taskList[id](payload, helpers)` Graphile-style (`helpers.job.{id,key,attempts,max_attempts}`); rejects bad manifests (subscription not in EVENT_CONSUMERS, task outside module namespace, taskOptions > 300000, unknown/ill-formed crontab).
deps: `{ db.tx({claims,statementTimeoutMs,operation}, fn(tx)), withTenantScope(tx,tenantId,actorId,fn) (4-arg, A23.2), systemActorOf(module), coreActorId, metrics{inc,set,observe}, log, now(), events, core, storage, files, audit }`. `registry-sync.ts` `syncRegistry(client{query}, registryEntries)`.
SQL assumptions: `app.enqueue_job` args positional (identifier, payload, job_key, run_at, max_attempts); `app.dl_insert_platform` 8 positional args; tenant DL = `INSERT INTO core.dead_letters (cols) VALUES ($n..)`; purge metric `table` label = function suffix (idempotency_keys, event_log, event_inboxes, dead_letters, ratelimit_counters); cron minute key = `YYYY-MM-DDTHH:mm` UTC.
Not verifiable here (no DB): real RLS/DEFINER behaviour, real Graphile attempts semantics, the fake itself is unvalidated against an implementation (fix the fake, not the spec, if it mis-models SQL). Not covered: replay.ts CLI, storage/uploads adapters, bootstrap/main.
Logger scrubber is not exported by shared-ts; deadletter.test expects the redaction effect only.

## Review round (items 1-2; item 3 is a CR, no tests)
- consumer.test.ts: +3 tests (x-extensible entity_type future value reaches handler once; 2 controls). Fails now: envelope violates its schema.
- tenant-scope.test.ts (new): 4-arg withTenantScope claims/restore/throw/nested/non-UUID. Fails now: ../tenant-scope.js missing.
- Same verify cmd: T0D-09-verify.cmd. Current: 2 files failed, 1 test + 1 suite fail, 69 pass.
