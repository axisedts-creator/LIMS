#!/usr/bin/env bash
# T0B-ACCT-2: boots a throwaway PG17 exactly like FD-T03 (roles -> migrations incl. 20261117120000_billing__add_lab_accounting.sql -> graphile-worker -> seeds) and runs vitest over the
# WHOLE src/modules/billing suite (new expense / cash transfer / daily summary tests + every existing billing test, ACCT-1 included). Nothing is narrowed. Quick look while developing:
#   ACCT2_SUITE=src/modules/billing/__tests__/accounts bash tests/billing/T0B-ACCT-2.pg.sh   (the verify script never sets it).
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/acct2.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed "s#^SUITE=.*#SUITE=\"${ACCT2_SUITE:-src/modules/billing}\"#" tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q "^SUITE=\"${ACCT2_SUITE:-src/modules/billing}\"" "$TMP"
bash "$TMP"
