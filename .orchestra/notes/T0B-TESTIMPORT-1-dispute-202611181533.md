# T0B-TESTIMPORT-1 dispute (writer, 2026-11-18)

Run on throwaway PG17 (import folder only): 132 passed, 48 failed. 46 of the 48 fail inside the test harness, not the implementation. Two test defects:

1. `__tests__/import/helpers.ts` `snapshot()` (line 59), `testsByTag()` (63) and `written()` in commit.test.ts (panels, line 22) query `catalog.tests.code` and
   `catalog.panels.code` (`code LIKE $2`). Those columns do not exist: `code` lives on `catalog.orderables` (20261105001500_catalog__create_catalog_schema.sql:243-289).
   Every call fails with `error: column "code" does not exist` (pg 42703) before any assertion: all of parser.test.ts `refused()` cases, the golden test of rules.test.ts,
   and almost all of commit.test.ts. Suggested fix (tester): join orderables, e.g. `catalog.tests WHERE tenant_id = $1 AND id IN (SELECT id FROM catalog.orderables
   WHERE tenant_id = $1 AND kind = 'test' AND code LIKE $2)`, same for panels with kind = 'panel'; testsByTag should return the orderable code (tests are compared by `.code`).
2. commit.test.ts:81 expects the import_batch UPDATE audit row's `new_values` to contain `file_sha256` and `counts`. `app.tg_row_audit` (20261105000200_core__create_tenants.sql:45-55)
   records ONLY the changed columns on UPDATE, and the import_batch guard trigger (20261117180000, by contract) forbids changing file_sha256 and counts. The assertion can never
   hold. Suggested fix: read file_sha256 / counts from the INSERT audit row (audit[0].new_values) and keep `status: 'committed'` + changed_columns on audit[1].

Not disputed: the 2 remaining failures (formula_division_by_zero) were mine and are fixed (the shared-ts AST is opaque; detection now uses evaluateFormula). Not re-run yet
because the harness defects above mask most of the suite. Stopping per the writer rules; no test file edited.
