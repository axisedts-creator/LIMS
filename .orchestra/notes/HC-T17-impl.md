# HC-T17 impl
- Files: api `homecollection/{metrics,gauges.service}.ts`, `repository/metrics.repo.ts`, handlers `pushSyncMutations` (push_duration) + `getSyncSnapshot` (snapshot_duration{changed}), `sync.service.ts` (mutations_total, clock_skew, events_published); worker `jobs/homecollection/{alerts.yaml,tasks/refresh_metric_gauges.ts}`; `apps/phlebo_app/tool/ci/{grep_forbidden,scan_apk}.sh`; CRs `.orchestra/cr/HC-T17-{c1-alerts,c0-0a-ci,registry}.md`.
- [CONV] emitters are best-effort (swallow unknown name/label), like engagement/lab; log calls unchanged (code-only, static PHI scan green).
- [CONV] devices_stale proxy = active, last_seen_at > 2 h ago, last_push_at older than last_seen_at (server cannot see the device's pending seq).
- LD-162: added the 8 `lims_homecollection_*` rows (TRD §14 589-596 verbatim) to core `DEFS` + `EXPECTED` in `core/observability/__tests__/metrics.test.ts`; nothing else in those files. [CONV] help text written fresh (module map has none). CR renamed `HC-T17-registry.resolved-202611141349.md`.
- Rerun (review fix: EXPECTED rows were missing): core `metrics.test.ts` 18/18; `observability.test.ts` 55 pass / 1 skip (promtool); `http.test.ts` not rerun.
- Open: `refresh_metric_gauges` (every 60 s, per_tenant) is not scheduled: no `jobs/homecollection` worker manifest exists yet. `scan_apk.sh` not run against a real APK (apktool absent here); `tsc` shows no homecollection errors.
- HC-T17.pg.sh (live log-scan): 10/10 pass.
