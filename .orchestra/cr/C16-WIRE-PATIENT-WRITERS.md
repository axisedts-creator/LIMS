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
