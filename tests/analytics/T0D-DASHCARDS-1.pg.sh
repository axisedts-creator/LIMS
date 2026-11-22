#!/usr/bin/env bash
# T0D-DASHCARDS-1: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations -> graphile-worker -> seeds) and runs the api tests of this task:
# the live equality test (dashboard tiles == listAccountSummaries / getDailyCash on one fixture), the in-memory tile tests and the existing dashboard handler / security / probe tests.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
DEFAULT="src/modules/analytics/__tests__/dashcards1.live.test.ts:src/modules/analytics/handlers/__tests__/dashcards1.handler.test.ts:src/modules/analytics/handlers/__tests__/dashboard.handler.test.ts:src/modules/analytics/handlers/__tests__/t14.security.test.ts:src/modules/analytics/__tests__/probes/tenant.rollups.probe.test.ts"
FILTERS="$(echo "${DASHCARDS1_SUITE:-$DEFAULT}" | tr ':' ' ')"
TMP="$(mktemp "${TMPDIR:-/tmp}/dashcards1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^run_vitest().*#run_vitest() { pnpm --dir services/api exec vitest run $FILTERS; }#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^run_vitest() { pnpm --dir services/api exec vitest run " "$TMP"
bash "$TMP"
