Title: CR-C1-DEPLOY-010: a new tenant administrator can never accept the invitation (membership count, session actor, provisioning tenant) and the boot persistence of the deploy
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21; found by provisioning the first tenant in a real browser session)    To owner: per item (listed below)
Type: bug
Blocking? yes for production go-live (no tenant administrator can be onboarded); no for any current orchestra task, so this file is named `.nonblocking`.
Relation to earlier CRs: 007 item 2 and 008 describe two neighbouring failures on the same flow (tenantless sign-out jobs, the GoTrue session ended by the password change); 009 item 4 (refused platform login). This CR covers the invitation accept path. Fixes for items 1 and 2 exist in the deploy copy on the host and in `DEPLOY-AXIS-NIGHT16.patch` (held by the deployer, not in the repo). Evidence per item: (verified) = I checked it in the repo; (live) = confirmed on the host database by a read-only query; (reported) = night report, not re-run by me.

## Evidence from the host
UTC timeline for tenant `demo_lab` (first administrator invited from the platform console):
- 08:58:50 `POST /admin/users` 200, 08:58:51 api `provisionTenant` 201, 08:58:52 `POST /invite` 200 (GoTrue sent the invitation);
- 08:59:35 the link `/auth/confirm?token_hash=...&type=invite` was opened: `POST /verify` 200 at GoTrue (the one-time token is consumed), then api `confirmEmailToken` 400 `auth.invite_invalid`; the web showed "This invitation link is invalid or has expired".
Live row of the invited administrator (`app.identity_login_context`, read-only): `membership_count=0`, `tenant_status=provisioning`, `membership_status=invited`, `membership_locked=false`, no platform-staff row, tenant id present; core.memberships: 1 row, status `invited`; identity.invitations: 1 row, status `sent`.

## Items

### 1. `confirmEmailToken` requires exactly one membership, but the database counts only active ones  (To: C2 identity) (verified, live)
Problem: `services/api/src/modules/identity/handlers/confirmEmailToken.ts:85` requires `Number(row['membership_count']) === 1` for every link type. `app.identity_login_context` counts only memberships with status `active` (`db/migrations/20261105000800_app__create_identity_definers.sql:96-97`, "08 A6.6"), so an invited administrator always has count 0 and the check fails. No invitation can ever be accepted. GoTrue has already consumed the token by then, so the link is dead after the first click, and a second `/invite` for a confirmed GoTrue user is not expected to work.
Night16's fix: `countOk = count === 1 || (type === 'invite' && membership_status === 'invited' && count === 0)`; every other condition unchanged (tenant status rule of LD-299, locked false, status active or invited, tenant id and membership id present); recovery stays strict.
Backward compatible? yes.

### 2. `app.identity_session_actor` returns nothing for an invited member or a provisioning tenant  (To: C2 identity, C0-0B for the DEFINER) (verified comment, live probe)
Problem: `db/migrations/20261115155000_identity__add_session_actor_definer.sql` (comment at line 24) returns a row only for an ACTIVE membership in an ACTIVE tenant. The invited administrator of a provisioning tenant gets 0 rows, so `loadSessionActor` throws `common.internal`. That blocks the three places on the path: `confirmEmailToken` (before the first write), `setPasswordFromSetup` (before `acceptInvitation`) and the MFA complete and verify handlers (after set-password the membership is active but the tenant is still provisioning). With only item 1 fixed, accepting the invitation would end in a 500.
Night16's fix in the deploy copy (reported): a tenant-bound fallback read in `repository/auth-events.repo.ts` `sessionActor` when the function returns no row (membership invited or active, tenant provisioning or active; it fails closed without a bound tenant; platform sessions never fall back; suspended, offboarded or deactivated never match). Proven as `lims_app` with identityAuthTx-style claims in a rolled-back read-only transaction: 1 row, role `tenant_admin`.
Proposed change (cleaner): relax the DEFINER in a NEW migration (membership invited or active, tenant provisioning or active) and add a pgTAP case; drop the TypeScript fallback, which reads `core.*` from TypeScript, something the original SESSION-ACTOR-1 test says not to do.
Backward compatible? yes (the relaxed function only adds rows for states that previously returned nothing).
Tenant/security impact: the actor row of an invited member is exposed only inside the member's own session (tenant bound); suspended and offboarded stay excluded.

### 3. The fakes hid both bugs  (To: C2 identity) (reported)
Problem: the repository fake used by the confirm tests returned `membership_count` 1 for every status and a session-actor row for every key, so the bugs in items 1 and 2 could not show in unit tests.
Night16's change: the shared test helpers now derive `membership_count` from the status like the DEFINER (invited 0, active 1) and the fake `sessionActor` mirrors the repository; 15 new confirm cases (invite plus invited plus count 0 plus provisioning gives 200 with an actor; recovery plus invited stays `auth.reset_token_invalid`; impossible, deactivated, suspended, locked and missing-id states stay `auth.invite_invalid`) and 3 session-actor fallback tests. In a throw-away image, 80 files in the identity handler, service and repository folders ran: 3328 tests passed and 2 failed, both in files the agent did not touch (`recovery.wiring.test.ts` cannot find `supabase/config.toml` in the image; `mfa.repo.platform-event.test.ts` counts db test files).
Proposed change: take the helper and test changes; add a DB-level test (devstack) that calls the real DEFINERs for an invited membership and a provisioning tenant.
Backward compatible? yes.

### 4. A tenant administrator cannot sign in while the tenant is provisioning  (To: C2 identity, platform owner; policy decision) (verified)
Problem: `services/api/src/modules/identity/service/auth.service.ts:204` refuses login for any tenant whose status is not `active` (`login_blocked_tenant_suspended`, `identity.tenant_suspended`). A new tenant is `provisioning` until the platform administrator calls `activateTenant`, whose readiness check needs at least one accepted administrator, one active branch and one active centre (`tenant.service.ts:536`; the branch and centre are created by provisioning). So the first administrator has only the 15-minute `password_setup` session after the invitation link; if that session is lost, login is refused, recovery is refused (a recovery link works only for an active tenant, `confirmEmailToken.ts:84`) and the invitation link is consumed.
Proposed change (owner decision): allow a tenant administrator to sign in while the tenant is provisioning, or re-issue the invitation with a new link, or let activation precede the first sign-in explicitly in the platform console. Until decided, document the operator sequence: administrator opens the invitation link and sets the password; the platform administrator activates the tenant; the administrator signs in and enrols the authenticator.
Backward compatible? depends on the choice.

### 5. `acceptInvitation` fails silently  (To: C2 identity) (reported)
Problem: `repository/mfa.repo.ts` (around line 121) returns false when no `pending` or `sent`, unexpired invitation matches the user. The membership then stays invited while the password is set, and the event is `password_reset_completed` instead of `invite_accepted`; no error reaches the user.
Proposed change: for link type invite, fail loudly when no invitation matches.
Backward compatible? yes.

### 6. A stuck first administrator has no supported rescue  (To: C2 identity, platform owner) (reported, code reading only)
Problem: after item 1 consumed the GoTrue token, `demo_lab`'s administrator is a confirmed GoTrue user with an invited membership and a `sent` invitation; the link is single use, recovery is refused for a provisioning tenant, and login is refused. No supported path was found. Candidates, none attempted: the platform console re-sending the invitation (a new GoTrue token; it needs the invite call to accept an existing confirmed user, unverified), or deleting and recreating the tenant (no delete exists).
Proposed change: a "re-issue invitation" action in the platform console that works for a confirmed, never-logged-in invitee, and a way to retire a mistaken test tenant.
Backward compatible? yes.

### 7. Boot automation of the deploy (for the owners, from night15)  (To: C1) (reported)
Problem and fix (all in the deploy copy and `DEPLOY-AXIS-NIGHT15.patch`): after an unplanned power cut the encrypted volumes stayed locked (passphrase typed by a person; `KEY_URL` empty in `/etc/lims/luks/unlock.conf`, the "ops-1" key server of the TRD is the host itself on a single host) and the rendered runtime secrets under `/run/lims` (tmpfs) were gone, so about a dozen containers crash-looped; Docker created empty directories where the secret files should be, which made the first re-render fail. Night15 added: a key file per volume as an additional LUKS keyslot with the passphrase slots kept; the unlock script tries the key file, then the key server, then the console passphrase; a persisted copy of the runtime state (`/run/lims`, minus `ci`) on the encrypted data volume, refreshed every 10 minutes and at shutdown and restored before Docker starts; a Docker drop-in that refuses to start unless all four volumes are mounted. A full supervised reboot test is still to be done.
Proposed change: make a single-host (`prod-lean`) unattended boot a supported mode of `luks_volumes` and `secrets_render` (documented trade-off: key material on the host), keep the manual passphrase path as fallback, and test the full reboot in CI or a staging host.
Backward compatible? yes.
Tenant/security impact: the key files sit on the host's root disk, so they also appear in root-disk backups; the encryption then protects a drive or a backup taken separately, not theft of the whole machine.

Tenant/security impact: items 1, 2 and 4 decide who can reach a tenant before it is active; no PHI fields; no secret value appears in this CR.
IRD/regulatory impact: none.
Alternatives considered: keeping every fix only in the deploy copy on the host (done for the test; not repeatable for a rebuild or DR); activating the tenant before the first administrator accepts (not possible: `activateTenant` needs an accepted administrator).
Tests that will prove it:
- DB (devstack): `app.identity_login_context` and `app.identity_session_actor` for an invited member of a provisioning tenant return the rows the handlers expect; they still return nothing for suspended, offboarded or deactivated cases;
- handler tests from item 3 (invite accepted for an invited membership with count 0; recovery stays strict);
- flow test with the real DEFINERs: provision tenant, invitation link, set password, MFA enrolment, platform administrator activates, administrator signs in;
- host smoke: provision a test tenant with a new administrator address and complete that flow in the browser; the membership becomes `active`, the invitation `accepted`, the event `invite_accepted`;
- reboot test on a single-host install (item 7): power cut, no human input, all containers healthy within minutes.
