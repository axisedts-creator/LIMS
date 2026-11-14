#!/usr/bin/env bash
# CI job c17-no-bad-cert-callback (02-TRD §14 "CI jobs for C0-0A"; REQ-SEC-104/105; 02-CV §15.3).
# Usage: grep_forbidden.sh [APP_DIR]   (default: the app dir this script sits in, tool/ci/../..)
# Scans APP_DIR/lib/** and APP_DIR/pubspec.yaml for a TLS bypass, the banned SQLCipher plugin, and Firebase / FCM / map SDKs.
# Comment lines (`#`, `//`) are ignored. Exit 0 = clean, 1 = at least one hit (file:line printed), 2 = bad usage.
set -euo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
[ -d "$APP_DIR" ] || { echo "usage: grep_forbidden.sh [APP_DIR] (not a directory: $APP_DIR)" >&2; exit 2; }

FORBIDDEN='badCertificateCallback|sqlcipher_flutter_libs|firebase|google_maps_flutter|flutter_map|mapbox'
targets=()
[ -d "$APP_DIR/lib" ] && targets+=("$APP_DIR/lib")
[ -f "$APP_DIR/pubspec.yaml" ] && targets+=("$APP_DIR/pubspec.yaml")
[ "${#targets[@]}" -gt 0 ] || { echo "grep_forbidden: nothing to scan under $APP_DIR (no lib/, no pubspec.yaml)" >&2; exit 2; }

hits=$( (cd "$APP_DIR" && grep -rHnIiE "$FORBIDDEN" "${targets[@]#"$APP_DIR"/}" 2>/dev/null) | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//)' || true)
if [ -n "$hits" ]; then
  echo "grep_forbidden: forbidden symbol(s) found (REQ-SEC-104/105, 02-CV §15.3):" >&2
  echo "$hits"
  exit 1
fi
echo "grep_forbidden: clean ($APP_DIR)"
