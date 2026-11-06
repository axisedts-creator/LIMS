# T0B-03 dispute (writer)

Run: throwaway `supabase/postgres:17.11.0.018` container, bootstrap + all 7 migrations applied from empty as lims_migrator (`psql -1`),
pgTAP files run as superuser. node suite 20/20; isolation 216/216; audit 92/93; schema aborts at line 152.

1. `db/tests/core/T0B-03_schema.test.sql:152` — test defect. `SELECT is((SELECT a.attname ...), col, ...)`: `attname` is type `name`,
   `col` is `text` → `ERROR: function is(name, text, text) does not exist`, txn aborts, rest of file never runs.
   Fix (tester): `a.attname::text`. With that one cast applied to a scratch copy: 168 ok / 0 not ok.
2. `db/tests/core/T0B-03_audit.test.sql:228-229` (test 78, "NULL actor_id without detail.maintenance is refused") — test is right,
   spec DDL is wrong. `audit_log__actor__ck` (05-SCHEMA §10, copied verbatim) is
   `(actor_id IS NOT NULL AND created_by IS NOT NULL) OR (actor_id IS NULL AND created_by IS NULL AND actor_type = 'system' AND detail ? 'maintenance')`.
   With `detail` NULL, `detail ? 'maintenance'` is NULL → whole CHECK is NULL → row accepted. Can't fix in impl without
   departing from verbatim text (the node suite asserts that exact text), so filed `.orchestra/cr/T0B-03.md`.
   Practical exposure is small (only lims_owner can INSERT audit_log; tg_row_audit always sets detail when actor_id is NULL), but A28.5 intent is violated.

Not T0B-03 (seen in the same run, pre-existing): T0B-02_helpers test 56 (lims_owner default table ACL) fails; roles test aborts on a
collation error in `results_eq` on this image.
