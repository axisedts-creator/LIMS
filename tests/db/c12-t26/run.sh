#!/usr/bin/env bash
# C12 T-26 (chunk gate): throwaway migrated DB (tests/db/c12-t03/run.sh via its LIMS_C12T03_CMD hook, which exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1),
# then ONLY this task's vitest files, SEQUENTIALLY (timings must not compete): api gate dir (static + probes + perf) and the worker consumer perf file. Run from the repo root. Exit code = non-zero if either fails.
set -euo pipefail
export LIMS_C12T03_CMD='rc=0; pnpm --dir services/api exec vitest run src/modules/inventory/__tests__/gate --no-file-parallelism || rc=1; pnpm --dir services/worker exec vitest run src/jobs/inventory/consumers/__tests__/consumers.perf || rc=1; exit $rc'
exec bash tests/db/c12-t03/run.sh
