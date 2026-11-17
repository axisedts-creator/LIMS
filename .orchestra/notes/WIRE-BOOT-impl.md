# WIRE-BOOT impl (writer)
- render.yaml: added 7 names (`sync: false`, no value): LIMS_ENGAGEMENT_{OTP_HMAC_KEY,OTP_ENC_KEYS,LINK_HMAC_KEY,PHONE_HMAC_KEY}_FILE, LIMS_PAYMENTS_{KEK_FILE,PUBLIC_BASE_URL,ESEWA_FORM_URL} [LD-188].
- .env.example: same 7 names added by the lead (LD-192); writer did not touch it (agent permission denies .env*).
- Tests run 2026-11-14: staging-boot.test.ts 11/11 passed; test_t0d_dep01_images.py 115 OK (after tester revision 784919f8 per ruling).
- No product code, spec or test file touched.
- Open: staging boot log warns "Handlers for some security requirements were missing: paymentCallbackToken / portalSession" (not a WIRE-BOOT check; owners C15/C13 to confirm).
