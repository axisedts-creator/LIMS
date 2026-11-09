# C6-T33 tests (observability: denylist, log-scan, metrics, alert rules)
- api `__tests__/observability.log.test.ts`: planted-PHI denylist unit (12 TRD keys, exact+case-insensitive, nested, no mutation, error_code/tenant_id stay) + static log-scan of API+worker reporting source (no denylisted key in any log call).
- api `__tests__/observability.metrics.test.ts`: `lims_reporting_otp_verify_failures_total{tenant_id}` via verifyPortalOtp.
- worker `__tests__/observability.rules.test.ts`: reporting.rules.yaml = 10 TRD rows (expr/for verbatim, no extras, metrics/labels allowlist).
- worker `__tests__/observability.metrics.test.ts`: versions_total, deliveries_total, transport_errors_total, circuit_open / rendering_oldest / held_oldest / held_versions gauges.
- Run: `.orchestra\notes\C6-T33-verify.cmd` (api + worker via `pnpm --dir ... exec vitest run`).
- ASSUMED APIs (file headers): `src/modules/reporting/observability.ts` exports `REPORTING_LOG_DENY`, `createReportingLogger(opts)`; emitting tasks as listed in the metrics test header. Existing `code:` log keys (assemble_report.ts:202, release.service.ts:152) must become `error_code`.
- Not covered: otp_sent_total, qr_verify_total, release/portal counters, histograms, renderer re-export.
