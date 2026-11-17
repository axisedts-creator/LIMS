APPROVE
# T0B-PERF-1 re-review (reviewer), diff fb440bb5c..95639bff1

Both earlier findings are fixed:
1. `.orchestra/cr/T0B-PERF-1.md` follows the template in 04-CHANGE-REQUESTS.md §2. It asks to add `LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS` (15000), lower the `LIMS_CORE_DB_POOL_MAX` default from 20 to 10 (range 1..60) and update the C1 02-TRD:558 pgbouncer comment. The code stays as it is under LD-310.
2. In docs/ops/PRODUCTION-BAR.md the row is split. The static N+1 scan is "met by this task". "At most 4 queries for an empty list on real endpoints" is **not met** and the row gives the evidence.

Checks run: the verify set passed (41 files, 1426 passed, 24 skipped), and `tsc --noEmit` on services/api is clean. The rest of the first review still holds: names, no PHI in logs, no secrets, only owned paths, no handler, RLS, permission or idempotency surface touched.
Founder or follow-up items (not defects): measure the real empty-list query counts, the dependency audit (2 high, 3 critical), and hosting and cold start.
