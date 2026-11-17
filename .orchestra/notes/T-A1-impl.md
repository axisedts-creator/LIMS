# T-A1 impl (writer) — review round 2
Files: pubspec.lock restored from 6b2618ee (review 1; `flutter pub get --enforce-lockfile` resolves); android/app/src/main/AndroidManifest.xml allowBackup=false + fullBackupContent=false (review 3, 07-SECURITY "token in logs/backups"); android/.gitignore `.kotlin/` (review 4). Review 2 = tester files, already fixed.
Result: `flutter analyze` No issues; `flutter test test` 69/69 pass. Android builds not re-run (manifest change only; reviewer built both OK in round 2).
[CONV] (round 1, unchanged) applicationId `invalid.lims.patient_app` placeholder; minSdk 26 (sentry_flutter, LD-24); release = debug signing until T-REL1, never ship.
Open: CR-C16-016/017 generated lims_api_client, CR-C16-004 session_token, `.invalid` placeholders.
