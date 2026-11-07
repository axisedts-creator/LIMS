APPROVE
Requested range d05e9fa..HEAD is empty (HEAD = d05e9fa); no new T0B-03 changes to review.
State re-checked at HEAD:
1. db/migrations/20261105000600_audit__create_audit_tables.sql:25-26: `audit_log__actor__ck` 2nd branch = `coalesce(detail ? 'maintenance', false)`, same name, LD-02 cited.
2. tests/db/T0B-03.core-tables.test.mjs:144: assertion matches LD-02 text.
3. db/tests/core/T0B-03_audit.test.sql:228-233: NULL-detail refusal, non-system refusal, system+maintenance accept present.
Changes since prior APPROVE (5345b2b) in db/ are T0B-06 files (membership_branches, identity definers, db/policies/core.sql +8); not T0B-03 scope.
Reviewer ran: `node --test tests/db/T0B-03.core-tables.test.mjs`, 20/20 pass.
Not run: pgTAP (needs throwaway Postgres). Verify step must run T0B-03_audit (lines 228-229 green per LD-02) and T0B-03_schema on an empty DB before merge.
