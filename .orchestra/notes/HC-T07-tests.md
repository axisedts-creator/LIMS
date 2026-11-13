# HC-T07 tests (specimen status + rejection consumers)
- `services/worker/src/jobs/homecollection/__tests__/specimen.consumers.live.test.ts` (live PG17, 27 tests: US-11-1/2, US-14-1/2, stale seq, per-specimen idempotency, no-visit order, 30-day window, tenant isolation, log hygiene).
- `tests/homecollection/HC-T07.pg.sh` = HC-T06 harness boot (docker PG17 + migrations + seeds) running only that suite. Needs Docker.
- Run: `.orchestra\notes\HC-T07-verify.cmd` (or export LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL, then `pnpm --dir services/worker exec vitest run src/jobs/homecollection/__tests__/specimen.consumers.live.test.ts`).
- Expected now: fail at import (missing `consumers/lab.specimen.status_changed.v1.ts` -> `onSpecimenStatusChanged`, `consumers/lab.specimen.rejected.v1.ts` -> `onSpecimenRejected`).
- ASSUMED (header of the test file lists all): export names from TRD §3.2; flag `recollection_required` opens on the NEW visit; parent = home_visit_id (same order only) else latest visit of the order; stale/equal seq changes nothing incl. route version; 30-day window on visit created_at.
