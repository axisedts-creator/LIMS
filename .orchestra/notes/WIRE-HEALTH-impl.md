# WIRE-HEALTH impl (writer)
- New: services/api/src/core/pipeline/healthChecks.ts `createHealthChecks({ query, limiterConfigured, log? })` (interface as assumed by tests).
- boot.ts: PipelineBoot.healthChecks (only with a database; same pg.query, lazy, no SQL at boot). bootstrap.ts: opts.healthChecks ?? pipes.healthChecks ?? UNWIRED_CHECKS.
- [CONV] db = `SELECT 1`; ratelimit = one pg_catalog pg_proc + has_function_privilege(oid,'EXECUTE') SELECT (schema app, name ratelimit_hit); ok only if >=1 row and every row can_execute===true; no limiter => down without SQL.
- [CONV] 2000 ms fixed constant, timer cleared, losing query's rejection swallowed, in-flight promise per dependency coalesced and freed on settle (no result cache).
- [CONV] one warn per failed in-flight check: {event:'health_check_failed', dependency, error_class: timeout|error|unavailable}; no error text/host/SQLSTATE.
- Ran: pipeline __tests__ + core health.test.ts + staging-boot: 13 files, 174 passed, 24 skipped, 0 failed; tsc: no errors in touched files.
- Open: a timed-out query still holds its pool connection until pg returns; bounded to 1 per dependency by coalescing. No live DB run (needs staging).
