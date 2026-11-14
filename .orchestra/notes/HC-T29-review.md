APPROVE

Scope: `git diff 2f55e12a..HEAD`, which changes apps/phlebo_app/tool/ci/scan_apk.sh and .orchestra/notes/HC-T29-impl.md.
- scan_apk.sh lines 20-21 match the AUTO HC-T29-01 lead decision word for word: strings goes to a file first, then `grep -E -q`. This removes the SIGPIPE/pipefail fail-open. `set -euo pipefail`, the CLI and the gitleaks step are unchanged.
- `|| true` on strings does not let a missing tool pass silently. The required-tool check exits 3 first, and the test "a missing required tool fails closed (exit 3)" passes.
- Editing tool/ci is outside the brief's files list, but the lead decision tells the writer to make exactly this edit. No other paths changed.
- No secrets, no PHI, no invented names. The diff touches no RLS, permissions or error codes.
- Ran: `flutter test __tests__/scan_apk_test.dart __tests__/release_hardening_test.dart`, 29/29 passed.
- Not verified: a real apktool run on a release APK, and the manual device test record.
