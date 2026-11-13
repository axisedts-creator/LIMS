# T-B4 impl (writer)
Files: worker/src/jobs/engagement/tasks/booking_jobs.ts (reconcile_bookings, mark_no_shows), consumers/homecollection.collection.synced.v1.ts, cron.ts (+2 rows */10, */15 per_tenant), index.ts (wiring). Logic lives in the worker, not API booking.service.ts (tests reach it only via the manifest).
Tests: `pnpm --dir services/worker exec vitest run src/jobs/engagement` = 180 passed / 1 skipped (incl. the 38 booking_jobs tests); tsc shows no errors in the touched files.
[CONV] window slot_start in [now-7d, now+1d] for both crons; no-show considers confirmed bookings only (checked_in excluded: patient showed up; spec silent).
[CONV] reconcile cancel (lab_unavailable) does not release slot_occupancy (spec silent; same as no-show); maxAttempts 3 on both cron rows (no §8.1 row).
[CONV] pre_registered order: order_id stored with version + 1; no settings row = auto_no_show off.
Open: owned path `services/api/.../booking.service.ts` untouched; spec §8.1 has no max_attempts for these two crons.
