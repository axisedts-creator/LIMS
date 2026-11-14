CHANGES

Scope: `git diff 3b9ed873..HEAD` = `.env.example` + notes. Ran `python -B -m unittest discover -s infra/tests/static -p test_t0d_dep01_images.py`: Ran 75, OK. Round-1 fixes (LIMS_ORIGIN_PORTAL api+worker, LIMS_ORIGIN_STAFF_WEB api) are present. Names-only, grouped, config.ts coverage, no values, no secrets, owned paths only: hold.

Remaining defect is the same class as round 1: the header (`.env.example:5`) says omitted module keys "are optional with code defaults", but several omitted module keys are secrets with NO default that fail closed, so a deployment built from this template cannot log in or send portal OTPs.

1. `.env.example:7-110` (api group) — missing no-default secrets:
   - `LIMS_IDENTITY_EMAIL_HMAC_KEY` — `services/api/src/modules/identity/service/auth.service.ts:64-65` throws `common.internal` 'identity: email HMAC key missing' (every login).
   - `LIMS_IDENTITY_TOKEN_ENC_KEYS` — `identity/repository/auth-events.repo.ts:65`, `mfa.repo.ts:16` throw 'identity: token encryption keys missing'.
   - `LIMS_IDENTITY_PATIENT_JWT_KEY_FILE` — `identity/handlers/resolvePatientSession.ts:26`.
   - `LIMS_REPORTING_OTP_HMAC_KEY_FILE` — `reporting/config.ts:31`.
   - `LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE`, `LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID` — `instruments/config.ts:64-65`.
   Fix: add each as `NAME=` with comment "optional at boot; required in staging, production for <feature> (fails closed when unset)"; for TOKEN_ENC_KEYS say it holds a JSON key map (auth-events.repo.ts:59), never commit a value.
2. `.env.example:112-135` (worker group) — missing: `LIMS_REPORTING_OTP_HMAC_KEY_FILE` (`services/worker/src/jobs/reporting/tasks/send_portal_otp.ts:57`, readFileSync of undefined throws), `LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE` + `_KEY_ID` (`jobs/instruments/configs.ts:25-27` throws), `LIMS_BILLING_EXPORT_KEY` (`jobs/billing/tasks/export_tenant.ts:58`). Fix: add with the same comment form.
3. `.env.example:5` — reword to "Module tuning keys (LIMS_<MODULE>_*) that have code defaults are not listed; module secrets without a default are listed below." Mirror items 1-3 in `.orchestra/notes/T0D-DEP-01-env.example.txt`.
4. `render.yaml` (lims-api envVars) — add the api names of item 1 as `sync: false` entries with no value (allowed by the task; not literals), otherwise the Render demo login fails at `auth.service.ts:65`.
