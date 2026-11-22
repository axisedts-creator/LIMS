# T0D-BUILD-2 dispute (writer, round 3, 2026-11-22 ~15:30 NPT, after LD-451 reset; docker up, PG17 ran)

Result of tests/partners/T0D-BUILD-2.pg.sh: 860 pass, 1 fail. Web step not run (PG step failed first).

FAIL settings/settings.test.ts:202 `expect(await auditOf(TENANT_B)).toHaveLength(0)` — got 4.
Why the test is wrong (no source fault): audit.audit_log is append-only and beforeEach(wipeSettings) only deletes partners.settings, so
earlier tests in the same file leave tenant-B audit rows: :73 seed(TENANT_B) INSERT, wipe DELETE, :177 put by ADMIN_B INSERT, wipe DELETE = 4.
The rows are tenant B's own writes, not a leak of the tenant-A save. An absolute zero depends on test order.
Change: take `const beforeB = (await auditOf(TENANT_B)).length;` next to `before` at :191 and assert at :202
`expect((await auditOf(TENANT_B)).length).toBe(beforeB);` (keeps the "A's save writes nothing to B" guard).
No source change made.
