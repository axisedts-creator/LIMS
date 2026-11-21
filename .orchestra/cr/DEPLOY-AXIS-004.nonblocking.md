Title: CR-C1-DEPLOY-004: first real prod deploy, part 4: findings from starting the app stack and the JWT / mail / worker fixes (night7, night8)
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21)    To owner: per item (listed below)
Type: bug
Blocking? yes for production go-live (login cannot work, the worker job fails, several services cannot start on a single host without these fixes); no for any current orchestra task, so this file is named `.nonblocking`.
Relation to earlier CRs: 001 (build and stack-start defects), 002 (migrate runner, lock, push credential, inputs), 003 (first real migrate/push/release findings). This CR adds what happened when the app stack was actually started on one host (night7) and when JWT, mail and the worker job were fixed (night8). Fixes exist in the deploy copy on the host and in `DEPLOY-AXIS-NIGHT7.patch` / `DEPLOY-AXIS-NIGHT8.patch` (held by the deployer, not in the repo). Evidence per item: (verified) = I checked it in the repo; (reported) = night report from the host, not re-checked by me.
Outcome on the host: all 10 app containers healthy, api `/v1/core/health/ready` 200, rule-5b firewall live, a Brevo SMTP login (no mail sent) succeeded, the worker job completes after the fix. Login by a real user, the first admin and the first tenant are NOT proven.

## Items

### 1. Platform-scoped cron tasks run with the wrong payload  (To: C0-0D / owner of `services/worker`) (cause verified, effect reported)
Problem: `services/worker/src/core/tasklist.ts:61-67` only wraps cron entries whose scope is `per_tenant` with the cron-fire handler (`cronTick`). A crontab entry with `tenantScope: 'platform'`, for example `identity.expire_support_sessions`, is therefore executed directly with Graphile's `{_cron:{ts,backfilled}}` payload, and its `platformOnly` guard (payload must be exactly `{}`) throws `common.validation_failed` on every run (every 5 minutes, 25 attempts). Other platform identity crons would fail the same way when due. `cronTick` already has a platform branch that enqueues `{}` under the module's system actor; it is just not wired for platform-scope cron entries.
Proposed change: apply the cron-fire wrapper to every cron entry regardless of scope (night8's one-line change in `tasklist.ts`, see patch), plus a test that runs a platform-scope cron entry through the task list with a `_cron` payload. Cosmetic: the success log prints `msg":"[object Object]"` because the task passes an object to `log.info`.
Backward compatible? yes.

### 2. API JWT key and GoTrue JWT secret are two different secrets  (To: C1 secrets schema, C2 identity) (ids verified, behaviour reported)
Problem: the schema has a random id `lims_core_jwt_key` (`prod.secrets.schema.yaml:189`) that the api reads as `LIMS_CORE_JWT_KEY_FILE` (`compose.app.yml:42`), while GoTrue signs with `JWT_SECRET` (upstream compose `GOTRUE_JWT_SECRET: ${JWT_SECRET}`, no JWKS keys configured). The api verifies HS256 with a value GoTrue never uses, so no real login can ever pass signature checks. Night8 fixed it on the host with a value alias in `secrets_render` (`lims_core_jwt_key` takes the value of `JWT_SECRET`); proof used a token minted with the right key (401 `auth.unauthenticated`: signature, issuer and audience pass, user unknown) and one with a wrong key (401 `auth.token_invalid`). A real GoTrue-issued token is still untested. Issuer must equal `https://<origins.api>/auth/v1` (GoTrue `API_EXTERNAL_URL`).
Proposed change: remove the separate random `lims_core_jwt_key` or declare in the schema that it is derived from `JWT_SECRET`; document issuer and audience; add a deploy smoke check that a GoTrue-issued token for a test user passes the api's signature check.
Backward compatible? yes (nothing could log in before).
Tenant/security impact: the signing secret is shared by GoTrue and the api; scope it to the two containers' tmpfs files only.

### 3. `LIMS_IDENTITY_*` is not wired for api and worker  (To: C2 identity, C1) (verified for compose, reported for ids)
Problem: `compose.app.yml` sets no `LIMS_IDENTITY_*` variable. The identity module needs, per night8's read of the code, `LIMS_IDENTITY_GOTRUE_URL`, `LIMS_IDENTITY_GOTRUE_SERVICE_KEY`, `LIMS_IDENTITY_EMAIL_HMAC_KEY`, `LIMS_IDENTITY_TOKEN_ENC_KEYS`, `LIMS_IDENTITY_PLATFORM_ALLOWED_CIDRS`, `LIMS_IDENTITY_PATIENT_JWT_KEY_FILE`. Only some have a schema id (`lims_identity_token_enc_key`, `lims_identity_gotrue_service_key` exist; the email HMAC key and the patient JWT key have none). The api's login and password-recovery endpoints will not work, and the first-admin CLI needs at least the GoTrue URL and service key. The GoTrue admin API needs a `service_role` JWT signed with `JWT_SECRET` (upstream `SERVICE_ROLE_KEY`), not the random `lims_identity_gotrue_service_key`; this is not yet proven by a call (calling it would create a user).
Proposed change: wire the variables in `compose.app.yml` and the runtime role, add the missing ids to the schema (with generator rules), and decide which upstream key backs `lims_identity_gotrue_service_key` (derive it from `SERVICE_ROLE_KEY`).
Backward compatible? yes.

### 4. Engagement module cannot boot: no secret ids, no env  (To: C1 secrets schema, owner of `engagement`) (verified)
Problem: the api module `engagement` refuses to start without `LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE`, `LIMS_ENGAGEMENT_LINK_HMAC_KEY_FILE`, `LIMS_ENGAGEMENT_PHONE_HMAC_KEY_FILE` and `LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE` (reported from `engagement/config.ts`). The prod secrets schema has no matching ids (verified: only `lims_core_jwt_key` and `lims_identity_*` appear) and `compose.app.yml` sets no `LIMS_ENGAGEMENT_*` variable (verified). Night7 generated four ids in a side file on the host (`lims_engagement_otp_hmac_key`, `lims_engagement_link_hmac_key`, `lims_engagement_phone_hmac_key`, `lims_engagement_otp_enc_keys`).
Proposed change: add the four ids to all three schema files and the generator, and the file mounts and env to `compose.app.yml`.
Backward compatible? yes.

### 5. Rate-limit backend default is not supported by the api  (To: C0-0D / owner of `core`) (default verified, behaviour reported)
Problem: `compose.app.yml:19` sets `LIMS_CORE_RATELIMIT_BACKEND: redis`, but the api refuses to boot with it ("not wired in the API yet (no Redis client)"). Night7 switched to `postgres`; valkey runs idle.
Proposed change: either wire a Redis client in the api, or default the compose value to `postgres` and say valkey is reserved. Add a boot test per supported backend.
Backward compatible? yes.

### 6. `pg_hba.conf` is a single-file read-only bind mount  (To: C1) (mount verified, behaviour reported)
Problem: `override.data.yml:16` mounts `pg_hba.conf` as a single file with `:ro`. The Ansible template task replaces the file (new inode), so a SIGHUP reloads the old file inside the container. Night7 proved it with `pg_hba_file_rules` and needed three container restarts of `supabase-db` and `supabase-pgbouncer`.
Proposed change: restart (not reload) the db and then pgbouncer through a handler when `pg_hba.conf` changes (night8's role handlers), or mount the directory instead of the file. Document it in the role.
Backward compatible? yes.

### 7. Single-host `pg_hba` and firewall interplay  (To: C1) (reported)
Problem: on one host the hairpin-DNAT connection from `db_net` reaches Postgres masqueraded as the `supabase_pub` gateway (172.30.71.1), so the lean profile needs pg_hba lines for `lims_api`, `lims_worker`, `lims_migrator` from that address plus a reject for everything else from it and an accept for the supabase_pub /24 (PgBouncer resolves `db` to either address). Night7 added these under the lean profile. Together with rule 5b (CR-003 item 8), a single-host install needs both.
Proposed change: take night7's `pg_hba.conf.j2` lines under the lean profile; document the single-host network in `DECISION.md`.
Backward compatible? yes (lean profile only).
Tenant/security impact: the accept covers only the three named logins and only from the supabase_pub range; all other users from that address are rejected.

### 8. `compose.app.yml` needs production environment and Docker 29 fixes  (To: C1) (reported)
Problem, each found by a failing start:
- `migrate` runs the image default `pnpm db:migrate` without `PGPASSWORD` on every `compose up`; it needs `profiles: [migrate]` (it still works with `compose run migrate`).
- Docker 29 mounts tmpfs as 0755 root, so every `/tmp` needs `mode=1777`, and the squid, clamd, valkey and pdf-sandbox tmpfs dirs need owners (squid could not create `/run/squid/squid.pid`).
- Squid healthcheck: the pinned image has no `squidclient`; use `squid -k check` (and update `infra/tests/static/test_t14_runtime.py`).
- Missing core env for production: `LIMS_CORE_ENV=production`, the payments gateway env and base URL, `LIMS_ORIGIN_STAFF_WEB`, `LIMS_ORIGIN_PORTAL`, `LIMS_REPORTING_ALLOW_REAL_PROVIDERS=true` (the code demands it in production), JWT algorithm, issuer and audience.
- `lims_runtime` env: `LIMS_CORE_JWT_ISSUER`, `LIMS_PUBLIC_BASE_URL`, `LIMS_ORIGIN_*`, `LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID` (a real value is needed; night7 used `night7-initial`), `PROBE_IMAGE` for the egress probes (the node images have no `nc`).
Proposed change: take the `compose.app.yml` and role edits from the night7 patch; add a static check that every `${VAR:?}` is in the role environment (CR-002 item 3).
Backward compatible? yes.

### 9. `secrets_render` bugs on a single host  (To: C1) (reported)
Problem: (a) the controller-side `sops -d` task runs as root without the age key; it needs `become: false` (two tasks). (b) `secrets_render_uids` lacks 11 services (api-a/b, worker-a/b, web, portal, partner, renderer, pdf-sandbox = 10001; release = 0; alertmanager = 65534). (c) There is no supported way to load operator side files (night7 and night8 added `secrets_render_side_enc_files`, `secrets_render_env_derived` and `secrets_render_value_aliases`); the database URLs for api and worker had to be derived from `lims_api_password` / `lims_worker_password` into the tmpfs env files with a URL-safety assert.
Proposed change: take the role changes from the patches; document the side-file and alias mechanism in `runbooks/secrets.md`.
Backward compatible? yes.

### 10. ClamAV role does not work on one host  (To: C1) (reported)
Problem: the signature sync expects an ssh key pair the role never generates; `/srv/lims` is root 0700, so the unprivileged sync account cannot reach `/srv/lims/clamav-db` (rrsync `Permission denied`); `database.clamav.net` is not in the ops Squid allowlist; the clamd image entrypoint chowns the read-only signature mount and exits (compose needs `entrypoint: [clamd, --foreground]`); `/run/clamav` tmpfs needs owner 100:101.
Proposed change: on a single host (`ops` == `app`) copy locally as root and reload with the root helper (night7's `clamav-sync.env.j2`); otherwise generate the key pair in the role; add `database.clamav.net` to `ops_squid_allowed_domains`; fix the clamd entrypoint and tmpfs owner.
Backward compatible? yes (the two-host ssh path is unchanged).

### 11. `egress_proxy` fails while the relay name is a placeholder  (To: C1) (reported)
Problem: the "Resolve the relay now" task fails when `smtp_relay_fqdn` does not resolve. Night7 added `egress_proxy_relay_resolve_required` (default true); night8 set it back to true once the real host resolved. The `smtp_relay_ips` nftables set rule covers the GoTrue container address only (172.30.50.20), so Alertmanager on the ops side may not be able to reach the relay on port 587; untested.
Proposed change: keep the toggle, document it, and add the Alertmanager source to the egress rule if it is meant to send mail directly.
Backward compatible? yes.

### 12. Monitoring play restarts the whole ops stack  (To: C1) (reported; extends CR-003 item 9)
Problem: the handler "Restart ops stack" restarts the entire monitoring compose project (ops-nginx, prometheus, grafana, alertmanager, blackbox); the play has no tag to change only the nginx or Alertmanager config. Night7 hit it while applying the new Grafana login; night8 therefore deferred the Alertmanager mail change to an approved window.
Proposed change: render each config to a bind-mounted file and reload the single affected service (`nginx -s reload`, `SIGHUP` or `/-/reload` for prometheus and alertmanager); add per-component tags.
Backward compatible? yes.

### 13. Operator-supplied secrets have no documented path  (To: C1) (reported)
Problem: values only a human can supply (Brevo SMTP login and key, sender address, later the admin e-mail) have no safe entry procedure in the repo. The deployer wrote `scripts/make-mail-secrets.sh` (hidden prompt, encrypt-only, no plaintext on disk). The repo's `smtp_relay_gotrue` id ("pair = SMTP_USER / SMTP_PASS") is read by no role; GoTrue uses `SMTP_USER` / `SMTP_PASS` directly, and `alertmanager_smtp_relay` needs `{user, password, from}`.
Proposed change: take the script into `infra/ci/` or `runbooks/`, make `smtp_relay_gotrue` either used or removed from the schema, and document which id each consumer reads.
Backward compatible? yes.

Tenant/security impact: items 2 and 3 touch authentication; no PHI fields, no new public surface. No secret value appears in this CR.
IRD/regulatory impact: none.
Alternatives considered: keeping every fix only in the deploy copy on the host (done for the first deploy; not repeatable for a rebuild or DR).
Tests that will prove it:
- worker: a platform-scope cron entry given a `_cron` payload completes without `common.validation_failed`;
- api: boots with each supported rate-limit backend; boots with the engagement and identity env present; a token signed by GoTrue for a test user passes signature, issuer and audience;
- host dry run on an empty single-host `prod-lean` inventory: `site.yml` / the runtime play from images to 10 healthy app containers with no manual variable or file edits, `pg_hba` change restarts the db handler, ClamAV sync works with `/srv/lims` 0700;
- static: every `${VAR:?}` in `compose.app.yml` is provided by `lims_runtime`; every id a role reads exists in the schema.
