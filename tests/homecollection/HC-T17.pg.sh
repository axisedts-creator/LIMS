#!/usr/bin/env bash
# HC-T17: same PG17 bootstrap as HC-T03.pg.sh (roles -> migrations -> graphile-worker -> homecollection DDL stand-in -> seeds), but runs only the HC-T17 live suite
# (metrics emitted by the push pipeline + planted-PHI log scan; vitest filter = the observability live test). Run from the repo root. Exit code = vitest's.
# Pre-exported LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL skip the container.
set -euo pipefail
HC_SUITE="src/modules/homecollection/__tests__/observability/logscan.live.test.ts" exec bash "$(dirname "$0")/HC-T03.pg.sh"
