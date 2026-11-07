CHANGES
Diff ee06d1c..HEAD only adds .orchestra/notes/T0B-03-verify.cmd and renames 3 CR files; the binding LD-02 and the T0B-03 ruling fixes were never applied.
Static suite tests/db/T0B-03.core-tables.test.mjs: 20/20 pass (run by reviewer). pgTAP not run here; finding 1 is still a real defect, because a NULL CHECK result counts as a pass.

1. db/migrations/20261105000600_audit__create_audit_tables.sql:26 — LD-02 not applied. When detail IS NULL, `detail ? 'maintenance'` returns NULL and the CHECK passes, so db/tests/core/T0B-03_audit.test.sql:228-229 (refuse NULL actor_id without detail.maintenance) fails.
   Fix (writer): replace `AND detail ? 'maintenance'))` with `AND coalesce(detail ? 'maintenance', false)))` and keep the constraint name audit_log__actor__ck. Add the comment `-- LD-02 (2026-11-07), 08 A28.5`.
2. tests/db/T0B-03.core-tables.test.mjs:144 — LD-02 requires this assertion to be updated, and it still asserts the old text.
   Fix (tester): change the regex tail to `actor_type = 'system' AND coalesce\(detail \? 'maintenance', false\)\)\)/`.
3. db/tests/core/T0B-03_schema.test.sql:145 and :149 — ruling item 2 not applied. `is(name, text)` cannot resolve, so these assertions abort.
   Fix (tester): `SELECT a.attname::text` in both subqueries.
