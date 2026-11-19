#!/usr/bin/env bash
# T0B-REGAPI-1: runs the new patient API tests plus every existing frontdesk module test against a throwaway PG17 booted exactly like FD-T03
# (roles -> migrations incl. 20261117100000 -> graphile-worker -> seeds). Same trick as FD-T04.pg.sh: reuse FD-T03.pg.sh with only the suite path replaced.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/regapi1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed 's#^SUITE=.*#SUITE="src/modules/frontdesk"#' tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q 'SUITE="src/modules/frontdesk"' "$TMP"
bash "$TMP"
