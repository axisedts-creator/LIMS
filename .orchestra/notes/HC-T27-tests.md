# HC-T27 tests (tester)
Files (apps/phlebo_app/__tests__/): route_screen_test, handover_screen_test, outbox_screen_test, settings_screen_test, route_handover_outbox_integration_test, hc27_ci_guards_test, support/hc27_fixture.dart.
Covers US-12-1 (settings/wipe device side), US-13-1/2 (route M2, handover M10, outbox M11), LD-140 UI guards, offline/layering and no-PII guards from 07-SECURITY.
Run: `.orchestra\notes\HC-T27-verify.cmd` (cmd.exe; runs `flutter test` on the six files from apps/phlebo_app).
Current result: 35 failed, 0 passed. Cause: lib/features/{route,handover,settings}/ and outbox/ui|domain files do not exist yet (compile errors, PathNotFoundException).
No implementation written.
