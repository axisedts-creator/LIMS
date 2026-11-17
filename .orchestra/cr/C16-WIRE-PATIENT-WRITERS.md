Title: CR-C16-nnn: identity does not wire the patient writers or the patient JWT signer, so verifyPatientOtp always ends in 500 common.internal
From chunk: C16            To owner: C2 (identity) / C0-0D (wiring)
Type: port (IdentityPort implementation / wiring)
Blocking? yes — patient app sign-in (E3 verifyPatientOtp) cannot return a session on any deployed API.

Problem (observed on the staging API at deploy commit ded0ec0, tenant_a, synthetic phone numbers):
  E1 getPatientAppConfig 200 and E2 requestPatientOtp 202 work (after the core patientPreAuth resolver wiring, see C16-WIRE-AUTHRESOLVERS.md).
  E3 verifyPatientOtp: the code matches (the OTP is verified), then the request ends in 500 common.internal.
  Logged by the new diagnostic (event verify_otp_post_match_failed): err_name LimsError, err_code common.internal.
Cause (read from code, not guessed):
  services/api/src/modules/identity/index.ts:14 (LD-81): "no mintPatientAccessToken and no patient writers here: openPatientSession /
  provisionPatientMembership throw common.internal 'not wired'". createIdentityPort({ repo: createCoreAdminRepo(), ... }) is built
  without repo.createPatientMembership, repo.insertPatientSession or deps.mintPatientAccessToken, so IdentityPort.impl.ts:383 and :396 throw unwired()
  (common.internal 'identity: patient writer not wired'). engagement/service/auth.service.ts verifyOtp catches it after the match and answers 500.
Proposed change (for C2 to design, AUTH-SENSITIVE): wire the patient writers (membership + session rows, tenant-scoped, pre_auth context only)
  and a patient access-token signer (LD-81: LIMS mints the 1 h patient JWT; key from LIMS_CORE_JWT_* / a dedicated patient key file), with DB grants for lims_api.
Backward compatible? yes. Tenant/security impact: creates patient identities and sessions, mints JWTs: needs security review (REQ-SEC IDs per C2).
Tests that will prove it: IdentityPort.openPatientSession / provisionPatientMembership against a real tx; end-to-end verifyPatientOtp 200 with session_token + access_token.

Note (C16, local diagnostics only): engagement auth.service.ts logs verify_otp_post_match_failed (err_name, err_code, constraint, routine; no message, phone, token or row).

DRAFT IMPLEMENTATION (local, AUTH-SENSITIVE, for C2 / C0-0D review; verified end to end on a throwaway migrated + seeded Postgres, see below):
  DB   db/migrations/20261117000000_identity__patient_provision_and_session_definers.sql
       three DEFINERs (lims_owner, search_path '', EXECUTE lims_api only): app.identity_patient_create_membership(account_id) = one core.users + one core.memberships row
       (membership id = account id = OTP challenge id: idempotent per accountId with no new column); app.identity_patient_open_session(row) = one identity.sessions row
       (kind patient, active, aal1; gotrue_session_id = the session id because app.identity_resolve_session looks a session up by the JWT session_id claim in that column;
       placeholders for the encrypted-token columns); app.identity_patient_membership(id) = read of user id / status / locked. All refuse unless the claims are a
       pre-auth patient (actor_type patient + patient_stage). Three owner-only INSERT policies keyed to app.maintenance (users, memberships, sessions).
       Registered in db/meta/definer-inventory.yaml (+ generated db/tests/isolation/_registry.sql). pgTAP: db/tests/identity/CR-C16_patient_definers.test.sql (all pass).
  API  identity/repository/patient-writes.repo.ts (the three seams), identity/service/patient-jwt.ts (EdDSA signer, lazy key read, fail closed),
       ports/IdentityPort.impl.ts (openPatientSession reads the membership through the DEFINER, mints the JWT BEFORE the insert, passes access_expires_at),
       identity/index.ts wiring, core/auth/patient-jwt-verifier.ts + bootstrap/config (optional LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE; EdDSA routed by header alg only;
       exact iss urn:lims:identity:patient / aud urn:lims:api:patient; aal1 only).
       C16 fix found by the end-to-end run: engagement treated ctx.actor.id (the patient's USER id = claims.sub) as the membership id, and slot/orders/link read a
       ctx.claims that the handler context does not have, so every authenticated patient call 404/403'd. service/patient-ctx.ts patientMembershipId(ctx) now reads
       ctx.actor.membershipId in account, profile, selfreg, link, slot and orders.
  Settings (names only, .env.example / render.yaml / docs/runbooks/environment.md): LIMS_IDENTITY_PATIENT_JWT_KEY_FILE, LIMS_IDENTITY_PATIENT_JWT_KID, LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE.
  Verified end to end (local API, throwaway Postgres 17 from db/tests/run-suites.sh with migrations + seeds, synthetic keys): app config 200 -> request OTP 202 -> verify 200
       (session_token, access_token, account) -> GET /v1/engagement/me, /me/profiles, /me/notifications, /me/orders, /me/reports, /me/memberships all 200;
       a tampered token and no token -> 401.
  Tests: db pgTAP 45+ assertions; API: patient-jwt (13), patient-writes.repo (9), IdentityPort.patient-reads (7), patient-jwt-verifier (30), patient-ctx (11), config (+4).
       Whole-suite comparison against a clean checkout: identical failure sets (the 53 failing tests in the compared files fail the same without this change).
  Not covered / open for the reviewers: the patient refresh endpoint (CR C2.T31 item 4) does not exist, so sessions are not rotated; resolvePatientSession's own
       signer is not wired (not needed for sign-in); the mobile app persists nothing beyond the tokens it already handles.
