#!/usr/bin/env bash
# HC-T12: same PG17 bootstrap as HC-T03.pg.sh (roles -> migrations -> graphile-worker -> homecollection DDL stand-in -> seeds), but runs only the HC-T12 suite
# (push pipeline A3: guards, dedupe, effects, events; vitest filter = the sync test folder). Run from the repo root. Exit code = vitest's.
# Pre-exported LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL skip the container.
set -euo pipefail
HC_SUITE="src/modules/homecollection/__tests__/sync" exec bash "$(dirname "$0")/HC-T03.pg.sh"
