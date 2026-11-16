TESTS_WRONG — the disputed tests assert that provisionTenant seeds the IRD annexes. The binding amended brief (LD-295, which overrides the spec for this task) forbids that call.
1. The dispute (.orchestra/notes/T0B-PROVFIX-1-dispute.md:3-8) is correct: there is no code-only placement of seedIrdAnnexes. Outside the scope the audit_log row is refused. Inside it, services/api/src/core/db/tx.ts:186 sets system claims, so ird_annex_records__insert__platform refuses the row. LD-295 FACT 1 agrees and calls the LD-294 premise a "lead error".
2. LD-295 RULING (a) and done_when (1), inbox brief lines 19 and 33: provisionTenant no longer calls seedIrdAnnexes. It keeps the repository function, the TENANT_ANNEXES constant and one comment line (LD-295, T0B-PROVFIX-3).
3. Change in services/api/src/modules/identity/service/__tests__/tenant.service.test.ts:
   - Delete the test at line 38 ("seedIrdAnnexes is the FIRST statement INSIDE ..."), as done_when (2) requires: "Remove the tests that required the seed as the first scoped statement".
   - Delete the test at line 56 (the annex failure propagates). The call no longer exists.
   - Line 52: remove 'seedIrdAnnexes' from the inside-scope method list. Keep the OUTSIDE_OK = {findByCode, core.tenants insert} assertion.
   - Line 64: replace the annex_2/3/7 expectations (line 64 and the annexes part of line 65) with `expect(f.by('seedIrdAnnexes')).toHaveLength(0)` and `expect(f.data(id).annexes).toEqual([])`. Name the test "provisionTenant does not call seedIrdAnnexes (LD-295)".
4. tenant.helpers.ts:126: the fake scope check (sc) stays. done_when (2) says "a write to an audited tenant table outside the scope fails".
5. The spec gives no rule for where the annexes go at provisioning (plan row has no further constraint). No CR is needed for this dispute. The migration is the nonblocking CR that done_when (4) requires, reserved as T0B-PROVFIX-3.
