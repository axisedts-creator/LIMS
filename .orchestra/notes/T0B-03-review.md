APPROVE
Re-review of ee06d1c..HEAD after the fix commits 6aae9f1 and 2b54f13. All 3 items from the earlier CHANGES review are fixed:
1. db/migrations/20261105000600_audit__create_audit_tables.sql:26: `audit_log__actor__ck` 2nd branch is now `coalesce(detail ? 'maintenance', false)`. Constraint name unchanged, LD-02 cited. A NULL detail now evaluates to false, so the CHECK rejects it (this is what audit test lines 228-229 expect).
2. tests/db/T0B-03.core-tables.test.mjs:144: assertion matches the new text (LD-02).
3. db/tests/core/T0B-03_schema.test.sql:145,149: `a.attname::text` added in both subqueries (ruling item 2).
Grep finds no remaining uncoalesced `detail ? 'maintenance'` in db/ or tests/.
Reviewer ran: `node --test tests/db/T0B-03.core-tables.test.mjs`, 20/20 pass.
Not run: pgTAP. It needs a throwaway Postgres, and the writer did not re-run it either. Before merge, the verify step should run T0B-03_audit and T0B-03_schema on an empty DB.
