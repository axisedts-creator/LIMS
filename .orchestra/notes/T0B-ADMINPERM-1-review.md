APPROVE
T0B-ADMINPERM-1 review (628535496..5f296891c).
- Pack: corp_admin 115 -> 155 = every assignable registry code (isAssignable: not platform.*, roles non-empty); sorted, unique; mfa_required true; base tenant_admin; std_admin and all other roles unchanged. 40 added codes listed in impl notes (done_when 1, 4, 5).
- Test: admin-all-permissions.test.ts enumerates the registry via it.each(STAFF); EXCLUDED (31) = 5 platform.* + identity.signatory.read (system) + portal/patient/pre-auth + device + partner codes, each with a reason, and each checked to hold no tenant role in contracts/permissions.yaml (done_when 2). engagement.booking.cancel is in fixed_actor_permissions.patient but also held by front_desk, so including it is correct.
- No change under contracts/ or spec/ (git diff empty there); no permission code added, renamed or removed (done_when 3). No routes, migrations, RLS, logs or secrets touched.
- Founder step and expected counts (created 0, updated 1) written in impl notes (done_when 6). SoD note: approver = verifier refused (lab.self_approval_forbidden); enterer = verifier not guarded, recorded, not changed (as the brief says).
- Scope: 10 test/data files vs the brief's "at most 5"; overrun directed by arbiter ruling TESTS_WRONG item 4, accepted.
- Ran: verify.cmd -> 10 files, 758/758 pass. Whole identity module: 6365 pass, 10 fail, all pre-existing and outside this task (apply-role-pack.script.test.ts 9: missing docs/runbooks/apply-role-pack.md and script list; ci-scripts identity-service-key-grep 1). tsc --noEmit: no errors in role-packs files.
- For lead (not a defect here): record the LD-310 widening in the CR register / spec sync (spec 11-ROLE-MATRIX §3.3 and data yaml now differ from the pack), and queue the apply-role-pack.script.test.ts failures.
