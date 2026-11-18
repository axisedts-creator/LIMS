#!/usr/bin/env bash
# T0B-CONTENT-1: boots the throwaway PG17 exactly like FD-T03.pg.sh / T0B-TESTIMPORT-1.pg.sh (roles -> migrations incl. 20261117130000_engagement__add_portal_content -> graphile-worker -> seeds)
# and runs, against it, the WHOLE engagement module suite (new content tests + every existing test, unchanged) plus the boot tests, LIMS_RUNS times in a row (default 2: flake check).
# Always through the package (pnpm --dir services/api exec vitest run src/...): services/api/vitest.config.ts supplies the test environment. Run from the repo root.
# Needs lane/C0-0C merged into the lane branch (contract operations, the portal_content / profile_image migration, permissions). If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/content1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed 's#^run_vitest().*#run_vitest() { for i in $(seq 1 "${LIMS_RUNS:-2}"); do echo "== T0B-CONTENT-1 run $i of ${LIMS_RUNS:-2}"; pnpm --dir services/api exec vitest run src/modules/engagement src/core/__tests__/boot.test.ts src/core/__tests__/pending-operations.test.ts src/__tests__/real-modules-boot.test.ts || return $?; done; }#' tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q 'LIMS_RUNS' "$TMP"
bash "$TMP"
