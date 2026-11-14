# HC-T09 debugger
- Cause: 22 assign/schedule tests fail `unknown_task_identifier` — `app.enqueue_job('homecollection.refresh_visit_specimens')` (visit.service.ts:104, required by TRD 02 §8/§9 "again at assign") finds no row in `core.g_task_registry` in the test DB (filled only by deploy registry-sync, not by HC-T03.pg.sh).
- Impl is correct; app code must never write the registry. Fix is test-side fixture (seed row in dispatch/helpers.ts, as FD-T06 `ensureTaskRegistry`). I may not edit tests, so no impl change; dispute in HC-T09-dispute.md (already holds the exact fix).
