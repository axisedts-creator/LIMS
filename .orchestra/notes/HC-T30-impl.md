# HC-T30 impl
- Added `docs/manual/homecollection/{dispatcher,phlebotomist,centre-handover,admin-settings}-guide.md` (lost-phone + wipe + manual-collect fallback in phlebotomist guide).
- Added `apps/phlebo_app/integration_test/hc_t30_offline_visit_test.dart`: offline visit, kill mid-batch, airplane retry with identical frozen body, drain, `SQLite format 3` header check on outbox.db + cache.db. Reuses `__tests__/support` fixtures.
- [CONV] `apps/phlebo_app/pubspec.yaml`: dev_dependency `integration_test: sdk: flutter` (SDK package, nothing to pin); outside the task file list, needed for `IntegrationTestWidgetsFlutterBinding`.
- Help files already existed (HC-T19..); unchanged.
- Run: vitest hc-t30 23/23 pass; `flutter analyze integration_test` clean; the Dart scenario passed on host via a temp copy under `__tests__` (deleted). Not run on an emulator (none attached) or with Prism.
- Open: no `test:e2e` script / nightly.yml wiring for the Playwright spec (outside task files; needs CR). Playwright scenario not run (needs compose stack).
