#!/usr/bin/env bash
# CI job c17-release-binary-scan (02-TRD §14 "CI jobs for C0-0A"; REQ-SEC-107; 07-SECURITY §5.11). Runs on release tags phlebo-v*.
# Usage: scan_apk.sh <release.apk>
# Unpacks the APK with apktool, then looks for secrets with `strings` + gitleaks. Fails CLOSED: a missing argument, file, tool, or an unreadable / non-APK input is a failure, never a pass.
set -euo pipefail

APK="${1:-}"
[ -n "$APK" ] || { echo "usage: scan_apk.sh <release.apk>" >&2; exit 2; }
[ -f "$APK" ] || { echo "scan_apk: no such file: $APK" >&2; exit 2; }
for tool in apktool strings gitleaks unzip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "scan_apk: required tool missing: $tool (fail closed)" >&2; exit 3; }
done
unzip -tq "$APK" >/dev/null 2>&1 || { echo "scan_apk: not a valid APK (zip) archive: $APK" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
apktool d --no-src -f -o "$WORK/unpacked" "$APK" >/dev/null || { echo "scan_apk: apktool failed" >&2; exit 1; }

# 1) raw strings of the packed binary: private keys and cloud keys must not ship (REQ-SEC-107)
if strings -a "$APK" "$WORK"/unpacked/lib/*/*.so 2>/dev/null | grep -E -m1 -- '-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}'; then
  echo "scan_apk: secret-looking string in the release binary" >&2
  exit 1
fi
# 2) gitleaks default rules over the unpacked resources (exit 1 on any leak)
gitleaks detect --no-git --redact --source "$WORK/unpacked" || { echo "scan_apk: gitleaks reported a leak" >&2; exit 1; }
echo "scan_apk: clean ($APK)"
