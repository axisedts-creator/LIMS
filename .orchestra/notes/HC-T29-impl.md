# HC-T29 impl (writer)
- Changed: android/app/build.gradle.kts (release signingConfig from LIMS_RELEASE_* env/key.properties, minify, fail-closed), MainActivity.kt (FLAG_SECURE on `lims_ui/secure_screen`), android/release_android.sh, android/RELEASE.md, lib/core/platform/secure_screen.dart.
- Also (outside file list, 1 line each, same chunk): `sensitive: true` on LimsTextField in collect_screen.dart and fail_visit_screen.dart (REQ-SEC-111).
- [CONV] release signing pattern copied from apps/patient_app (T-REL1); LD-28 legal URLs listed in RELEASE.md only (in-app links = separate task, UI out of scope).
- Test quirk: `_screen.dart` glob also matches secure_screen.dart, so it references LimsSecureScreen in code (channel-match getter).
- Ran: release_hardening_test 19/19 pass; `flutter analyze lib` clean; scan_apk_test 10/12 (not run: sync_engine_push 426 subset, kotlin/gradle build).
- OPEN: scan_apk.sh pipefail defect (2 tests fail), file not owned: .orchestra/cr/HC-T29.md.
