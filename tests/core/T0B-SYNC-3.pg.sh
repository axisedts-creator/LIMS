#!/usr/bin/env bash
# T0B-SYNC-3: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations -> graphile-worker -> seeds) and runs vitest from the services/api package over THIS task's tests only:
# src/core/sync/__tests__/adapters (static + live adapter tests) and the revised default-registry test in src/core/sync/__tests__/push.live.test.ts.
# The existing frontdesk / billing / lab suites, the boot test and the three-runs-in-a-row check belong to the writer / reviewer verify, not to this script.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
SUITE_VALUE="${SYNC3_SUITE:-src/core/sync/__tests__/adapters src/core/sync/__tests__/push.live.test.ts}"
TMP="$(mktemp "${TMPDIR:-/tmp}/sync3.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^SUITE=.*#SUITE=\"${SUITE_VALUE}\"#; s#vitest run \"\$SUITE\"#vitest run \$SUITE#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^SUITE=\"${SUITE_VALUE}\"" "$TMP"
grep -q 'vitest run \$SUITE' "$TMP"
bash "$TMP"
