#!/usr/bin/env bash
# FD-T07: runs the FD-T07 suites against a throwaway PG17 booted exactly like FD-T03 (roles -> migrations -> graphile-worker -> seeds):
#   1. services/api  src/modules/frontdesk/__tests__/approvals   (F15-F19 + F9 consumption + static)
#   2. services/worker src/jobs/frontdesk/__tests__               (discount_approval_expire wiring + live; LIMS_TEST_DATABASE_URL = the superuser URL)
# Reuses tests/frontdesk/FD-T03.pg.sh's boot logic with only the suite step replaced, so the two cannot drift. Run from the repo root. Exit code = first failing vitest's.
# If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/fdt07.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed -e 's#^SUITE=.*#SUITE="src/modules/frontdesk/__tests__/approvals"#' \
    -e 's#^run_vitest() .*#run_vitest() { rc=0; pnpm --dir services/api exec vitest run "$SUITE" || rc=1; LIMS_TEST_DATABASE_URL="$LIMS_TEST_SUPER_URL" npx vitest run services/worker/src/jobs/frontdesk/__tests__ || rc=1; return $rc; }#' \
    tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q '__tests__/approvals' "$TMP"
grep -q 'services/worker/src/jobs/frontdesk/__tests__' "$TMP"
bash "$TMP"
