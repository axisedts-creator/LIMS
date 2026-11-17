#!/usr/bin/env bash
# FD-T15: runs the FD-T15 vitest suite (services/api src/modules/frontdesk/__tests__/admin: F24 settings, F25 codes, F7 anonymise, F26 duplicates) against a throwaway PG17 booted exactly
# like FD-T03 (roles -> migrations -> graphile-worker -> seeds). Reuses tests/frontdesk/FD-T03.pg.sh's boot logic with only the suite step replaced, so the two can never drift.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/fdt15.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed -e 's#^SUITE=.*#SUITE="src/modules/frontdesk/__tests__/admin"#' \
    -e 's#^run_vitest() .*#run_vitest() { pnpm --dir services/api exec vitest run "$SUITE" --no-file-parallelism --fsModuleCache=false; }#' \
    tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q '__tests__/admin' "$TMP"
grep -q 'no-file-parallelism' "$TMP"
bash "$TMP"
