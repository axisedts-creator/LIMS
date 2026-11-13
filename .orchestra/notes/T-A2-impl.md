# T-A2 impl (writer) — DONE after ruling (test world fixed by tester)
Files: api engagement `auth/preauth.resolver.ts`, `repository/otp.repo.ts`, `service/auth.service.ts`, `handlers/auth.handlers.ts` (+ `handlers/index.ts`, `index.ts` wiring); worker `tasks/send_login_otp.ts` (+ `index.ts`).
Run (2026-11-13, after review d42f1e37): api 49/49 pass; worker send_login_otp 20/20 pass. Review item 1 applied: last attempt (attempt >= maxAttempts) -> markFailed (ciphertext NULL), no rethrow, also for unknown port status.
[CONV] newest enc key = last entry of OTP_ENC_KEYS_FILE; ciphertext iv(12)|ct|tag(16), aad = challenge_id; features.payments = app_gateways non-empty; supersede = same phone_hmac+app_instance, created_at <= this one, id <> this one; job payload {tenant_id, challenge_id}.
[CONV] E2 order: shape -> app_enabled -> prefix -> otp_request limiter -> daily cap upsert (conditional ON CONFLICT .. WHERE last_value < cap) -> insert + enqueue; cap hit -> 429 with Retry-After to tenant midnight.
tsc: no errors in T-A2 files; pre-existing errors elsewhere (contracts/ports/common.ts:44 missing .js ext; worker tasks/purge.ts exactOptionalPropertyTypes) — not C16 T-A2 paths.
Open: packages/fakes NotificationPort fake `engagement.login_otp` params still {otp_code} only; needs lead/CR to add lab_name, minutes. Not run: db pgTAP (needs live DB).
