APPROVE

Round 2. Item 1 from round 1 is fixed in 26ad431d. `SET LOCAL ROLE lims_owner;` is now the first statement of 20261115157000, so the CREATE POLICY on identity.platform_events (owned by lims_owner) and the DEFINER function are both created as lims_owner, the same way as in 20261105001300 and 20261115156000. The comment and the impl notes ([CONV] line, Open item 2) were corrected to match. The fix commit changes nothing else.

Re-checked, no defect: the policy is additive, INSERT only, TO lims_owner; the function is SECURITY DEFINER with search_path '', REVOKE PUBLIC and EXECUTE for lims_api only; it accepts only the platform_mfa_enrolled / platform_staff / target = actor = own staff row case; app.pre_user_id is reset on both paths. The repository passes id, created_by and request_id explicitly. The platform branch calls only recordPlatformMfaEnrolledEvent, and recordPlatformEvent is unchanged. Actor is loaded before checkCode on both code steps. The QR log carries the reason code only. Both CRs are *.nonblocking.md.
Ran: verify.cmd vitest = 12 files, 540 passed, 5 skipped, 0 failed.
NOT run: the migration and the pgTAP (no psql in the lane). The first real check of the migration is push-cloud.
