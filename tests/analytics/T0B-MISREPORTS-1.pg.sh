#!/usr/bin/env bash
# T0B-MISREPORTS-1: boots the throwaway PG17 exactly like FD-T03.pg.sh / T0B-TESTMGMT-1.pg.sh (roles -> migrations -> graphile-worker -> seeds) and runs, against it,
# the WHOLE analytics module suite (new misreports + probes + CI gate tests and every existing test) plus the module boot tests, LIMS_RUNS times in a row (default 3, done_when 6).
# Always through the package (pnpm --dir services/api exec vitest run src/...): services/api/vitest.config.ts supplies the test environment. Run from the repo root.
# If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started. Exit code = the first failing vitest run.
# Needs docker (or a migrated + seeded PG17 behind the two URLs) and bash (the no-commission gate test spawns it).
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/misreports1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed 's#^run_vitest().*#run_vitest() { for i in $(seq 1 "${LIMS_RUNS:-3}"); do echo "== T0B-MISREPORTS-1 run $i of ${LIMS_RUNS:-3}"; pnpm --dir services/api exec vitest run src/modules/analytics src/core/__tests__/boot.test.ts src/core/__tests__/pending-operations.test.ts src/__tests__/real-modules-boot.test.ts || return $?; done; }#' tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q 'LIMS_RUNS' "$TMP"
bash "$TMP"
