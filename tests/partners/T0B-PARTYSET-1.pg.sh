#!/usr/bin/env bash
# T0B-PARTYSET-1: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations incl. 20261117220000 -> graphile-worker -> seeds) and runs vitest over the WHOLE
# src/modules/partners, src/modules/catalog and src/modules/billing suites, the new reporting wiring test and the real-modules boot test (same trick as T0B-SALES-1.pg.sh).
# Needs the T0C-PARTYSET-1 contract and migration on the tree (lane C0-0M merged), otherwise the migration and the 13 + 5 operations do not exist.
# Quick look while developing: PARTYSET1_SUITES="src/modules/partners/__tests__/partyset" bash tests/partners/T0B-PARTYSET-1.pg.sh  (the verify script never sets it).
# Files run serially (--no-file-parallelism): the tests share two tenants on one DB. The real-modules boot test (host load, 60 s) runs in a SECOND vitest command with --retry 2;
# every other file runs without retry, no assertion or threshold is changed.
# Run from the repo root. Exit code = non-zero if either command fails. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/partyset1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
SUITES="${PARTYSET1_SUITES:-src/modules/partners src/modules/catalog src/modules/billing src/modules/reporting/__tests__/partyset}"
TIMING="src/__tests__/real-modules-boot.test.ts"
V="pnpm --dir services/api exec vitest run --no-file-parallelism"
FN="run_vitest() { rc=0; $V $SUITES || rc=\$?; $V --retry 2 $TIMING || rc=\$?; return \$rc; }"
sed "s#^run_vitest().*#$FN#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q -- "--retry 2 $TIMING" "$TMP"
bash "$TMP"
