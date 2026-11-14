CR_NEEDED — the spec itself is contradictory/missing (write the CR text into `.orchestra/cr/T0B-03.md` using spec/program/04-CHANGE-REQUESTS.md)
1. Dispute item 2 (audit test 78, db/tests/core/T0B-03_audit.test.sql:228-229): test is right per intent, spec DDL is defective.
   05-SCHEMA.md:888-889 `audit_log__actor__ck` evaluates NULL (= pass) when detail IS NULL, yet 05-SCHEMA.md:269, :275, :277 and
   08-CR-REGISTER.md:3063 (A28.5) say actor_id NULL only for maintenance rows carrying detail.maintenance. Impl must copy §10 verbatim,
   so only a spec change fixes it. CR written to .orchestra/cr/T0B-03.md (coalesce(detail ? 'maintenance', false)); non-blocking.
2. Dispute item 1 (db/tests/core/T0B-03_schema.test.sql:149-152): separate TESTS_WRONG. No spec line requires anything about types;
   pgTAP is(anyelement, anyelement) cannot resolve (name, text). Tester change: `SELECT a.attname::text` in the subquery at line 149
   (and line 145 for consistency). Index columns asserted are as spec'd; writer's scratch run with the cast = 168/0.
3. Implementation: no change required for T0B-03 on either item.
4. Out of scope (pre-existing, not T0B-03): T0B-02_helpers test 56, roles-test collation abort — route to their own tasks.
