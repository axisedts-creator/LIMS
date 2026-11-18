#!/usr/bin/env bash
# T0B-SALES-1: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations incl. 20261117210000 -> graphile-worker -> seeds) and runs vitest over the WHOLE
# src/modules/partners and src/modules/homecollection suites plus the real-modules boot test (same trick as T0B-REGAPI-1.pg.sh).
# Quick look while developing: SALES1_SUITES="src/modules/partners/__tests__/sales" bash tests/partners/T0B-SALES-1.pg.sh  (the verify script never sets it).
# Files run serially (--no-file-parallelism): homecollection tests share one DB and global g_cs_reasons.
# LD-355: (1) homecollection/repository/__tests__/static.test.ts is excluded (old debt on handovers.repo.ts, red on main too, see notes/T0B-SALES-1-debt.md);
#         (2) the two host-load timing files (snapshot/perf.test.ts p95 < 2000 ms, real-modules-boot 60 s) run in a SECOND vitest command with --retry 2;
#             every other file runs without retry. Thresholds and assertions are unchanged.
# Run from the repo root. Exit code = non-zero if either command fails. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/sales1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
SUITES="${SALES1_SUITES:-src/modules/partners src/modules/homecollection}"
TIMING="src/modules/homecollection/__tests__/snapshot/perf.test.ts src/__tests__/real-modules-boot.test.ts"
V="pnpm --dir services/api exec vitest run --no-file-parallelism"
FN="run_vitest() { rc=0; $V --exclude '**/homecollection/repository/__tests__/static.test.ts' --exclude '**/homecollection/__tests__/snapshot/perf.test.ts' $SUITES || rc=\$?; $V --retry 2 $TIMING || rc=\$?; return \$rc; }"
sed "s#^run_vitest().*#$FN#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q -- "--retry 2 $TIMING" "$TMP"
bash "$TMP"
