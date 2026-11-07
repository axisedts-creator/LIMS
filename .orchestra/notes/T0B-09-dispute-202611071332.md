# T0B-09 dispute (writer, 2026-11-07)
Test: `db/tests/seeds/T0B-09_seeds.test.sql` §5 "partial state is healed", l.93.
Live run (`bash db/tests/run-suites.sh db/tests/seeds/T0B-09_seeds.test.sql`): ok 1-23, then
`psql:...T0B-09_seeds.test.sql:94: ERROR:  audit_context_missing  DETAIL:  core.role_permissions  CONTEXT: app.tg_row_audit() line 20`.
Why the test is wrong: l.89 `pg_temp.rerun_done()` clears `request.jwt.claims` and RESETs role; l.93 then DELETEs a tenant row of an
audited table with no claims sub and no `app.maintenance`. `app.tg_row_audit` (20261105000200, 08 A28.5) must raise there. No seed change can
reach this statement: the failure is in the test's own setup, before 010 re-runs.
Proposed fix (tester): before the l.93 DELETE set claims for tenant 1, e.g.
`SELECT set_config('request.jwt.claims', json_build_object('tenant_id',(pg_temp.tenants())[1],'sub','01a1b34e-1000-7eee-9d29-d7ca59a102b5','actor_type','system')::text, true);`
(same system actor the 010 seed uses), DELETE, then `SELECT pg_temp.rerun_done();`. Note: this DELETE writes an audit_log row, so the
§5 assertion must keep comparing only `core.role_permissions` (it does, l.98).
