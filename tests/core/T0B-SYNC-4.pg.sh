#!/usr/bin/env bash
# T0B-SYNC-4: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations -> graphile-worker -> seeds) and runs vitest from the services/api package over THIS task's tests only:
# src/core/sync/__tests__/adapters (static + live adapter tests of SYNC-3 and SYNC-4), the revised default-registry test in src/core/sync/__tests__/push.live.test.ts and the print path unit test
# src/modules/reporting/__tests__/printOffline.test.ts. The existing lab / reporting / billing suites, the boot test and the three-runs-in-a-row check belong to the writer / reviewer verify.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
SUITE_VALUE="${SYNC4_SUITE:-src/core/sync/__tests__/adapters src/core/sync/__tests__/push.live.test.ts src/modules/reporting/__tests__/printOffline.test.ts}"
TMP="$(mktemp "${TMPDIR:-/tmp}/sync4.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^SUITE=.*#SUITE=\"${SUITE_VALUE}\"#; s#vitest run \"\$SUITE\"#vitest run \$SUITE#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^SUITE=\"${SUITE_VALUE}\"" "$TMP"
grep -q 'vitest run \$SUITE' "$TMP"
bash "$TMP"
