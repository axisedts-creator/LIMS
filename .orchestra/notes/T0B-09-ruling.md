TESTS_WRONG — §5 setup DELETE (db/tests/seeds/T0B-09_seeds.test.sql:93) runs with no claims sub and no app.maintenance, so the audit trigger must raise before any seed re-runs.
Reasons:
1. spec/chunks/C0-foundation-contracts/05-SCHEMA.md:978-990 — app.tg_row_audit raises `audit_context_missing` when neither claims sub nor app.maintenance is set; spec/program/08-CR-REGISTER.md:3063 (A28.5) says the same. The live error matches exactly (core.role_permissions, tg_row_audit line 20).
2. l.89 `pg_temp.rerun_done()` clears request.jwt.claims, so l.93 is a DELETE on an audited tenant row with no actor context. The implementation (seed 010) is never reached, so no seed change can fix it.
3. No spec text asks a test to remove audit context. The idempotence/healing requirement (task brief tests, AC-0A-6.1) is about the seed re-run, not the test's own setup step.
Change in the test (tester): right before l.93, set tenant-1 claims with the same system actor that seed 010 uses:
`SELECT set_config('request.jwt.claims', json_build_object('tenant_id',(pg_temp.tenants())[1],'sub','01a1b34e-1000-7eee-9d29-d7ca59a102b5','actor_type','system')::text, true);`
then the DELETE, then `SELECT pg_temp.rerun_done();` before l.95. Keep the l.98 assertion comparing only `core.role_permissions`, because the DELETE now writes one audit_log row on purpose. Do not set app.maintenance: that is only for maintenance DEFINERs (A28.5).
