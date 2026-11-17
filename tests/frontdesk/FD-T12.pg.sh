#!/usr/bin/env bash
# FD-T12: runs the FD-T12 vitest suite (services/api src/modules/frontdesk/__tests__/consumers: static wiring + recollection + booking + catalog consumers) against a throwaway PG17 booted exactly
# like FD-T03 (roles -> migrations -> graphile-worker -> seeds). Reuses tests/frontdesk/FD-T03.pg.sh's boot logic with only the suite step replaced, so the two can never drift.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/fdt12.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed -e 's#^SUITE=.*#SUITE="src/modules/frontdesk/__tests__/consumers"#' \
    -e 's#^run_vitest() .*#run_vitest() { pnpm --dir services/api exec vitest run "$SUITE" --no-file-parallelism --fsModuleCache=false; }#' \
    tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q '__tests__/consumers' "$TMP"
grep -q 'no-file-parallelism' "$TMP"
bash "$TMP"
