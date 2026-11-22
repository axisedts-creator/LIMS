# T0D-FIX-10 tests (tester)
- New: apps/web/src/features/admin/__tests__/t20.fix10-resend-invitation.test.tsx (picked up by vitest.t20.config.ts).
- Run: `.orchestra\notes\T0D-FIX-10-verify.cmd` (only this file). Existing admin tests: C2.T20-verify.cmd must stay green.
- Covers: row action on /admin/users (Invited + identity.user.manage only; absent Active/Locked/Deactivated/no permission), same dialog text, one POST with Idempotency-Key, "Invitation sent.", inline error with request id, hostile id; lifetime sentence on users page (only if an Invited row) and detail page (Invited only, no 72 h claim); sentence after invite; three help files.
- Writer contract: export `INVITE_LINK_MINUTES = 60` from features/admin/lib.ts with a GOTRUE_MAILER_OTP_EXP comment; components must not hard-code 60/72. Sentence: "Invitation links work for about 60 minutes. If one has expired, use Resend invitation."
- Row action: button named "Resend invitation" in the row, or a row menu button (name /actions|more|row/) with that menuitem. Resend must send an Idempotency-Key (userAction currently sends none; list and detail both).
- Invite success: sentence must appear (toast or view) and router push/replace to the list stays.
