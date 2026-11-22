#!/usr/bin/env bash
# T0D-BUILD-1: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations -> graphile-worker -> seeds) and runs vitest over this task's api tests: the new account summaries
# tests (accounts/summaries*.test.ts), the whole billing accounts suite (shared kit, getAccountSummary), the guard / pending / cross tenant / boot tests that name the operation.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
DEFAULT="src/modules/billing/__tests__/accounts:src/modules/billing/__tests__/contract/acctlist1.pending.test.ts:src/modules/billing/__tests__/authz6.billing-guards.test.ts:src/modules/billing/__tests__/probes/crossTenant.handlers.test.ts:src/modules/billing/__tests__/unit/boot.test.ts"
FILTERS="$(echo "${BUILD1_SUITE:-$DEFAULT}" | tr ':' ' ')"
TMP="$(mktemp "${TMPDIR:-/tmp}/build1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^run_vitest().*#run_vitest() { pnpm --dir services/api exec vitest run $FILTERS; }#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^run_vitest() { pnpm --dir services/api exec vitest run " "$TMP"
bash "$TMP"
