APPROVE

Scope reviewed: `git diff 9c248e02..HEAD` (AN-T22, LD-88 / CR-C8-016).

- metrics.ts: exactly 9 new DEFS entries. Name, type and labels match C8 02-TRD §13 l.846-854 exactly. Each help is one factual sentence. Nothing else in core/observability/metrics.ts changed.
- metrics.test.ts: EXPECTED has the same 9 names and types. `NOT_A_DURATION` exempts only `lims_analytics_export_rows` from the `_seconds` histogram rule. This is the smallest change that works: the TRD fixes that name, and without it the C0 rule fails on a name the spec requires. It is not a weakened test. Lead: please note this one extra line alongside LD-88's "nothing else changes".
- Tenant/PHI: labels carry no membership, export or referrer ids. tenant_id appears only where TRD §13 allows it. No PHI and no secrets in the diff.
- Paths: core/observability edits are covered by LD-88. `.orchestra` changes are only notes and the CR rename.
- Rules file (`analytics.rules.yml`, from an earlier commit f1e8cc9b) is not in this diff range. The worker observability tests check it.
- Tests run by reviewer: API ops + metrics.test.ts 43/43 pass. Worker observability.test.ts 5/5 pass.

Non-blocking (not defects under LD-88):
- `lims_analytics_export_rows` uses prom-client's default buckets (0.005-10), which suit durations, not row counts. Most samples will fall in the +Inf bucket. Custom buckets would need a C0 change to the DEFS shape, so it is out of scope here.
- No producer sets `family_stale`, `dirty_partitions`, `export_downloads_total` or `schedule_sends_total` (noted in impl notes). As a result `AnalyticsFamilyStale` never fires. Needs a follow-up task or CR.
