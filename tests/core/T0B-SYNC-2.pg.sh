#!/usr/bin/env bash
# T0B-SYNC-2: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations incl. 20261117250000 and 20261117260000 (core.sync_operation / core.sync_conflict) -> graphile-worker -> seeds)
# and runs vitest over the WHOLE src/core suite of services/api (the new part 2 tests in src/core/sync/__tests__, the part 1 sync tests, the boot test, the pending-operations tests and every other core test).
# Nothing is narrowed. Quick look while developing:
#   SYNC2_SUITE=src/core/sync bash tests/core/T0B-SYNC-2.pg.sh   (the verify script never sets it).
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
SUITE_VALUE="${SYNC2_SUITE:-src/core}"
TMP="$(mktemp "${TMPDIR:-/tmp}/sync2.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^SUITE=.*#SUITE=\"${SUITE_VALUE}\"#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^SUITE=\"${SUITE_VALUE}\"" "$TMP"
bash "$TMP"
