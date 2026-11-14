TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
1. Fixture db/tests/core/T0B-05_platform.test.sql:134-135 inserts identity.platform_staff with `role_code = 'platform_admin'`; no such role exists in the spec.
2. Spec role set is exactly `platform_superadmin`, `platform_support`: spec/chunks/C2-identity-admin/05-SCHEMA.md:174; spec/chunks/C0-foundation-contracts/05-SCHEMA.md:242.
3. The migration CHECK db/migrations/20261105001300_identity__create_identity_schema.sql:59 enforces that set verbatim, so the insert correctly fails; implementation is not at fault.
4. dl_* functions are gated by `platform.dead_letter.manage`, roles `[platform_superadmin]` only: spec/program/03-INTERFACE-CATALOG.md:3003.
5. Change: on lines 134 and 135 replace `'platform_admin'` with `'platform_superadmin'`. No other change to the fixture.
6. Matches LD-36. Earlier max_attempts ruling (queue.test.sql:49 `max_attempts::int`) stands; implementation then continues with LD-31.
7. Queue file tests 6-23 never ran; any failure there after this fix is a fresh finding, not covered by this ruling.
