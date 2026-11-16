# T0B-ASYNC-2 impl (writer)
- New `services/worker/src/jobs/catalog/index.ts` (catalog.export_build, catalog.import_validate, catalog.import_commit) and `jobs/homecollection/index.ts` (homecollection.flag_handover_discrepancy only); existing handlers imported, no task file touched. `manifests.ts`: +2 imports, +2 entries.
- Review item 1: homecollection.refresh_visit_specimens removed from the manifest (needs ctx.ports.LabPort, absent from JobContext; would dead-letter). CR written: `.orchestra/cr/T0B-ASYNC-2.md` (CR-C0-T0B-ASYNC-2-001, non-blocking for this task). Review item 2 was test-only (tester).
- [CONV] Only enqueued tasks declared (brief "exactly"): no crontab, subscriptions or maxAttempts. Cron/consumers stay off (lead decision / later task).
- [CONV] homecollection task files export no identifier constants, so the index uses string literals.
- Queued now (4): catalog.export_build, catalog.import_validate, catalog.import_commit, homecollection.flag_handover_discrepancy. Still open (3): homecollection.refresh_visit_specimens (CR-C0-T0B-ASYNC-2-001), identity.notify_ip_throttle, identity.rescan_upload (LD-279 c, founder decision).
- Checks: verify.cmd 7 files / 59 tests pass; `tsc --noEmit` clean. Not run: *.live / integration / pgTAP tests (need DB).
