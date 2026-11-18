#!/usr/bin/env bash
# T0B-PRINTCFG-1: boots a throwaway PG17 like FD-T03 (roles -> migrations incl. 20261117160000_reporting__add_print_profiles_and_signatories.sql -> graphile-worker -> seeds) and runs vitest over the
# new print tests PLUS the WHOLE src/modules/reporting and src/modules/billing suites (nothing narrowed) with LIMS_TEST_APP_URL (lims_api) + LIMS_TEST_SUPER_URL. Run from the repo root. Exit code = vitest's.
# PRINTCFG_SUITE overrides the vitest paths for a quick look (the verify script never sets it). If both URLs are already exported no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/printcfg1.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
SUITE_PATHS="${PRINTCFG_SUITE:-src/modules/reporting src/modules/billing}"
# one file at a time: several suites share tenant A / B rows
sed "s#^SUITE=.*#SUITE=\"$SUITE_PATHS\"#; s#vitest run \"\$SUITE\"#vitest run --no-file-parallelism \$SUITE#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^SUITE=\"$SUITE_PATHS\"" "$TMP"
grep -q -- "--no-file-parallelism" "$TMP"
# seed core.g_task_registry 'reporting.render_print' (previewPrintProfile; ruling T0B-PRINTCFG-1-ruling.md point 3) right before the test URLs are exported
sed -i '/^export LIMS_TEST_APP_URL=/i SU -f /repo/tests/reporting/T0B-PRINTCFG-1.registry.sql' "$TMP"
grep -q "T0B-PRINTCFG-1.registry.sql" "$TMP"
LIMS_T03_REQUIRE_DB=1 bash "$TMP"
