#!/usr/bin/env bash
# T0B-MSGDESK-1: runs the broadcast + partner ticket handler tests (every services/api file under a __tests__/msgdesk folder: engagement and partners) against a throwaway PG17
# booted exactly like FD-T03 (roles -> migrations incl. 20261117240000 -> graphile-worker -> seeds). Same trick as T0B-REGAPI-1.pg.sh: reuse FD-T03.pg.sh, only the suite filter replaced.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started
# (point them at a DB migrated through 20261117240000; the tests add and remove their own synthetic rows).
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/msgdesk1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed 's#^SUITE=.*#SUITE="__tests__/msgdesk"#' tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q 'SUITE="__tests__/msgdesk"' "$TMP"
bash "$TMP"
