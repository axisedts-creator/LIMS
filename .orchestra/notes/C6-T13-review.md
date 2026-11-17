APPROVE

Round 3. Round-2 item 1 is fixed. All 9 statements are now in `repository/releases.repo.ts`. They keep the same tenant_id binds, the `version`/status guards and the `::text[]` cast, and they run on the caller's tx. `auto_release` is read through `settings.repo.findSettings`. release.service.ts has no inline SQL left except the shared `app.enqueue_job` call, which the static test allows.
The debugger moved the pre-existing inline SQL from C6-T04 `service/reports.service.ts` (26 statements) and C6-T09 `handlers/retry-render.handlers.ts` (2) into `repository/reports.repo.ts` and `repository/retry-render.repo.ts`. I checked the diff: the text and params are copied verbatim, every statement binds tenant_id, the `::uuid[]` casts are kept, and only C6-owned paths changed. The static test was not edited.
verify.cmd now runs the whole api `src/modules/reporting` directory.
Re-run: worker src/jobs/reporting 14 files / 371/371 pass. api src/modules/reporting 24 files / 850/850 pass, including repository.static.test.ts.
Non-blocking: the header comment in retry-render.repo.ts was copied from reports.repo (it says C6-T04 / reports.service). Open items carried forward: core problem extension members (CR `.orchestra/cr/C6-T13.md`), and `dispatch_release_deliveries` is still a stub that throws (T14/T19).
