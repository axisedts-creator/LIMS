# T0B-ASYNC-2 impl (writer)
- New `services/worker/src/jobs/catalog/index.ts` (catalog.export_build, catalog.import_validate, catalog.import_commit) and `jobs/homecollection/index.ts` (homecollection.flag_handover_discrepancy, homecollection.refresh_visit_specimens); existing handlers imported, no task file touched. `manifests.ts`: +2 imports, +2 entries.
- [CONV] Only the five enqueued tasks declared (brief "exactly"): no crontab, no subscriptions, no maxAttempts (core default). Catalog cron/import_kinds and homecollection cron/consumers stay off; enabling them starts cron on staging, so that is a lead decision / later task.
- [CONV] homecollection task files export no identifier constants, so the index uses string literals.
- Still open (LD-279 c, founder decision): identity.notify_ip_throttle, identity.rescan_upload.
- Checks: verify.cmd 7 files / 59 tests pass; `tsc --noEmit` clean. Full src/core + catalog unit run: bootstrap.test.ts (5 s cold-import timeout) and XlsxReader round trip flaked under parallel load; both pass when run alone; neither imports the changed files.
- Not run: *.live / integration tests (need DB).
