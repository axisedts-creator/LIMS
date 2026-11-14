APPROVE

Scope: `git diff 3b9ed873..HEAD` (HEAD c9a0cb65) = `.env.example`, `render.yaml`, notes. Ran `python -B -m unittest discover -s infra/tests/static -p test_t0d_dep01_images.py`: Ran 75, OK.

Round-2 items verified:
1. api group now lists LIMS_IDENTITY_EMAIL_HMAC_KEY, LIMS_IDENTITY_TOKEN_ENC_KEYS (JSON key map, never commit), LIMS_REPORTING_OTP_HMAC_KEY_FILE, LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE/_KEY_ID, LIMS_INSTRUMENTS_RELEASES_DIR, each `NAME=` with required/optional comment.
   Withdrawn: LIMS_IDENTITY_PATIENT_JWT_KEY_FILE appears only in a comment (`identity/handlers/resolvePatientSession.ts:26`); no code reads it, so the "every name is read by tracked source" rule correctly keeps it out.
2. worker group lists LIMS_REPORTING_OTP_HMAC_KEY_FILE, LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE/_KEY_ID, LIMS_BILLING_EXPORT_KEY.
3. Header `.env.example:5-6` reworded; notes mirror `.orchestra/notes/T0D-DEP-01-env.example.txt` updated.
4. `render.yaml` adds the api secrets as `sync: false`, no value; literals still only LIMS_CORE_ENV staging, LIMS_CORE_DB_POOL_MAX "5", PORT "8080".

Names-only, no secrets, owned paths only, no application source change: hold.
