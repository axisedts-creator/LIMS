#!/usr/bin/env bash
# CR TENANT-LOGO-1: boots a throwaway PG17 exactly like tests/frontdesk/FD-T03.pg.sh (roles -> migrations -> graphile-worker -> seeds)
# and runs the tenant logo live test against it. Run from the repo root. Exit code = vitest's.
# If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
SUITE_VALUE="src/modules/identity/service/__tests__/tenant-logo.live.test.ts"
TMP="$(mktemp "${TMPDIR:-/tmp}/tenantlogo1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^SUITE=.*#SUITE=\"${SUITE_VALUE}\"#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^SUITE=\"${SUITE_VALUE}\"" "$TMP"
bash "$TMP"
