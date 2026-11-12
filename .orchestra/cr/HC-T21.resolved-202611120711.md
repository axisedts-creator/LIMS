Title: CR-C17-015: add `apps/phlebo_app` to root pubspec.yaml `workspace:` list
From chunk: C17            To owner: C0-0A
Type: shared-lib
Blocking? yes — C17 HC-T21 (app skeleton) and every later HC-T* Flutter task: apps/phlebo_app/pubspec.yaml declares `resolution: workspace`, so `flutter pub get` / `flutter test` / `flutter build apk --flavor dev|staging` fail until the root lists the package.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  Root `/pubspec.yaml` is owned by C0-0A (spec/chunks/C0-foundation-contracts/02-TRD.md:14; 01-CHUNK-MAP §3 "No path is shared"). HC-T21 done_when "app builds for dev/staging" (REQ-SEC-104, REQ-SEC-105) needs the phlebo app to resolve lims_ui / shared-dart via the Dart workspace.
Proposed change (exact): in `/pubspec.yaml`, under `workspace:`, append one line after `  - packages/ui-flutter`:
    `  - apps/phlebo_app`
  then run `flutter pub get` at repo root and commit the regenerated root `pubspec.lock` (LD-05). New direct deps of apps/phlebo_app (exact pins, for the T0-03 dependency table per LD-04): sentry_flutter 10.3.0 (already used by lims_ui, LD-24), go_router 18.1.3.
Backward compatible? yes — additive workspace member; no existing package changes.
Tenant/security impact: none (no RLS, no PHI field, no public surface). App itself enforces REQ-SEC-104/105 (pinned TLS, no badCertificateCallback).
IRD/regulatory impact (billing changes only): N/A
Alternatives considered: drop `resolution: workspace` and use path deps — rejected: breaks single lockfile (LD-05) and duplicates SDK pins (T0-03).
Tests that will prove it: `flutter pub get` at root succeeds; `cd apps/phlebo_app && flutter test __tests__` passes (50 tests, run locally with the line present).
