Title: CR-C1-DEPLOY-005: first real prod deploy, part 5: identity wiring, BFF keys, GoTrue reachability and first platform admin (night9, night10)
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21)    To owner: per item (listed below)
Type: bug
Blocking? yes for production go-live (login and recovery cannot work without items 1-3); no for any current orchestra task, so this file is named `.nonblocking`.
Relation to earlier CRs: 001 (builds, stack start), 002 (migrate, lock, push, inputs), 003 (first migrate/push/release), 004 (app stack start, JWT, mail, worker job; its item 3 lists the missing `LIMS_IDENTITY_*` env). This CR records what happened when that identity env was wired on the host and the first platform admin was created. Fixes exist in the deploy copy and in `DEPLOY-AXIS-NIGHT9.patch` / `DEPLOY-AXIS-NIGHT10.patch` (held by the deployer, not in the repo). Evidence per item: (verified) = I checked it in the repo; (reported) = night report from the host, not re-checked by me.
Outcome on the host: api and worker run with the identity env; GoTrue admin read 200 with the right key; a fake login returns 401 `auth.login_failed`; one platform superadmin row and one GoTrue user exist (CLI exit 0, no mail sent). A real login, the password reset mail and TOTP enrolment are NOT proven (no DNS, no public edge yet).

## Items

### 1. API BFF key variables: the deployed name is not read  (To: C1 compose and schema, owner of `core`) (verified)
Problem: `compose.app.yml:40` sets `LIMS_CORE_BFF_KEY_FILES`, and the schema `mount:` lines for the three BFF ids (`prod.secrets.schema.yaml:287,294,301`) name it too. The api reads three different variables: `LIMS_WEB_BFF_KEY_FILE`, `LIMS_PARTNER_BFF_KEY_FILE`, `LIMS_PORTAL_BFF_KEY_FILE` (`services/api/src/core/config.ts:93`; the comment at `config.ts:24` shows the TRD name vs. the code names). Night9 reported the api therefore had no BFF key, readiness reported `degraded` (`LIMS_WEB_BFF_KEY_FILE` is in the readiness required list, `core/health.ts:40`) and every BFF-only endpoint (login, recover) would refuse. Fixed on the host by adding the three names pointing at the existing mounts `/run/secrets/bff/{staff_web,partner,portal}`.
Proposed change: use the three names in `compose.app.yml`, correct the schema `mount:` text in all three schema files, and make the TRD/schema/code agree on one name. Add a static check: every env name the api's `REQUIRED_ENV` and `config.ts` read is set in compose.
Backward compatible? yes.

### 2. Api cannot reach GoTrue by name on a single host  (To: C1) (reported)
Problem: api-a/api-b and `supabase-auth` share `auth_net` and `db_net`. Docker DNS answers `supabase-auth` with the `db_net` address (172.30.50.20) and TCP to it times out (db_net-internal traffic is dropped by nftables, same bridge). The `auth_net` address (172.30.30.2) answers (`/health` 200). Before the fix the login endpoint returned 503 `common.dependency_unavailable`. Night9's workaround: api `extra_hosts: ["supabase-auth:172.30.30.2"]`, plus pinning `supabase-auth` to `auth_net` address 172.30.30.2 and the api containers to .11/.12 in `override.app.yml`. The pin is fragile: if `supabase-auth` is recreated without it and another container takes .2, the api loses GoTrue.
Proposed change: do not attach `supabase-auth` to `db_net` under the same service name, or give it a per-network alias and have the api resolve only the `auth_net` one; keep a fixed address only as a fallback. Add a deploy check: from inside api, `GET http://supabase-auth:9999/health` = 200.
Backward compatible? yes.

### 3. Web, portal and api origin env  (To: C1, C2 identity) (reported)
Problem: (a) the api's readiness requires `LIMS_ORIGIN_API` (the public API origin, used for messaging links); compose did not set it (readiness `degraded`, `missing_env` listed it). (b) For web and portal, compose sets `LIMS_WEB_API_BASE_URL: http://api:8080` (`compose.app.yml:96,192,208`), which night9 found no code reads. The web/portal code reads `LIMS_ORIGIN_API` (server-side only, no `NEXT_PUBLIC_*`, no client reader; night10 listed the readers), `LIMS_ORIGIN_STAFF_WEB`, `LIMS_ORIGIN_PORTAL` and `LIMS_CORE_ENV`. Without `LIMS_CORE_ENV=production` and `LIMS_ORIGIN_API`, the web's session provider (`core/session/provider.ts`) falls back to the dev-only `BffSessionStore`; nothing logs or reports which provider is active, so this cannot be seen from outside. Fixed on the host in compose and the runtime role; the web and portal containers were recreated by night10.
Proposed change: set the variables the code reads (api: public `https://<origins.api>`; web and portal: internal `http://api:8080` is correct, confirmed server-only), drop `LIMS_WEB_API_BASE_URL` or make code read it, and add a one-line startup log plus a readiness field naming the active session provider so production can be asserted (CR-004 item 8 lists related compose env).
Backward compatible? yes.

### 4. Empty platform CIDR list means "no restriction"  (To: C2 identity, C1) (verified)
Problem: `LIMS_IDENTITY_PLATFORM_ALLOWED_CIDRS` is optional, and "empty = no global restriction" (`auth.service.ts:51`, applied at `:101` and `:247`). A production deploy that forgets it lets platform-admin login from any internet address, with only the per-staff list as a second gate. Night9 set it on the host to `10.77.0.0/24,127.0.0.1/32,::1/128` (the inventory's `wg_subnet` plus loopback). Consequence once the public edge exists: the api sees the client IP forwarded by the trusted proxy (nginx, one hop), i.e. the real public address, so a platform admin can log in only through a WireGuard path, never from the open internet. The operator's PC has no WireGuard peer yet.
Proposed change: in production (`LIMS_CORE_ENV=production`) fail readiness (or boot) when the list is empty; derive the default from `wg_subnet` in the runtime role; document the access model in `DAY-0.md` (who can log in as platform admin, how an engineer gets a WireGuard peer through `wg_engineer_peers`, and when to add a fixed office IP instead).
Backward compatible? yes for deploys that set it; stricter for ones that do not.
Tenant/security impact: reduces the public attack surface of the platform-admin login. No PHI fields.

### 5. GoTrue admin-create leaves a non-empty password hash  (To: C2 identity) (reported, unverified)
Problem: `bootstrap-platform-admin.ts` creates the GoTrue user with `email_confirm: true` and, per its own note, sets no password. After the first run on the host, `auth.users.encrypted_password` is not empty (boolean check only; the hash was not read). Night10 believes this GoTrue version stores a hash of a random password when none is given; that is from memory and not verified. Nobody knows the password either way, and the first real password has to come from the recovery mail, but the CLI note ("no password set") and the data disagree.
Proposed change: check the GoTrue version's admin-create behaviour, then either correct the CLI's message or make it explicit (set a random password and discard it). Add a test or a smoke assertion on the CLI result.
Backward compatible? yes.

### 6. GoTrue redirect allow-list defaults to empty  (To: C1) (reported)
Problem: the `supabase_stack` role default for `ADDITIONAL_REDIRECT_URLS` was empty. Staff web is allowed through `SITE_URL`, but recovery and invite links for portal users would be rejected. Night10 derived it from the portal origin on the host (`https://<origins.portal>`).
Proposed change: take the derivation into the role, and add the partner origin when `partner_enabled`. `API_EXTERNAL_URL` (`https://<origins.api>/auth/v1`), `SITE_URL` and `SUPABASE_PUBLIC_URL` already derive from `origins`; keep them the single source, and check them in the preflight.
Backward compatible? yes.

### 7. Secret ids that do not match what the code reads  (To: C1 schema, C2 identity) (reported)
Problem, from the identity contract night9 read from the code:
- `lims_identity_gotrue_service_key` is random, but GoTrue admin calls need a `service_role` JWT signed with `JWT_SECRET`. On the host, the random value got HTTP 403, `SERVICE_ROLE_KEY` got 200. Fixed with a value alias (CR-004 item 3 proposed deriving it).
- `lims_identity_token_enc_key` (singular, random) is read by nothing. The code reads `LIMS_IDENTITY_TOKEN_ENC_KEYS`, a JSON map `{"<id>":"<base64 of exactly 32 bytes>"}` (AES-256-GCM, the last id encrypts). Night9 generated `lims_identity_token_enc_keys` in a side file.
- `lims_identity_email_hmac_key` had no id; the code reads `LIMS_IDENTITY_EMAIL_HMAC_KEY` (any non-empty string). Generated in the side file.
- `lims_identity_patient_jwt_key` (Ed25519 PKCS8 PEM) was generated, but `LIMS_IDENTITY_PATIENT_JWT_KEY_FILE` is read by nobody (only a comment in `resolvePatientSession.ts`; the EdDSA signer is an injected seam in `IdentityPort.impl.ts`).
- Night6 found the same pattern for Storage: it accepts `SERVICE_ROLE_KEY`, not `core_storage_service_key`.
Proposed change: one pass over the schema so each id is read by the code or is removed; document derived ids (`lims_core_jwt_key`, `lims_identity_gotrue_service_key`, `lims_identity_gotrue_publishable_key`) and the JSON shape of the token enc keys; implement the patient JWT signer or drop the id.
Backward compatible? yes (additive or unused ids).

### 8. `docker restart` does not apply new environment  (To: C1 runbook) (reported)
Problem: a plain `docker restart` keeps the old environment, so config changes silently do not apply until the container is recreated. Night9 added `playbooks/night9-runtime-rolling.yml` (the `lims_runtime` role with `lims_runtime_up_services`: `up -d --wait --no-deps <service>`, one service at a time, at least one api up at all times).
Proposed change: take a rolling-recreate playbook into `infra/ansible/playbooks/` as the supported way to apply env changes, and say so in `runbooks/`.
Backward compatible? yes.

### 9. Day-0 contract needs the operator values  (To: C1 docs) (reported)
Problem: `DAY-0.md` (CR-003 item 10, CR-004) should list what the operator must supply, because the run needed them: the admin e-mail address and display name (the CLI default is "Platform Administrator"), the three public hostnames (staff web, portal, api) with DNS records pointing at the office static IP (DNS-only), the decision whether `acme_email` may be shared with the certificate authority, and a WireGuard peer for the platform admin (item 4). The first password is set through "forgot password", which needs the live relay, `public_base_url` reachable, the edge and TLS.
Proposed change: add this as a checklist at the top of `DAY-0.md`.
Backward compatible? yes.

Tenant/security impact: items 4 and 5 touch authentication; no PHI fields, no new public surface. No secret value appears in this CR.
IRD/regulatory impact: none.
Alternatives considered: keeping each fix only in the deploy copy on the host (done for the first deploy; not repeatable for a rebuild or DR).
Tests that will prove it:
- api: boots and reports `ready` with `missing_env` empty when only the documented variables are set; fails or degrades in production when the platform CIDR list is empty;
- static: every env name read by the api, web and portal config is provided by `compose.app.yml` (no unread names such as `LIMS_CORE_BFF_KEY_FILES`);
- host smoke: from inside api, `GET http://supabase-auth:9999/health` = 200 and an admin read with `SERVICE_ROLE_KEY` = 200; web reports its session provider as the production one;
- CLI: `bootstrap-platform-admin` on an empty database creates exactly one superadmin row and one `bootstrap_admin_created` event, and a second run reports `bootstrap_closed`.
