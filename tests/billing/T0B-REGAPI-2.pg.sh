#!/usr/bin/env bash
# T0B-REGAPI-2 (LD-323): boots a throwaway PG17 exactly like FD-T03 and runs the REAL-implementation tests of BillingCommandPortV1.previewInvoiceNo
# (src/modules/billing/__tests__/preview). The billing boot / cross tenant probes are covered by the T0B-ACCT-x scripts.
# Run from the repo root. Exit code = vitest's. If LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are already exported, no container is started.
set -euo pipefail
TMP="$(mktemp "${TMPDIR:-/tmp}/regapi2b.XXXXXX.sh")"
trap 'rm -f "$TMP"' EXIT
sed 's#^SUITE=.*#SUITE="src/modules/billing/__tests__/preview"#' tests/frontdesk/FD-T03.pg.sh > "$TMP"
grep -q '^SUITE="src/modules/billing/__tests__/preview"' "$TMP"
bash "$TMP"
