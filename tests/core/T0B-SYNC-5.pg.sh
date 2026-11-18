#!/usr/bin/env bash
# T0B-SYNC-5: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations -> graphile-worker -> seeds) and runs vitest from the services/api package over THIS task's tests only:
# src/core/sync/__tests__/hardening (load, chaos, retention, metrics, static) + the metrics registry test (additive EXPECTED names).
# The retention tests need the worker login: LIMS_TEST_WORKER_URL (lims_worker) is exported next to the two URLs FD-T03 exports. Never run against a shared database.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL, LIMS_TEST_SUPER_URL and LIMS_TEST_WORKER_URL are already exported, no container is started.
# The whole sync suite, the boot test and the three-runs-in-a-row check belong to the writer / reviewer verify (done_when 6).
set -euo pipefail
SUITE_VALUE="${SYNC5_SUITE:-src/core/sync/__tests__/hardening src/core/observability/__tests__/metrics.test.ts}"
TMP="$(mktemp "${TMPDIR:-/tmp}/sync5.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^SUITE=.*#SUITE=\"${SUITE_VALUE}\"#; s#vitest run \"\$SUITE\"#vitest run \$SUITE#; /^export LIMS_TEST_SUPER_URL=/a export LIMS_TEST_WORKER_URL=\"postgres://lims_worker:\$WORKER_PW@127.0.0.1:\$HOSTPORT/\$DB\"" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^SUITE=\"${SUITE_VALUE}\"" "$TMP"
grep -q 'vitest run \$SUITE' "$TMP"
grep -q '^export LIMS_TEST_WORKER_URL=' "$TMP"
bash "$TMP"
