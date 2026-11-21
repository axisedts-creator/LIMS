APPROVE
Scope: git diff 553f13266..HEAD (round 5). One code file changed: apps/web/src/core/nav/__tests__/nav-complete.admin-pack.test.ts, plus impl/ruling notes.
- The test change matches the arbiter ruling (TESTS_WRONG, LD-310 / T0B-ADMINPERM-1 ruling item 3) exactly: :2-4 header, :33/:36 now assert corp_admin holds lab.result.approve, :91-96 assert /lab/approval is visible with permission lab.result.approve.
- Fact check: services/api/src/modules/identity/role-packs/role-packs.data.yaml:125 (corp_admin, the file the test reads) holds lab.result.approve. The assertion is not weakened. It inverts a stale pin, it still checks the path and the permission name, and it matches HIDDEN_NON_PLATFORM = [] (LD-435).
- No source, RLS, permission, error-code, migration or secret change in this range. No PHI. No new names. The test path is the staff nav area (additive), the only other edits are .orchestra notes the roles own. Nothing touches features/admin, features/platform, app/(auth) or app/(platform).
- Ran: `npx vitest run src/core/nav/__tests__/nav-complete.admin-pack.test.ts` gave 12/12 passed.
- Open for the lead (not this task): the 11-ROLE-MATRIX R5 and data.yaml drift from LD-310 (T0B-ADMINPERM-1 ruling item 7).
