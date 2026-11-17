#!/usr/bin/env bash
# J-T01: runs ONLY the J-T01 vitest files (services/api/src/modules/frontdesk/__tests__/integration/registration.billing-real.*) against a throwaway PG17 booted
# exactly like FD-T03 (roles -> migrations -> graphile-worker -> seeds). Reuses tests/frontdesk/FD-T03.pg.sh's boot logic with only the suite filter replaced.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/jt01.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed 's#^SUITE=.*#SUITE="src/modules/frontdesk/__tests__/integration/registration.billing-real"#' tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q 'registration.billing-real' "$TMP"
bash "$TMP"
