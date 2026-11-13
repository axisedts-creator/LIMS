#!/usr/bin/env bash
# HC-T15: same PG17 bootstrap as HC-T03.pg.sh (roles -> migrations -> graphile-worker -> homecollection DDL stand-in -> seeds), but runs only the HC-T15 suite
# (device admin H16 listPhleboDevices + H17 requestDeviceWipe). Run from the repo root. Exit code = vitest's. Pre-exported LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL skip the container.
set -euo pipefail
HC_SUITE="src/modules/homecollection/__tests__/devadmin" exec bash "$(dirname "$0")/HC-T03.pg.sh"
