Title: CR-C0-T0B-ASYNC-1-001: seven task identifiers the API enqueues have no worker manifest task (app.enqueue_job -> unknown_task_identifier)
From chunk: C0 (C0-0B, task T0B-ASYNC-1)            To owner: catalog chunk, homecollection chunk, identity chunk (C2)
Type: bug
Blocking? yes: T0B-ASYNC-1 done_when (3), test services/worker/src/core/__tests__/async-manifests.test.ts "every identifier is a task (or cron) of a loaded manifest" fails on exactly these 7 (all other T0B-ASYNC-1 tests pass).
Problem: after services/worker/src/manifests.ts loads every jobs/<m>/index.ts (15 modules), these enqueued ids are declared by no manifest, so registry-sync writes no row and the enqueue is refused (now a visible 503 common.service_unavailable):
  - catalog.export_build (api modules/catalog/service/exports.service.ts), catalog.import_validate, catalog.import_commit (imports.service.ts): task files exist under services/worker/src/jobs/catalog but there is NO jobs/catalog/index.ts manifest.
  - homecollection.flag_handover_discrepancy (repository/handovers.repo.ts), homecollection.refresh_visit_specimens (repository/visitSpecimens.repo.ts, specimen.service.ts): task files exist under jobs/homecollection, NO jobs/homecollection/index.ts.
  - identity.notify_ip_throttle (service/auth.service.ts), identity.rescan_upload (service/settings.service.ts, user.service.ts): no worker task at all.
Proposed change (exact): catalog and homecollection owners add services/worker/src/jobs/<m>/index.ts exporting `manifest: WorkerManifest` with those tasks; C0-0B then adds the two lines to services/worker/src/manifests.ts (async-manifests.test.ts (1) fails until it does). Identity owner adds identity.notify_ip_throttle and identity.rescan_upload tasks to jobs/identity/index.ts, or removes the enqueue calls.
Backward compatible? yes (adds tasks; registry-sync is idempotent).
Tenant/security impact: none on RLS/grants; new worker tasks run under the existing worker wrapper (withTenantScope). Any new app.* call they make must be added to db/tests/identity/T0B-ASYNC-1_worker_grants.test.sql (worker-sql-functions.test.ts enforces).
IRD/regulatory impact: none.
Alternatives considered: weakening the scan (rejected: tester kept it strict); writing the manifests in C0-0B (rejected: jobs/*/index.ts not owned, read-only for this task).
Tests that will prove it: async-manifests.test.ts (1) and (3) green; registry-sync.all.test.ts unchanged green.
