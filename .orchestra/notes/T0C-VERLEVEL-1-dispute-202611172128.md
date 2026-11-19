# T0C-VERLEVEL-1 dispute (writer): two test pins cannot both hold / one fixture is a no-op
Everything else in `.orchestra/notes/T0C-VERLEVEL-1-verify.cmd` is green (codegen 577/577, registry-equality 7/7, pending + role packs 290/291, boot T-01 3/3, pgTAP 134/135, the two new isolation probes clean).

1. `services/api/src/modules/lab/__tests__/probes/registry.static.test.ts:56-57` pins the privileged lab codes EXACTLY to approve / amend / config.manage / qc_hold.release.
   `tools/codegen/__tests__/verlevel1-openapi.test.ts:311` pins `lab.verification_policy.manage` privileged true, and `admin-authority.test.ts` / `role-packs.data.test.ts` pin corp_admin privileged 64 (= +1 privileged).
   Both cannot pass. The tester edited registry.static.test.ts in this task but missed this pin. Proposed fix: add `'lab.verification_policy.manage'` to the expected list at line 57 with comment `// T0C-VERLEVEL-1 (LD-316): changing who may sign off is privileged`.
   Reason: the brief makes manage a corp_admin + lab_manager code that changes sign-off authority (security relevant); the other three tests already agree on privileged.

2. `db/tests/lab/T0C-VERLEVEL-1_verification_levels.test.sql:206` (`not ok 54`) expects >= 2 audit rows for policy 330, but its own UPDATE at line 195 sets `required_verifiers = 3` on a row inserted with 3 at line 192 (plus `updated_by`, which app.tg_row_audit ignores). The update changes nothing, so the shared audit trigger correctly writes no row (08 A15.5: no-op updates are not audited). The INSERT is audited (count is 1).
   Proposed fix: line 195 sets `required_verifiers = 2` (or any real change), keeping `n=1`.

No implementation change is needed for either; I stop here until the ruling.
