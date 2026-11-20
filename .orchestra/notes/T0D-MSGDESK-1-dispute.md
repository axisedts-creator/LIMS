# T0D-MSGDESK-1 dispute (writer, round 4, LD-435, 2026-11-20)
TESTS_WRONG (not this task): after the LD-435 tester fixes, every verify suite passes except 2 tests in
apps/web/src/core/nav/__tests__/nav-complete.admin-pack.test.ts:
- :36 `expect(held.has('lab.result.approve')).toBe(false)`: the corp_admin pack in 11-ROLE-MATRIX.data.yaml now holds lab.result.approve.
- :93 "the Approve entry (lab.result.approve) is not visible": lab.approval (permission lab.result.approve) is visible to corp_admin.
These contradict the LD-435 fix itself (HIDDEN_NON_PLATFORM = [] because notes/T0D-NAV-COMPLETE-1-admin-hidden.md shows lab.approval is no longer hidden).
The branch changes no role pack, lab or core/nav source file. Fixing this in implementation would mean hiding lab.approval or editing spec/, and both are wrong.
Fix (tester or own task): re-pin both assertions to the current role matrix (or drop them with the same LD-435 reason). Otherwise drop vitest.nav-complete.config.ts from verify.cmd.
