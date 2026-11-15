# HC-T30 impl
- Manuals `docs/manual/homecollection/{dispatcher,phlebotomist,centre-handover,admin-settings}-guide.md`; help files already existed (HC-T19..), unchanged.
- `apps/phlebo_app/integration_test/hc_t30_offline_visit_test.dart`: offline visit, kill mid-batch, airplane retry with same bytes, drain, `SQLite format 3` check; + review item 6: kill mid-batch -> 401 auth.token_expired -> refresh -> same batch_id + identical body -> drained (HC-T25 SyncFx/FakeHcServer/FakeSession).
- [CONV] `apps/phlebo_app/pubspec.yaml`: dev_dependency `integration_test: sdk: flutter` (outside task file list; needed for the binding).
- Run: vitest hc-t30 23/23 pass; `flutter analyze integration_test` clean; Dart scenario 2/2 pass on host via temp copy under `__tests__` (deleted). Not run on an emulator (none attached).
- Review item 7: Playwright NOT run - `@playwright/test` not installed ("Command \"playwright\" not found"), no compose API stack/seed (LIMS_E2E_* unset). Filed `.orchestra/cr/HC-T30.md` (to C0-0A: dependency, nightly job, seed env).
- Open: done_when NOT met until the CR lands and the nightly run is green. Task not done.
