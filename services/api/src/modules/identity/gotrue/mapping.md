# GoTrueGateway → GoTrue endpoint mapping (C2 T1)

Pinned version: GoTrue `v2.197.0` (`infra/compose/supabase/upstream/docker-compose.yml`, digest `sha256:1736a630…` in `override.app.yml`).
Verified 2026-11-07 against source tag `v2.197.0` (routes in `internal/api/api.go`, handlers `admin.go`, `logout.go`) and live probes on a
temporary container of the same image on `supabase_network_LIMS` (env of `supabase_auth_LIMS` plus min length 12, TOTP on, autoconfirm off).
Live contract run: PASS 2026-11-11 (39/39 against a real gotrue v2.197.0 container, http.live.test.ts, after .orchestra/notes/T1-ruling.md). Note: on a cold container the first run failed 2 of 39 on the gateway 3 s timeout (first call after start, first mail-sending call); the warmed run passed. See .orchestra/notes/T1-live-run-20261111.md.

Base URL: `LIMS_IDENTITY_GOTRUE_URL` (internal API-network URL; GoTrue routes at root, no `/auth/v1` prefix — that prefix is Kong's).
Admin auth: `Authorization: Bearer <LIMS_IDENTITY_GOTRUE_SERVICE_KEY>` (service-role JWT; `GOTRUE_JWT_ADMIN_ROLES=service_role`). No key → 401, non-admin bearer → 403 (live).
User auth: `Authorization: Bearer <user access token>`. The service key is never sent on user-level calls.
Errors: JSON `{code, error_code, msg}`; the gateway keeps only HTTP status + `error_code`. 5xx / network / timeout (3 s) = outage → `common.dependency_unavailable`.

Token response (all token-returning calls): `access_token`, `token_type` (`bearer`), `expires_in`, `expires_at`, `refresh_token`, `user{id,…}`, `weak_password`.
Access-token claims used: `sub`, `session_id`, `aal` (`aal1`|`aal2`), `exp`, `iat`, `role` (`authenticated`), `aud` (`authenticated`). `expiresAt` = claim `exp`.

GoTrue config the gateway relies on (C1 owns the values; see `.orchestra/cr/T1.nonblocking.md`):
- `GOTRUE_PASSWORD_MIN_LENGTH=12` (AU-T4) — `supabase/config.toml` today has `minimum_password_length = 6`.
- `GOTRUE_MAILER_OTP_EXP=3600` — invite/recovery link TTL in seconds (≤ 60 min, D-219).
- `GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true`, `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10`.
- `GOTRUE_MFA_TOTP_ENROLL_ENABLED=true`, `GOTRUE_MFA_TOTP_VERIFY_ENABLED=true` (off in `supabase/config.toml` and commented out in the upstream compose).
- `GOTRUE_MAILER_AUTOCONFIRM=false`; `GOTRUE_JWT_EXP=3600`; `GOTRUE_JWT_KEYS` (ES256, SP-1).
- Mail templates (invite, recovery) must link `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite|recovery`; the gateway sends no `redirect_to`.

### signInWithPassword
- Request: POST /token?grant_type=password
- Headers: `content-type: application/json`; no Authorization
- Request fields: `email`, `password`
- Response fields: token response. Failure: 400 `invalid_credentials` (wrong password and unknown e-mail identical) → `{ok:false}`; any 4xx → `{ok:false}`.
- Env: `LIMS_IDENTITY_GOTRUE_URL`, `GOTRUE_PASSWORD_MIN_LENGTH` (not enforced at login)
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/api.go (`r.With(api.verifyCaptcha).Post("/token", api.Token)`)

### refresh
- Request: POST /token?grant_type=refresh_token
- Headers: `content-type: application/json`; no Authorization
- Request fields: `refresh_token`
- Response fields: token response (new `refresh_token`, same `session_id`, `aal` kept). Errors (live): 400 `refresh_token_already_used` → `reused`; 400 `refresh_token_not_found` (after logout / admin sign-out) → `invalid`; 400 `validation_failed` (garbage) → `invalid`; `session_not_found`/`session_expired`/`user_banned`/`user_not_found` → `revoked`.
- Env: `GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED`, `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL`, `GOTRUE_RATE_LIMIT_TOKEN_REFRESH`
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/api.go
- Gateway: 1 retry after 200 ms on network error only.

### signOut
- Request: POST /logout?scope={local|global}
- Headers: `Authorization: Bearer <access token>`
- Request fields: none (query `scope`; `""`/`global` = all sessions of the user, `local` = this session, `others`)
- Response fields: 204 no body. 403 `session_not_found` (already signed out) → resolved (idempotent). 403 `bad_jwt` → rejects.
- Env: none
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/logout.go

### adminCreateUser
- Request: POST /admin/users
- Headers: `Authorization: Bearer <service key>`, `content-type: application/json`
- Request fields: `email`, `email_confirm` (also accepted: `password`, `phone`, `user_metadata`, `app_metadata`, `ban_duration`)
- Response fields: user object `id`, `email` (stored lower-case), `email_confirmed_at`, … Errors: 422 `email_exists` (any case) → gateway looks the user up and returns `{exists:true,userId}`; 400 `validation_failed` (bad e-mail, or neither e-mail nor phone) → rejects.
- Env: `LIMS_IDENTITY_GOTRUE_SERVICE_KEY`
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/admin.go (`adminUserCreate`)

### adminUpdatePassword
- Request: PUT /admin/users/{user_id}
- Headers: `Authorization: Bearer <service key>`, `content-type: application/json`
- Request fields: `password`
- Response fields: user object. Errors: 422 `weak_password` (`weak_password.reasons=["length"]`, < `GOTRUE_PASSWORD_MIN_LENGTH`); 404 `user_not_found`. Live: an admin password change also ends the user's existing refresh tokens.
- Env: `GOTRUE_PASSWORD_MIN_LENGTH`, `GOTRUE_PASSWORD_REQUIRED_CHARACTERS` (unset)
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/admin.go (`adminUserUpdate`)

### adminSignOutUser
- Request: GET /admin/users/{user_id} → POST /admin/generate_link → POST /verify → POST /logout?scope=global
- Headers: service key on the two `/admin/*` calls; the minted user access token on `/logout`; none on `/verify`
- Request fields: generate_link `{type:"magiclink", email}`; verify `{type:"magiclink", token_hash: hashed_token}`
- Response fields: user `last_sign_in_at`, `email`; generate_link `hashed_token` (also `action_link`, `email_otp`, `verification_type`; no mail is sent); verify = token response; logout 204. User never signed in → no calls after the GET (no sessions). 404 `user_not_found` → rejects.
- Env: `LIMS_IDENTITY_GOTRUE_SERVICE_KEY`
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/api.go (no admin session route exists under `/admin`)
- Redesign note (02-TRD s8, ADMIN_SIGNOUT): workaround only; side effect: overwrites a pending recovery link (magic link reuses `recovery_token`) and counts as an e-mail send for `GOTRUE_SMTP_MAX_FREQUENCY`.

### adminFindUserByEmail
- Request: GET /admin/users?filter={email}&page={n}&per_page=100
- Headers: `Authorization: Bearer <service key>`
- Request fields: none (query `filter` = case-sensitive substring on the stored lower-case e-mail; gateway lower-cases and checks exact equality)
- Response fields: `users[]` (`id`, `email`, …), `aud`; paging until a short page.
- Env: `LIMS_IDENTITY_GOTRUE_SERVICE_KEY`
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/admin.go (`adminUsers`)

### adminDeleteFactor
- Request: DELETE /admin/users/{user_id}/factors/{factor_id}
- Headers: `Authorization: Bearer <service key>`
- Request fields: none
- Response fields: deleted factor (`id`, `status`, `factor_type`, `friendly_name`). Errors: 404 `mfa_factor_not_found` (unknown or already deleted), 404 `user_not_found`.
- Env: `LIMS_IDENTITY_GOTRUE_SERVICE_KEY`
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/admin.go (`adminUserDeleteFactor`)

### sendInvite
- Request: POST /invite
- Headers: `Authorization: Bearer <service key>` (`requireAdminCredentials`), `content-type: application/json`
- Request fields: `email` (optional `data`, `redirect_to` — not sent)
- Response fields: user object (`id`, `invited_at`, `confirmation_sent_at`). Stores `auth.one_time_tokens` row `token_type=confirmation_token`. Errors: 422 `email_exists` for a registered e-mail → rejects.
- Env: `GOTRUE_MAILER_OTP_EXP`, `GOTRUE_MAILER_URLPATHS_INVITE`, `GOTRUE_MAILER_TEMPLATES_INVITE`, `GOTRUE_SMTP_*`
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/api.go (`r.With(api.requireAdminCredentials).Post("/invite", api.Invite)`)

### sendRecovery
- Request: POST /recover
- Headers: `content-type: application/json`; no Authorization
- Request fields: `email`
- Response fields: `{}` 200 — also for an unknown e-mail (nothing sent). Stores `token_type=recovery_token`, sets `users.recovery_sent_at`. 429 `over_email_send_rate_limit` within `GOTRUE_SMTP_MAX_FREQUENCY` → rejects.
- Env: `GOTRUE_MAILER_OTP_EXP`, `GOTRUE_MAILER_TEMPLATES_RECOVERY`, `GOTRUE_SMTP_MAX_FREQUENCY`, `GOTRUE_RATE_LIMIT_EMAIL_SENT`
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/api.go (`Post("/recover", api.Recover)`)

### verifyEmailToken
- Request: POST /verify
- Headers: `content-type: application/json`; no Authorization
- Request fields: `type` (`invite`|`recovery`), `token_hash`
- Response fields: token response (new session, `aal1`). Errors: 403 `otp_expired` (used, unknown, wrong type, or older than `GOTRUE_MAILER_OTP_EXP` measured from `users.recovery_sent_at` / `confirmation_sent_at`); 400 `validation_failed` (empty hash) → `{ok:false}`.
- Env: `GOTRUE_MAILER_OTP_EXP`, `GOTRUE_RATE_LIMIT_VERIFY`
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/api.go (`r.Route("/verify", …)`)

### mfaEnrollTotp
- Request: POST /factors
- Headers: `Authorization: Bearer <access token>`, `content-type: application/json`
- Request fields: `factor_type: "totp"`, `friendly_name` (optional)
- Response fields: `id`, `type`, `friendly_name`, `totp{qr_code (SVG data URI), secret (base32), uri (otpauth://totp/…)}`. 403 `bad_jwt` → rejects.
- Env: `GOTRUE_MFA_TOTP_ENROLL_ENABLED`, `GOTRUE_MFA_MAX_ENROLLED_FACTORS`
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/api.go (`r.Route("/factors", …)`)

### mfaChallengeAndVerify
- Request: POST /factors/{factor_id}/challenge then POST /factors/{factor_id}/verify
- Headers: `Authorization: Bearer <access token>`, `content-type: application/json`
- Request fields: challenge `{}`; verify `challenge_id`, `code`
- Response fields: challenge `id`, `type`, `expires_at`; verify = token response with `aal=aal2`, same `session_id`. Errors: 422 `mfa_verification_failed` (wrong code), 404 `mfa_factor_not_found` → `{ok:false}`.
- Env: `GOTRUE_MFA_TOTP_VERIFY_ENABLED`, `GOTRUE_RATE_LIMIT_*` (FactorChallenge/FactorVerify limiters)
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/api.go

### mfaListFactors
- Request: GET /user
- Headers: `Authorization: Bearer <access token>`
- Request fields: none
- Response fields: `factors[]` (`id`, `status` `verified`|`unverified`, `friendly_name`, `factor_type`); only `totp` mapped. There is no `GET /factors` list route. 403 `bad_jwt` → rejects.
- Env: none
- Source: https://github.com/supabase/auth/blob/v2.197.0/internal/api/api.go

## Verdicts
- AAL_CLAIM: CONFIRMED — `aal1` after password login, `aal2` after TOTP verify, kept across refresh, new login is `aal1` (live; also C0 SP-1).
- SESSION_ID_CLAIM: CONFIRMED — `session_id` UUID claim on every access token, unchanged by refresh and TOTP verify (live).
- REFRESH_ROTATION: CONFIRMED — every refresh returns a new `refresh_token`, same session (live).
- REFRESH_REUSE: REFUTED — re-using the immediate parent of the active token after the 10 s interval is accepted (200, new token); re-using an older token gives 400 `refresh_token_already_used` but the session is NOT revoked (the newest token still refreshes). Redesign note 02-TRD s8 + CR `.orchestra/cr/T1.nonblocking.md`.
- TOKEN_HASH_VERIFY: CONFIRMED — `POST /verify {type, token_hash}` for `invite` and `recovery`, single-use, type-bound (live).
- ADMIN_CREATE: CONFIRMED — `POST /admin/users`, duplicate (any case) = 422 `email_exists` (live).
- ADMIN_FIND: CONFIRMED — no find-by-email route; `GET /admin/users?filter=` substring + exact match in the gateway (live).
- ADMIN_SIGNOUT: REFUTED — no admin route revokes a user's sessions in v2.197.0; gateway uses the magic-link + `/logout?scope=global` workaround; redesign note 02-TRD s8 + CR `.orchestra/cr/T1.nonblocking.md`.
- FACTOR_DELETE: CONFIRMED — `DELETE /admin/users/{id}/factors/{fid}`; second delete 404 (live).
- PASSWORD_MIN_LENGTH: CONFIRMED — `GOTRUE_PASSWORD_MIN_LENGTH=12` rejects 11 chars with 422 `weak_password` (live); C1 config still 6 → CR `.orchestra/cr/T1.nonblocking.md`.
- LINK_TTL_LE_60MIN: CONFIRMED — `GOTRUE_MAILER_OTP_EXP=3600`; a recovery link whose `users.recovery_sent_at` is 3601 s old → 403 `otp_expired` (live probe). Ageing only `auth.one_time_tokens.created_at` does not expire it.
- D218_A_CREATE_WITHOUT_EMAIL: REFUTED — `POST /admin/users {}` → 400 `validation_failed` "Cannot create a user without either an email or phone" (source + live).
- D218_B_CREDENTIALLESS_SESSION: REFUTED — no admin route issues a session for a user; the only admin path (`generate_link` → `/verify`) needs an e-mail.

The patient session kind stays BLOCKED (D-218 a and b refuted); CR `.orchestra/cr/T1.nonblocking.md` to 08 R10 for lead and founder.
