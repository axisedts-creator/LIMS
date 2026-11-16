T0B-ADMINPERM-1 tests (tester)
- New: services/api/src/modules/identity/__tests__/role-packs/admin-all-permissions.test.ts (enumerates contracts/permissions.yaml; explicit EXCLUDED list with a reason per code; one test per staff code; exact-set, sorted, unique, mfa_required yes, base tenant_admin; lab.result.verify held).
- Run: .orchestra\notes\T0B-ADMINPERM-1-verify.cmd (pnpm --dir services/api exec vitest run <that file>).
- Now: 42 failed / 119 passed; each failure is `corp_admin is missing <code>` (staff codes absent from the pack, e.g. lab.result.verify, billing.refund.approve) or the exact-set check. Exclusion-honesty test passes.
- tenant_admin is not a pack here (only base_default_role: tenant_admin); std_admin NOT covered (brief names corp_admin); say if std_admin should follow.
- No test pins registry permission_codes; no registry change needed.
- CONFLICTS the implementer/arbiter must rule on (I did not edit them): admin-authority.test.ts (ADMINPACK-1 left-out list, 115/39 counts), role-packs.data.test.ts ("equals spec/program/11-ROLE-MATRIX.data.yaml unchanged", corp_admin [115,39], R2/R5 "Admin has no lab.result.verify/approve/amend"), matrix-replay.test.ts maybe. They fail once corp_admin is widened. LD-310 overrides; spec/ is read-only so the data file will differ from the spec copy.
- Founder step (after merge): pnpm --filter @lims/api identity:apply-role-pack --tenant 01a1e57f-03a0-790b-bbae-dd98d808d1b7 --pack elabcorp_default; expect created 0 roles, updated 1 (corp_admin), permissions added = the list of codes added (implementer fills exact count).
- Separation of duties (same user enters and verifies): not touched by tests; implementer checks lab workflow code and states it.
