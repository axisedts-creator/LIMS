# RM-T04 tests (tester)
File: services/api/src/modules/identity/__tests__/role-packs/escalation.test.ts (39 tests: R4 escalation via IdentityPort.assertRole on the x-permission of createRole/updateRole/deactivateRole; R4 manage codes only on corp_admin/std_admin; R2 overlay allowlists + API refusal for 29 roles; R5 Admin no clinical sign-off).
Run: `.orchestra\notes\RM-T04-verify.cmd` (= pnpm --dir services/api exec vitest run on that file).
Result now: 39/39 pass. Per RM-T04-ruling.md (TESTS_WRONG) overlay for `frontdesk.discount.approve` = Accounts + corp_admin + std_admin (D3 default, LD-141); refund/payment reverse/invoice cancel stay Accounts-only.
Assumptions: overlay allowlist per code from §3.1 text (verify = pathologists + Sr. Lab tiers + std_lab_technician per D2); "refund" = billing.refund.approve; escalation seam = assertRole (core pipeline enforces x-permission through it), not the HTTP pipeline.
Not tested: HTTP pipeline/e2e 403 rendering, UI hiding, seeding (RM-T02), per-role scope (R8).
