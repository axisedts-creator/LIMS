# PLATFORM-DDL-1 dispute (writer)
**Test:** `services/api/src/modules/identity/__tests__/platform-ddl-1.static.test.ts` line 56, in `A: ... additive only`:
`expect(stmts(sql).every((x) => /^create policy/i.test(x))).toBe(true);` for `20261115191000_identity__add_platform_policies.sql`.

**Why it is wrong:** it forbids every statement except `CREATE POLICY`, so the file cannot start with `SET LOCAL ROLE lims_owner;`.
`db/tools/check-migrations.ts:35-36` (part of `pnpm verify`) REQUIRES that exact first statement in every migration
("first statement must be the owner role switch `SET LOCAL ROLE lims_owner;`"). CREATE POLICY also needs the table owner (lims_owner).
All 13 other `20261115*` migrations and `20261105001400_core__create_tenant_platform_policies.sql` (the precedent of 3 `__platform` policies only) start with it.
The two requirements cannot both hold: with the role switch the test fails, without it check-migrations fails and Atlas runs the file as the wrong role.

**Proposed fix (tester):** allow the one role switch, e.g.
`expect(stmts(sql).filter((x) => !/^set\s+local\s+role\s+lims_owner$/i.test(x)).every((x) => /^create policy/i.test(x))).toBe(true);`
(the other `additive only` regexes on line 54-55 stay as they are and still pass: no DROP / ALTER / GRANT / DEFINER / CREATE ROLE).

Also: `policies(sql)` has 19 entries only if the role switch is not counted, which it is not (it filters on `create policy`). Line 79 for F2 is fine
(I add `ALTER TABLE ... OWNER TO lims_owner` after the role switch because `set local role lims_owner` does not match `set role lims_owner`).

Writer stopped: no migration written yet (nothing else in the task conflicts with the tests). Waiting for the arbiter.
