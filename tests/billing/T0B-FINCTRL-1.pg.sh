#!/usr/bin/env bash
# T0B-FINCTRL-1: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations incl. 20261117190000_billing__add_finance_controls.sql -> graphile-worker -> seeds) and runs vitest over
# this task's tests: billing finctrl/ (slabs, policy, hold, fiscalYear, carryForward, static), the billing accounts suites (the shared kit gained two optional fields), the FINCTRL pending
# and cross tenant probes, both boot tests, and the frontdesk discount approval suites (the new limits.test.ts + every existing FD-T07 file, unchanged).
# Whole-suite check (three runs in a row, done_when 8): FINCTRL_SUITE=src/modules/billing:src/modules/frontdesk bash tests/billing/T0B-FINCTRL-1.pg.sh, repeated.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
DEFAULT="src/modules/billing/__tests__/finctrl:src/modules/billing/__tests__/accounts:src/modules/billing/__tests__/contract/finctrl1.pending.test.ts:src/modules/billing/__tests__/probes/crossTenant.handlers.test.ts:src/modules/billing/__tests__/unit/boot.test.ts:src/modules/frontdesk/__tests__/approvals:src/modules/frontdesk/__tests__/unit/boot.test.ts"
FILTERS="$(echo "${FINCTRL_SUITE:-$DEFAULT}" | tr ':' ' ')"
TMP="$(mktemp "${TMPDIR:-/tmp}/finctrl1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^run_vitest().*#run_vitest() { pnpm --dir services/api exec vitest run $FILTERS; }#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^run_vitest() { pnpm --dir services/api exec vitest run " "$TMP"
bash "$TMP"
