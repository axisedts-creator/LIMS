# T-B2 impl (writer)
Files: api `service/slot.service.ts`, `repository/slot.repo.ts`, `handlers/slot.handlers.ts` (+ wired in handlers/index.ts); worker `tasks/sync_booking_centres.ts`, `cron.ts` (row `5 20 * * *`), `index.ts` (task + nightly).
Review #1 fixed: repo `syncOccupancyCapacity` (future occupancy rows of the template get new capacity) called in S9 before overbooked count; S6 uses occupancy row capacity, template capacity only when row absent.
Results (after review): slot.handlers 119/119; engagement module 932 pass, 15 fail all in ops.metrics.test.ts (T-OPS1, unrelated); tsc: 0 errors in slot files.
[CONV] overlap check runs under `pg_advisory_xact_lock` per (tenant, centre, kind) so concurrent creates serialise; template enqueue = `app.enqueue_job(id, {tenant_id}, 'bcentres:<tenant>', NULL, 5)` after the write, S8/S9/S10 only.
[CONV] S6 `remaining` clamped to 9 (StaffSlot maxItem 9 vs capacity up to 100); S6 does not exclude blackouts (spec silent); S9 overlap skipped when the stored template is inactive.
[CONV] S11 deactivate returns SlotBlackoutResult with `affected.future_bookings` recomputed for the range.
Open: full api/worker suites and lint not run; concurrent-create lock and RLS text need a real-Postgres test.
