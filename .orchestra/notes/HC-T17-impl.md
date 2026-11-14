# HC-T17 impl
- Files: api `homecollection/{metrics,gauges.service}.ts`, `repository/metrics.repo.ts`, handlers `pushSyncMutations` (push_duration) + `getSyncSnapshot` (snapshot_duration{changed}), `sync.service.ts` (mutations_total, clock_skew, events_published); worker `jobs/homecollection/{alerts.yaml,tasks/refresh_metric_gauges.ts}`; `apps/phlebo_app/tool/ci/{grep_forbidden,scan_apk}.sh`; CRs `.orchestra/cr/HC-T17-{c1-alerts,c0-0a-ci,registry}.md`.
- [CONV] emitters are best-effort (swallow unknown name/label), like engagement/lab; log calls unchanged (code-only, static PHI scan green).
- [CONV] devices_stale proxy = active, last_seen_at > 2 h ago, last_push_at older than last_seen_at (server cannot see the device's pending seq).
- LD-162: 8 `lims_homecollection_*` rows (TRD §14 589-596 verbatim) in core `DEFS` (metrics.ts:121-128); matching `EXPECTED` rows landed in tester commit cd0fd333 (metrics.test.ts:119-126). Nothing else in those files. [CONV] help text written fresh. CR renamed `HC-T17-registry.resolved-202611141349.md`.
- Rerun at cd0fd333 (2026-11-14 14:43): core `metrics.test.ts` 18 passed (18); `observability.test.ts` 55 passed | 1 skipped (promtool); `http.test.ts` not rerun.
- Open: `refresh_metric_gauges` (every 60 s, per_tenant) is not scheduled: no `jobs/homecollection` worker manifest exists yet. `scan_apk.sh` not run against a real APK (apktool absent here); `tsc` shows no homecollection errors.
- HC-T17.pg.sh (live log-scan): 10/10 pass.
