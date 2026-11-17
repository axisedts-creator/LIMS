#!/usr/bin/env bash
# T-REL1: Android internal-track release bundle (prod flavour only). TRD §2.3, REQ-SEC-112/128.
# Signing inputs (LIMS_RELEASE_STORE_FILE, _STORE_PASSWORD, _KEY_ALIAS, _KEY_PASSWORD) are exported from the
# C1 secret store by the CI job before this runs; Gradle fails closed if any is missing. See RELEASE.md.
set -euo pipefail
cd "$(dirname "$0")/.."

flutter build appbundle --release --flavor prod -t lib/main_prod.dart \
  --obfuscate --split-debug-info=build/symbols

# Symbol files (build/symbols) are uploaded to the C1 artefact store by the CI job; never committed.
echo "AAB: build/app/outputs/bundle/prodRelease/app-prod-release.aab"
