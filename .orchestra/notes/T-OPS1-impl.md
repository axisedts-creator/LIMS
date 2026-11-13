# T-OPS1 impl
- Files: api `modules/engagement/metrics.ts` (ENGAGEMENT_METRICS + engagementMetrics emitters); worker `jobs/engagement/tasks/purge.ts` (purgeEphemeral, purgeQueue), `cron.ts` (2 rows, UTC `52 * * * *` / `25 21 * * *`, per_tenant), `index.ts` (registered), `alerts/engagement.rules.yml` (8 rules).
- LD-142: 13 lims_engagement_* rows added to DEFS in api `core/observability/metrics.ts` (labels verbatim, TRD §13 812-824); nothing else in core changed.
- Results (round 2): api ops.metrics + core/observability 62/62 pass; worker ops.alerts + ops.purge 38 pass / 1 skip (promtool absent). api tsc: only pre-existing errors outside these files. DB pgTAP T-OPS1_purge.test.sql NOT run (needs migrated DDL).
- [CONV] purge tasks: tenant guard as close_queue_day; class-E SQL tenant-bound via $1, never touch app.maintenance; enquiries close sets closed_at + version + updated_by.
- [CONV] alerts: severities page/warn/info; `for` 15m except DisplayStale 10m; DisplayStale window 07:00-19:00 NPT as UTC minutes 75..795.
- Open: EngagementLinkIssueVolume is a tenant-level proxy (`outcome="issued"` of link_events, value assumed) since TRD wants per-membership via access-log job; rules use `by (tenant_id)` though §13 metrics have no tenant label (C1 must attach it); emitters not yet called from API handlers/consumers; no purge metrics (spec silent).
