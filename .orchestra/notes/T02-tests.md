# T02 tests (tester) — smartreport repositories
- Files: `services/api/src/modules/smartreport/repository/__tests__/{repository.static,repository.integration}.test.ts`; DB harness `tests/db/c14-t02/{run.sh,fixtures.sql}`.
- Run: `.orchestra\notes\T02-verify.cmd` (needs docker; pinned PG17, migrations+seeds, smartreport DDL from db/migrations if C0 delivered it else extracted verbatim from spec 05-SCHEMA §9, then `pnpm --dir services/api exec vitest run src/modules/smartreport/repository/__tests__`).
- Covers: explicit tenant filter (RLS bypassed), optimistic `version` updates (conflict/not_found/patch allow-list/trigger propagation), inserts, statement hygiene, EXPLAIN on every 05-SCHEMA §5 index (queue, live-summary, rules-by-kind, ...), query semantics.
- Function names/signatures NOT pinned by spec are listed in the header of repository.integration.test.ts (insertX/getX/listX/updateX per repo file) — writer must match them.
- Writer notes: live summary must use `status IN ('draft','approved','rejected')` (partial index); jsonb values (content, items) are serialised by the repo; list fns are active-only unless `{includeInactive:true}`.
- Expected now: static suite fails (no repo files); integration suite fails with `Cannot find module '../library.repo.js'`. Harness/fixtures smoke-checked separately (see below if run).
