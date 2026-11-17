#!/usr/bin/env bash
# T0B-SALES-1: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations incl. 20261117210000 -> graphile-worker -> seeds) and runs vitest over the WHOLE
# src/modules/partners and src/modules/homecollection suites plus the real-modules boot test (nothing narrowed; same trick as T0B-REGAPI-1.pg.sh).
# Quick look while developing: SALES1_SUITES="src/modules/partners/__tests__/sales" bash tests/partners/T0B-SALES-1.pg.sh  (the verify script never sets it).
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/sales1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
SUITES="${SALES1_SUITES:-src/modules/partners src/modules/homecollection src/__tests__/real-modules-boot.test.ts}"
sed "s#^run_vitest().*#run_vitest() { pnpm --dir services/api exec vitest run $SUITES; }#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^run_vitest() { pnpm --dir services/api exec vitest run $SUITES; }" "$TMP"
bash "$TMP"
