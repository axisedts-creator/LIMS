# HC-T16 impl
- New: worker `jobs/homecollection/cron.ts` + `tasks/{sweep_missed_visits,flag_overdue_handovers,purge_locations,purge_retention}.ts`; api `repository/housekeeping.repo.ts` (selects + DEFINER call). Edited: `visitFlags.repo.ts` (related_id type `string | null`, no runtime change).
- [CONV] sweep: "today" = ctx.now() in SQL as Asia/Kathmandu date (no port, P-15 constant); pulled = route.last_snapshot_at on route_date; applied collection OR applied mutation = V7 guard -> flag only. Rows locked FOR UPDATE.
- [CONV] purge_retention cron `25 21 28-31 * *` (5 fields cannot say "last day of month 21:25 UTC"): up to 4 idempotent runs/month. Fails closed unless retentionYears is a positive integer.
- [CONV] purge_locations uses DB now() via existing `deleteExpiredLocations`; overdue hours from homecollection.settings (default 4).
- Run (2026-11-14 11:32, after LD-168 test fix, no impl change): HC-T16.pg.sh -> 6 files, 61/61 tests pass. Earlier fix (LD-168): sweep sets membership_id NULL on missed assignment.
- Open: repo static.test.ts fails on pre-existing `handovers.repo.ts` (`${values.length}`), not mine. `homecollection/index.ts` manifest wiring not in HC-T16 files; crontab is ready to be imported.
