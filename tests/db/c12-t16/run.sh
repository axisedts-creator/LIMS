#!/usr/bin/env bash
# C12 T-16: throwaway migrated DB (tests/db/c12-t03/run.sh via its LIMS_C12T03_CMD hook, which exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1),
# then ONLY this task's vitest file (lab.result.verified.v1.test.ts in services/worker/src/jobs/inventory/consumers/__tests__), run through the worker package. Run from the repo root. Exit code = vitest's.
set -euo pipefail
export LIMS_C12T03_CMD="pnpm --dir services/worker exec vitest run src/jobs/inventory/consumers/__tests__/lab.result.verified"
exec bash tests/db/c12-t03/run.sh
