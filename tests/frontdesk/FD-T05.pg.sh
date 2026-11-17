#!/usr/bin/env bash
# FD-T05: runs the FD-T05 vitest suite (services/api/src/modules/frontdesk/__tests__/quote) against a throwaway PG17 booted exactly like FD-T03
# (roles -> migrations -> graphile-worker -> seeds). Reuses tests/frontdesk/FD-T03.pg.sh's boot logic with only the suite path replaced, so the two can never drift.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/fdt05.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed 's#^SUITE=.*#SUITE="src/modules/frontdesk/__tests__/quote"#' tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q '__tests__/quote' "$TMP"
bash "$TMP"
