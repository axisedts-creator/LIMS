# T0D-10 impl (writer)
- New: `core/observability/{metrics,logging,tracing}.ts`, `core/health.ts`. Changed: `bootstrap.ts` (healthChecks/logStream, app.metrics, core.yaml mounted when repoRoot is default), `config.ts` (metricsPort), `openapi.ts` (route config.module, error_code from x-error-codes for non-Problem results), `errors.ts` (setErrorCode), `module.ts` (loadSpec bundles `_common.yaml#` refs), `package.json` (prom-client 15.1.3, CR-C0-0D-004 for lockfile).
- Fastify logger = `@lims/shared-ts/logger` via a pino-signature adapter (CV §9.1/§9.2 scrubbing reused); trace_id/span_id from traceparent via childLoggerFactory; span_id = new server span id.
- [CONV] no-route requests: operation_id `unmatched`, module `core`, no `route` field. [CONV] readiness `degraded` -> 200 {status:'degraded'}; any `down`/throw/out-of-enum -> 503. [CONV] `version` = package.json version until C1 injects git sha.
- [CONV] default healthChecks = both `down` (fail closed) until DB pool / rate-limit tasks wire real checks. tenant_id label allowed only on events_published + ratelimit_rejections (02-TRD §13 note).
- Verify: T0D-10-verify.cmd 46/46; full api suite 763/763 with --maxWorkers=4; tsc clean.
- Open: default-parallel full run flakes 1–2 unrelated 5 s timeouts (errors/boot/openapi tests) — per-request info lines to stdout from tests that boot without logStream; suggest tester's core/__tests__/helpers cfg set LIMS_CORE_LOG_LEVEL=silent.
- Open: main.ts not present, so startMetricsServer is not yet started on LIMS_CORE_METRICS_PORT; no per-check timeout in readiness.
