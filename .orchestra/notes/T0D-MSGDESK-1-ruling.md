TESTS_WRONG — apps/web/src/core/nav/__tests__/nav-complete.admin-pack.test.ts:36 and :91-94 pin the pre-LD-310 corp_admin set; main's pack (binding LD-310 via T0B-ADMINPERM-1) grants lab.result.approve, and T0D-MSGDESK-1 changes neither the pack nor lab/nav source.
Reasons:
1. spec/program/11-ROLE-MATRIX.md:18 and :30 (R5, "holds no clinical sign-off") and spec/program/11-ROLE-MATRIX.data.yaml:7-126 (corp_admin has no lab.result.approve) are the text these two assertions copy.
2. That text was overridden for corp_admin by LD-310 ("admin should get all features"): .orchestra/notes/T0B-ADMINPERM-1-ruling.md items 1-3 ruled TESTS_WRONG, exempted corp_admin only from the R2/R5 "no clinical sign-off" pins, and item 7 left the spec drift to the lead. Commit b2a7c6608 added lab.result.approve to services/api/src/modules/identity/role-packs/role-packs.data.yaml:125 (on main).
3. The test reads that API file (nav-complete.admin-pack.test.ts:16), so on main both assertions fail no matter what this branch does. `git diff main...HEAD` touches no role pack, identity, lab or core/nav source file.
4. LD-435 already set HIDDEN_NON_PLATFORM = [] (test :22-23) because the generated report shows lab.approval is visible. Keeping :36/:93 contradicts that same fix.
5. Making it pass in implementation would mean hiding staff.lab.approval (spec/program/03-INTERFACE-CATALOG.md:2505 registers it under lab.result.approve) or reverting LD-310. Both are wrong and outside this task's files.
CHANGE IN THE TEST (tester, cite LD-310 / T0B-ADMINPERM-1 ruling item 3):
- :33 title and :36: assert `held.has('lab.result.approve')).toBe(true)` (LD-310 widening), or drop that line.
- :91-94: invert it to "the Approve entry (lab.result.approve, /lab/approval) is visible to corp_admin (LD-310)", or delete it. Update the header comment at :2-4 to match.
- Leave verify.cmd as it is. Lead: the 11-ROLE-MATRIX R5 and data.yaml drift from LD-310 is still open (T0B-ADMINPERM-1 ruling item 7).
