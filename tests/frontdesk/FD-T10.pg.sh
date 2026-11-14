#!/usr/bin/env bash
# FD-T10: runs the FD-T10 suites against a throwaway PG17 booted exactly like FD-T03 (roles -> migrations -> graphile-worker -> seeds):
#   1. services/api    src/modules/frontdesk/__tests__/trf         (F20 uploadTrf, F21 getTrfAttachment, F21a content + static)
#   2. services/worker src/jobs/frontdesk/__tests__/trf.*.test.ts   (trf_scan + trf_draft_purge wiring + live; LIMS_TEST_DATABASE_URL = the superuser URL)
# Reuses tests/frontdesk/FD-T03.pg.sh's boot logic with only the suite step replaced, so the two cannot drift. Run from the repo root. Exit code = first failing vitest's.
# If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/fdt10.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed -e 's#^SUITE=.*#SUITE="src/modules/frontdesk/__tests__/trf"#' \
    -e 's#^run_vitest() .*#run_vitest() { rc=0; pnpm --dir services/api exec vitest run "$SUITE" --no-file-parallelism || rc=1; LIMS_TEST_DATABASE_URL="$LIMS_TEST_SUPER_URL" npx vitest run services/worker/src/jobs/frontdesk/__tests__/trf.wiring.test.ts services/worker/src/jobs/frontdesk/__tests__/trf.live.test.ts || rc=1; return $rc; }#' \
    tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q '__tests__/trf' "$TMP"
grep -q 'trf.live.test.ts' "$TMP"
bash "$TMP"
