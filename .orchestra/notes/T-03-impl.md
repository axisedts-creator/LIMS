# T-03 impl (writer)
- Files: `repository/base.repo.ts` (RepoCtx, table allowlists, insertRow/getRow/updateRow, $1 = ctx tenant always), `specimens|orders|orderTests|results|labSettings|barcodeCounters|deltaRules|codedSets|ingest.repo.ts`; `services/api/package.json` + `pnpm-lock.yaml` (+6 lines): devDeps `pg`/`@types/pg` 8.23.1 (tester-required; lockfile is C0's, LD-05).
- [CONV] column allowlists copied from the lab DDL; mutable = enforce_mutable_columns list where a trigger exists, else all columns minus system/key/identity (results: lock-trigger tuple frozen); tables with no `version` column are append-only.
- [CONV] bad patch/insert key, bad ctx or bad limit (1..1000) -> `common.internal` (programming error), nothing sent; non-uuid id -> null / [] / `common.not_found`.
- [CONV] partial-index lists repeat the index predicate as a literal IN (...) so the planner can prove it; coded sets: tenant row shadows the global row with the same code.
- Ran (after ruling, 6894c99): static tests 12/12 pass. No impl change (ruling: none required).
- NOT run: integration suite. `bash tests/db/c5-t03/run.sh` exits 3 at migration `20261105002200_storage__create_buckets.sql:20: ERROR: permission denied for schema storage` (before vitest; harness/C0 grant, cf. .orchestra/cr/T0B-12, not writer-owned). EXPLAIN/index plans are unverified.
- Open: tester/C0 grant lims_owner USAGE on schema storage + INSERT/UPDATE on storage.buckets in harness; then rerun live suite, expect possible planner tweaks.
