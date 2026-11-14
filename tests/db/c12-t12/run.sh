#!/usr/bin/env bash
# C12 T-12: throwaway migrated DB (tests/db/c12-t03/run.sh via its LIMS_C12T03_CMD hook, which exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1),
# then ONLY this task's vitest files (receipts.contract.test.ts + receipts.integration.test.ts in modules/inventory/handlers/__tests__, domain/__tests__/csv.test.ts). Run from the repo root. Exit code = vitest's.
set -euo pipefail
export LIMS_C12T03_CMD="pnpm --dir services/api exec vitest run src/modules/inventory/handlers/__tests__/receipts src/modules/inventory/domain/__tests__/csv"
exec bash tests/db/c12-t03/run.sh
