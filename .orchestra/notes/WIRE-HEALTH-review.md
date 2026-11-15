APPROVE

Scope: diff 990055f8..HEAD touches only services/api/src/core/pipeline/healthChecks.ts (new), pipeline/boot.ts, core/bootstrap.ts, the new test file and the role notes. core/health.ts, HealthChecks, contracts, spec, migrations, env/config untouched (LD-193 scope).

Checked against LD-193 / C0 02-TRD s8:
- Rule 1: bootstrap uses `opts.healthChecks ?? pipes.healthChecks ?? UNWIRED_CHECKS`; PipelineBoot.healthChecks optional, set only when pg exists.
- Rule 2: db = `SELECT 1` through the boot's pg.query; fixed HEALTH_CHECK_TIMEOUT_MS = 2000; timer cleared in finally; losing query's rejection swallowed; ok|down only.
- Rule 3: ratelimit = one pg_catalog SELECT (pg_proc + pg_namespace, nspname 'app', proname 'ratelimit_hit', has_function_privilege(oid,'EXECUTE')); never calls app.ratelimit_hit; down without limiter (no SQL), no row, false, error, or timeout.
- Rule 4: no database => no healthChecks => UNWIRED_CHECKS, 503 down/down.
- Rule 5: in-flight promise coalesced per dependency, freed on settle, no result cache.
- Rule 6/7: warn `{event:'health_check_failed', dependency, error_class: timeout|error|unavailable}` only; no error text/host/SQLSTATE; body is status enums only; no secrets.
- RLS/permissions/idempotency/rate tier/error codes: not applicable (no table, route, permission or error code added).

Tests: health-checks.test.ts covers every item of the brief's test list (fake query, fake timers, late rejection, catalog cases, no ratelimit_hit SQL, coalescing, no DB 503, opts.healthChecks wins, enum-only body). Ran `.orchestra/notes/WIRE-HEALTH-verify.cmd` command: 13 files, 174 passed, 24 skipped, 0 failed. tsc: no errors in touched files.

Non-blocking risk (for lead, not a defect against LD-193 as written): after a 2000 ms timeout the slot is freed (test line 232 asserts this) while the timed-out pg query keeps its pool connection until pg returns. Against a network-blackholed DB a probe every ~2 s can pin one extra connection per probe up to dbPoolMax, so the "at most one connection per dependency" rationale in rule 5 holds only while queries settle. The impl note's claim "bounded to 1 per dependency by coalescing" is therefore inaccurate. Possible follow-up (needs a lead ruling, not invented here): per-query pg `query_timeout` in the boot.ts adapter so pg drops the client on timeout.
