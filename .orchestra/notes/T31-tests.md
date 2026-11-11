# T31 tests (tester)
Files (services/api/src/modules/identity): handlers/__tests__/{kinds.helpers.ts (SEAMS in header), session-kinds.login.test.ts (loginPartner, openMobileSession: AU-T13/14/17/22),
session-kinds.app.test.ts (refresh/logout mobile, resolve/logout patient: AU-T13/15/16, P-42, LD-81), session-kinds.wiring.test.ts (manifest, OpenAPI, static)}; ports/__tests__/IdentityPort.t31.test.ts (3 patient port methods).
Run: `.orchestra/notes/T31-verify.cmd` = pnpm --dir services/api exec vitest run <the four files>.
State now: login/app suites load-fail (handler files missing); port suite 13/15 fail (blocked_gotrue_t1 / blocked_a28_2); wiring 28/38 fail (stubs, missing files). Helper logic itself is unproven until the handlers exist.
Spec gaps for lead (assumed seams, see kinds.helpers.ts): (1) 05-SCHEMA s6 login_context DEFINER does not say it returns partner memberships; tests assume row.actor_type. (2) openMobileSession permission via repo.membershipHasPermission. (3) patient token rotation trigger unspecified (AU-T15 patient: only reuse-detect tested; rotation tested for staff_mobile). (4) LD-81 signer is a seam mintPatientAccessToken; real EdDSA/kid/iss/aud NOT tested (auth/jwt.ts not granted). (5) port repo seams createPatientMembership / insertPatientSession / deactivatePatientMembership. (6) patient provisioning treated as unblocked by LD-81 (D-218 only for GoTrue).
Not covered: real-DB RLS/CHECK tests (kind CHECKs, DEFINER), concurrent double-refresh of one token, MFA state on mobile login, timing floor.
Inbox also held LD-106 (C1 test_t31_runbooks.py): not C2 scope; file already has the exclusion at line 334, left untouched.

Review round: added AU-T15 lost-race case (session-kinds.app.test.ts) + rotateToken->boolean seam and rot.miss switch (kinds.helpers.ts). Fails now: impl ignores the false return (expected rejection, got success).
