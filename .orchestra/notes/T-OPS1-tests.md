# T-OPS1 tests (metrics, alert rules, purge_ephemeral / purge_queue crons; 05-SCHEMA §6.6 test 5)
- API: services/api/src/modules/engagement/__tests__/ops.metrics.test.ts (13 TRD §13 metrics: ENGAGEMENT_METRICS + best-effort `engagementMetrics` emitter + core registry).
- Worker: jobs/engagement/__tests__/ops.alerts.test.ts (alerts/engagement.rules.yml, C1 format, promtool when installed) and ops.purge.test.ts (cron rows UTC `52 * * * *` / `25 21 * * *` per_tenant; tasks call the 6.4 DEFINERs, class-E deletes + NOT EXISTS link filter, tenant guard).
- DB: db/tests/engagement/T-OPS1_purge.test.sql (pgTAP, FORCE RLS: §6.6 test 5, system-only class-E deletes past expires_at, referenced link_codes kept). Needs migrated C16 DDL; NOT in verify.cmd; not run here.
- Run: `.orchestra\notes\T-OPS1-verify.cmd` (api vitest via the package + worker vitest with --root services/worker).
- Seams ASSUMED (file headers): metrics.ts exports ENGAGEMENT_METRICS + engagementMetrics.<otpRequest|...|reportDownload>(ctx, ...); tasks are manifest.tasks[id] with payload {tenant_id}, SQL through ctx.tx.query; alert exprs checked structurally (TRD gives conditions, not PromQL).
- NEEDS LEAD DECISION/CR: registering the 13 metrics in core/observability/metrics.ts DEFS (+ its EXPECTED map test) is a C0 path (LD-88/LD-120 precedent); 2 test groups depend on it.
- Fails now: 37 of 39 worker + 31 of 32 API tests (missing metrics.ts, rule file, tasks, cron rows); the passing ones are TRD-table guards. Not asserted: batching/LIMIT, purge metrics, redaction column order.
