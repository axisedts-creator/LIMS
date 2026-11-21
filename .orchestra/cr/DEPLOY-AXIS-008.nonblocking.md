Title: CR-C1-DEPLOY-008: setting a first password kills the GoTrue session that the next step (MFA enrolment) uses
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21; found in a real browser test through the test edge)    To owner: C2 identity
Type: bug
Blocking? yes for production go-live (every user who sets a first password or accepts an invitation reaches MFA enrolment with a dead session, and sees "Sign-in is temporarily unavailable"); no for any current orchestra task, so this file is named `.nonblocking`.
Relation to earlier CRs: 007 made "forgot password" and the mail link work; this is the next failure in the same flow (recovery mail, link, set password, enrol MFA). Evidence per item: (verified) = I checked it in the repo; (reported) = taken from the host logs and the operator's screenshot, not re-run by me.

## Evidence from the host (reported)
UTC timeline on supabase-auth for the first platform admin (no e-mail address or token in this CR):
- 07:20:49 `POST /recover` 200 (mail sent with the confirm-page link, CR-007 item 6a);
- 07:21:00 `POST /verify` 200 (the link was opened; GoTrue creates a session);
- 07:21:16 `PUT /admin/users/<id>` 200 (the api set the new password, `user_modified` by `service_role`);
- 07:21:28 `POST /factors` **403 `session_not_found`** (the api asked GoTrue to enrol the authenticator with the stored access token);
- api log at the same second: `startMfaEnrolment`, route `/v1/identity/auth/mfa/enrolment`, status **503 `common.dependency_unavailable`**.
The browser showed "Sign-in is temporarily unavailable. Try again in a few minutes." on "Set up two-step verification", step 2 of 3. Signing in again with the new password is the workaround (a fresh GoTrue session); it was suggested to the operator, its result is not yet reported.

## Items

### 1. `adminUpdatePassword` ends the setup session's GoTrue tokens, and the flow keeps using them  (To: C2 identity) (contradiction verified, effect reported)
Problem: `handlers/setPasswordFromSetup.ts:85` calls `adminUpdatePassword` on the user while the lims session (`kind` password_setup) holds the GoTrue tokens obtained from the recovery `/verify`. `gotrue/mapping.md:61` records, as a live finding, that "an admin password change also ends the user's existing refresh tokens". The handler's own comment (`setPasswordFromSetup.ts:90-92`) assumes the opposite: that only `adminSignOutUser` would "kill the live setup session's GoTrue tokens", which is why it enqueues no `identity.gotrue_signout` for platform users. After the password change the stored GoTrue session no longer exists, so the next call that needs it (`startMfaEnrolment` to `/factors`) returns 403 `session_not_found`.
Proposed change (owner decision, in order of preference):
(a) after `adminUpdatePassword` succeeds, call `signInWithPassword(email, newPassword)` (already in the gateway, `gateway.http.ts:109`) and replace the GoTrue tokens stored for the lims session with the new ones, before returning the MFA state;
(b) use a session-preserving password update with the setup session's own access token (GoTrue's user-initiated update keeps the current session); check that the pinned version (v2.197.0) allows it without a reauthentication nonce;
(c) keep the lims session but mark it "re-login required" and return a state that sends the user to the login page with a clear message.
The same code path serves invitations (`M2 invitation accept`) and recovery for tenant users, so all first-time users are affected.
Backward compatible? yes (no contract change for (a) and (c)).
Tenant/security impact: (a) keeps the password only in memory for the call; do not log it. No new public surface. No PHI fields.

### 2. The fake GoTrue gateway hides it  (To: C2 identity) (verified)
Problem: `gotrue/gateway.fake.ts:129-133` implements `adminUpdatePassword` as "set the password hash" only, while `adminSignOutUser` (`:135-137`) ends sessions. The recovery integration test (`handlers/__tests__/recovery.integration.test.ts`: request, job, mail, confirm, set password, login) therefore cannot see the real behaviour documented at `mapping.md:61`.
Proposed change: make the fake end the user's sessions on `adminUpdatePassword`, as GoTrue v2.197.0 does, and add a flow test: recovery link, set password, then `startMfaEnrolment` must succeed; plus the same for an invitation accept.
Backward compatible? yes.

### 3. A dead GoTrue session is reported as "temporarily unavailable"  (To: C2 identity) (message and status reported, mapping inferred)
Problem: GoTrue answered 403 `session_not_found` on `/factors`; the api returned 503 `common.dependency_unavailable`, which the web shows as "Sign-in is temporarily unavailable. Try again in a few minutes." That wording is wrong for a lost session: waiting does not help, and the user is not told to sign in again. `gateway.http.ts:119` already maps `session_not_found`, `session_expired`, `user_banned` and `user_not_found` to `revoked` for refresh, but `mfaEnrollTotp` (`gateway.http.ts:198-203`) ends in a generic `fail('mfaEnrollTotp', r)` (the 503 path as observed).
Proposed change: map 403 `session_not_found` / `bad_jwt` on user-token calls (`mfaEnrollTotp`, challenge, verify) to the existing `auth.session_expired` error so the web sends the user back to sign in; add a test with the real status codes.
Backward compatible? yes.

### 4. Comments and docs  (To: C2 identity, C1 docs) (verified)
Problem: the comment at `setPasswordFromSetup.ts:90-92` and `mapping.md:61` contradict each other (see item 1). `DAY-0.md` (CR-002 item 8, CR-003) should say that, until item 1 is fixed, the first administrator signs in again after setting the password, then enrols MFA.
Proposed change: fix the comment when item 1 is fixed; add the temporary note to `DAY-0.md`.
Backward compatible? yes.

Related: CR-007 item 2 (platform `gotrue_signout` enqueue with a tenantless payload) touches the same handler's neighbours: `setPasswordFromSetup.ts:93` enqueues the tenant case only.
IRD/regulatory impact: none.
Alternatives considered: telling users to sign in again (works, poor experience; first-time users see an error before they are told); a deploy-copy patch on the host (possible, not repeatable for a rebuild).
Tests that will prove it:
- fake-gateway flow test: recovery, set password, MFA enrolment starts, TOTP verifies, login reaches aal2 (item 2, item 1);
- unit test: `mfaEnrollTotp` with 403 `session_not_found` returns the session-expired error, not `dependency_unavailable` (item 3);
- host smoke on a seeded user: recovery mail captured by a sink, link opened, password set, enrolment screen shows the QR code with no error.
