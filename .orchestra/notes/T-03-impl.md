# T-03 impl (writer)
- Files: `repository/base.repo.ts` (RepoCtx, table allowlists, insertRow/getRow/updateRow, $1 = ctx tenant always), `specimens|orders|orderTests|results|labSettings|barcodeCounters|deltaRules|codedSets|ingest.repo.ts`; `services/api/package.json` + `pnpm-lock.yaml` (+6 lines): devDeps `pg`/`@types/pg` 8.23.1 (tester-required; lockfile is C0's, LD-05).
- [CONV] column allowlists copied from the lab DDL; mutable = enforce_mutable_columns list where a trigger exists, else all columns minus system/key/identity (results: lock-trigger tuple frozen); tables with no `version` column are append-only.
- [CONV] bad patch/insert key, bad ctx or bad limit (1..1000) -> `common.internal` (programming error), nothing sent; non-uuid id -> null / [] / `common.not_found`.
- [CONV] partial-index lists repeat the index predicate as a literal IN (...) so the planner can prove it; coded sets: tenant row shadows the global row with the same code.
- Ran: typecheck clean; static tests 11/12 pass, the 12th's table count is wrong -> see T-03-dispute.md (spec has 32 tables, test expects >=34).
- NOT run: integration suite. run.sh stops at migration `20261105002200_storage__create_buckets.sql: ERROR: permission denied for schema storage` (harness/C0 issue, before vitest starts; run.sh also exits 0 here because of my `| tail`). EXPLAIN/index plans are unverified.
- Open: tester fixes the harness storage grant + the count in the static test; then run the live suite, expecting possible planner tweaks.
