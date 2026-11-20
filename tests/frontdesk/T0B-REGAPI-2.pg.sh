#!/usr/bin/env bash
# T0B-REGAPI-2: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations incl. 20261117100000 / 20261117110000 and any later one -> graphile-worker -> seeds) and runs
# vitest over the WHOLE src/modules/frontdesk suite (new regapi2 tests + probes + boot + every existing frontdesk test), as T0B-REGAPI-1.pg.sh does. Nothing is narrowed (LD-314 / LD-315 c).
# For a quicker look while developing: REGAPI2_SUITE=src/modules/frontdesk/__tests__/regapi2 bash tests/frontdesk/T0B-REGAPI-2.pg.sh   (the verify script never sets it).
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/regapi2.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^SUITE=.*#SUITE=\"${REGAPI2_SUITE:-src/modules/frontdesk}\"#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^SUITE=\"${REGAPI2_SUITE:-src/modules/frontdesk}\"" "$TMP"
bash "$TMP"
