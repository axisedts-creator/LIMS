# WIRE-HEALTH tests (tester)
- New: services/api/src/core/pipeline/__tests__/health-checks.test.ts (fake query + fake `pg`, fake timers, no network).
- Covers: db ok/down/2000 ms timeout/late rejection/timer cleared; ratelimit catalog ok/down (no row, false, error, no limiter), never calls app.ratelimit_hit; one in-flight query per dependency, no result caching; no leaks in result/logs; boot + bootstrap readiness (no DB stays 503, opts.healthChecks wins).
- ASSUMED interface (dispute via WIRE-HEALTH-dispute-*.md): `createHealthChecks({ query, limiterConfigured, log? })` exported from pipeline/healthChecks.ts; catalog statement returns 0 rows if the function is missing, else one row `{ can_execute: boolean }`; bootPipeline returns optional `healthChecks`.
- Run: `.orchestra/notes/WIRE-HEALTH-verify.cmd` (also runs the pipeline stage tests incl. identity-db-handoff, core health.test.ts, staging-boot).
- Expected now: health-checks.test.ts fails (healthChecks.js missing; no real checks from boot/bootstrap); existing suites stay green.
