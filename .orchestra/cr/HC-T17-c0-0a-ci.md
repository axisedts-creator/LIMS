Title: CR-C17-HC-T17-C00A: wire the three C17 CI jobs (scripts under apps/phlebo_app/tool/ci/)
From chunk: C17
To owner: C0-0A
Type: shared-lib
Blocking? no (the scripts ship in C17; the gates only run once C0-0A adds the jobs)
Problem: 02-TRD §14 and 08 A13 P-14 name three CI jobs for the phlebotomist app. The scripts exist; no workflow runs them.
Proposed change (exact): add three jobs to the CI workflow set (ids verbatim):
  c17-no-bad-cert-callback: trigger paths apps/phlebo_app/**, linux, command `bash apps/phlebo_app/tool/ci/grep_forbidden.sh` (exit 1 on badCertificateCallback, sqlcipher_flutter_libs, Firebase/FCM/map SDK symbols).
  c17-db-forensics: trigger paths apps/phlebo_app/lib/core/db/**, linux with an Android emulator, command `flutter test integration_test/db_forensics_test.dart` (DB headers must not be `SQLite format 3`; the test file is owned by C17 and arrives with its own task).
  c17-release-binary-scan: trigger release tags `phlebo-v*`, linux with apktool, binutils `strings` and gitleaks installed, command `bash apps/phlebo_app/tool/ci/scan_apk.sh <release.apk>` (REQ-SEC-107; fails closed on a missing tool or APK).
Backward compatible? yes (additive jobs).
Tenant/security impact: none; the jobs only read the app source and the release artefact. They are release gates for REQ-SEC-104/105/107.
Alternatives considered: running the scripts from one combined job (loses the per-path triggers of the TRD table).
Tests that will prove it: observability.test.ts ("c17-no-bad-cert-callback" and "c17-release-binary-scan" groups: clean / hit / fail-closed fixtures); the first CI run of each job.
