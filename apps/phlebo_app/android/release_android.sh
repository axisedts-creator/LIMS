#!/usr/bin/env bash
# HC-T29: Android release APK (prod flavour only; dev and staging never ship). REQ-SEC-107/112.
# Signing inputs (LIMS_RELEASE_STORE_FILE, _STORE_PASSWORD, _KEY_ALIAS, _KEY_PASSWORD) are exported from the
# C1 secret store by the CI job before this runs; Gradle fails closed if any is missing. See RELEASE.md.
# Only FLAVOR, API_BASE_URL and SENTRY_DSN are compiled in; never pass a secret as a dart-define.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${API_BASE_URL:?API_BASE_URL (https, pinned host) is required}"

flutter build apk --release --flavor prod -t lib/main.dart \
  --dart-define=FLAVOR=prod \
  --dart-define=API_BASE_URL="$API_BASE_URL" \
  --dart-define=SENTRY_DSN="${SENTRY_DSN:-}" \
  --obfuscate --split-debug-info=build/symbols

# Symbol files (build/symbols) go to the C1 artefact store with the phlebo-v<version> tag; never committed.
echo "APK: build/app/outputs/flutter-apk/app-prod-release.apk"
echo "Next: tool/ci/scan_apk.sh <apk>"
