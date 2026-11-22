APPROVE
Reviewed git diff 2109ee577..092b1325a (9 source files + 1 test, within the 10-file budget; no api, contract or migration change).
- Contract: resendInvitation POST /users/{membership_id}/resend-invitation, identity.user.manage, 202, x-idempotency optional (C2 02-TRD.md:201). Web sends one Idempotency-Key only for resend-invitation (actions.ts:45). The id still passes through the SEG_RE guard.
- DONE WHEN (1): the row action appears only when canManage (from perms.has('identity.user.manage'), page.tsx:40) and status is invited. It uses a kit Button (secondary by default, UIX-6) and the shared kit ConfirmDialog with the RESEND_DIALOG text, which the detail page uses too. Success shows the toast "Invitation sent."; failure shows an inline Alert with its reference. A busy ref guards against a double submit.
- (2)–(4): one constant INVITE_LINK_MINUTES = 60 with a GOTRUE_MAILER_OTP_EXP comment (lib.ts). The sentence appears on the list (when any row is Invited), on the detail page (Invited only), in the invite success toast, and in all three help files. No 72 h value is shown anywhere.
- (5): tests cover each AC, including absent for Active/Locked/Deactivated/no permission, Cancel sends nothing, exactly one POST with a key, an error with its reference, a hostile id, and a failed invite that claims no success. The dispute ruling (TESTS_WRONG on :138) was applied correctly; the stack-trace check is kept.
- (6): no self-service resend was built, and GOTRUE_MAILER_OTP_EXP is untouched.
- No PHI, secrets or real names; the test data is synthetic. RLS is N/A (web only).
Run by reviewer 2026-11-22: vitest.t20.config.ts 7 files / 241 tests passed.
