#!/usr/bin/env bash
# T0D-BUILD-2: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations -> graphile-worker -> seeds) and runs vitest over the partners settings tests, the settings pending/boot
# contract tests and the partners probe matrices (ST1-ST4, not-found), same trick as T0B-PARTYSET-1.pg.sh. Files run serially: the tests share two tenants on one DB.
# Run from the repo root. Exit code = non-zero if vitest fails. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/build2.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
SUITES="${BUILD2_SUITES:-src/modules/partners/__tests__/settings src/modules/partners/__tests__/contract src/modules/partners/__tests__/probes src/modules/partners/__tests__/boot.test.ts}"
FN="run_vitest() { pnpm --dir services/api exec vitest run --no-file-parallelism $SUITES; }"
sed "s#^run_vitest().*#$FN#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q -- "--no-file-parallelism $SUITES" "$TMP"
bash "$TMP"
