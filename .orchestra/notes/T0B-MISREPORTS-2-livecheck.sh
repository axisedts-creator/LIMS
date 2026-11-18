#!/usr/bin/env bash
# scratch: runs ONLY commission.live.test.ts on the throwaway PG17 (the full gate is tests/analytics/T0B-MISREPORTS-2.pg.sh). Run from the repo root.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/m2live.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed 's#^run_vitest().*#run_vitest() { pnpm --dir services/api exec vitest run src/modules/analytics/__tests__/misreports/commission.live.test.ts; }#' tests/frontdesk/FD-T03.pg.sh > "$TMP"
bash "$TMP"
