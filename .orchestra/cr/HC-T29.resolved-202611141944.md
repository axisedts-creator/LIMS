Title: CR-C17-HC-T29: tool/ci/scan_apk.sh passes a secret found in a large binary (pipefail + grep -m1 SIGPIPE)
From chunk: C17            To owner: C17 (file is outside the HC-T29 file list; needs a ruling to edit)
Type: bug
Blocking? yes: HC-T29 done_when "REQ-SEC-107 checks pass" (2 tests in apps/phlebo_app/__tests__/scan_apk_test.dart fail: private key and AKIA in a large binary)
Problem: line 20 of apps/phlebo_app/tool/ci/scan_apk.sh is `if strings ... | grep -E -m1 ...; then`. Under `set -o pipefail`, grep -m1 exits at the first match, `strings` gets SIGPIPE (141), the pipeline status is non-zero, the `if` is false and the script prints "clean" with exit 0. A release binary containing a private key or AWS key passes the REQ-SEC-107 scan (fails open).
Proposed change (exact): replace lines 19-23 with
  strings -a "$APK" "$WORK"/unpacked/lib/*/*.so > "$WORK/strings.txt" 2>/dev/null || true
  if grep -E -q -- '-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}' "$WORK/strings.txt"; then ... exit 1; fi
(`|| true` only on the strings step: an unreadable .so glob must not hide a match in the APK itself; apktool/unzip already fail closed above.)
Backward compatible? yes (stricter, same CLI).
Tenant/security impact: REQ-SEC-107 scan currently fails open. No RLS/PHI change.
Alternatives considered: `|| true` around the whole pipeline (hides real failures); dropping pipefail (weakens the rest of the script).
Tests that will prove it: apps/phlebo_app/__tests__/scan_apk_test.dart (the two failing tests turn green).
