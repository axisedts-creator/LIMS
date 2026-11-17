#!/usr/bin/env bash
# HC-T10: same PG17 bootstrap as HC-T03.pg.sh (roles -> migrations -> graphile-worker -> homecollection DDL stand-in -> seeds), but runs only the HC-T10 suite
# (device register A1 + sign-off A5). Run from the repo root. Exit code = vitest's. Pre-exported LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL skip the container.
set -euo pipefail
HC_SUITE="src/modules/homecollection/__tests__/devices" exec bash "$(dirname "$0")/HC-T03.pg.sh"
