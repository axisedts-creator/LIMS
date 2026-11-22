TESTS_WRONG — settings.test.ts:202 asserts an absolute zero of tenant-B audit rows, which depends on earlier tests; the spec only requires that A's save writes nothing to B.
Change (tester): at :191 add `const beforeB = (await auditOf(TENANT_B)).length;` and replace :202 with `expect((await auditOf(TENANT_B)).length).toBe(beforeB);`. Nothing else changes.
Reasons:
- audit.audit_log rows record INSERT, UPDATE and DELETE of each audited row (spec/chunks/C0-foundation-contracts/05-SCHEMA.md:256, :265), so seed(TENANT_B) at :73, the put by ADMIN_B at :177 and the beforeEach wipe (:31, :48) each leave tenant-B rows.
- Audit tables are append-only and are not purged by C0 (01-PRD.md:32; 07-SECURITY.md:71; 05-SCHEMA.md:292), so the wipe cannot clear them and a count of 4 is correct behaviour, not a leak.
- The isolation the task brief asks for ("other tenant" test, done_when (3)) is still pinned by the delta check: A's save must add 0 rows for B.
- No source change is required.
