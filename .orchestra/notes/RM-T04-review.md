APPROVE

Reviewed `git diff 33b308d5..HEAD`: one test file (services/api/src/modules/identity/__tests__/role-packs/escalation.test.ts, owned path) + RM-T04 notes. No code, data, migration, log or secret changes.
- done_when covered: corp_admin/std_admin minus identity.role.manage refused createRole/updateRole/deactivateRole (x-permission read from contracts/openapi/identity.yaml); role.manage/user.manage held only by the two Admins (R4); R2 overlay allowlists for verify/approve/amend, narrative sign, anatomic.case.signout, refund approve, payment reverse, invoice cancel, discount approve, plus API refusal for all 29 roles; R5 Admin holds no clinical sign-off.
- Names verbatim: all codes checked against contracts/permissions.yaml in-test; role codes match 11-ROLE-MATRIX §3.
- Ruling (discount approve = Accounts + Admins) matches 11-ROLE-MATRIX D3 default (:224) under LD-141; refund/reverse/cancel stay Accounts-only. No role widened.
- Ran: vitest on the file -> 39 passed.
Non-blocking: test "user.manage alone is not role.manage" uses corp_accession_user, which holds neither code (R4 cap), so its title overstates what it proves. Seam is assertRole, not the HTTP pipeline (as in RM-T03); 403 rendering is not covered here.
