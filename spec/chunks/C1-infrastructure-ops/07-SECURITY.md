# C1 — Infrastructure & Operations — 07 SECURITY

Status: DRAFT for build, 2026-11-06. REQ IDs are cited, not copied (04 precedence rule 4). Applicability by phase per 04 §12: §1, §3, §4, §6, §7 of research 02 apply from Phase 1.

---

## 1. Applicable requirements and how C1 implements them

| REQ / 04 | How it applies in C1 | Where |
|---|---|---|
| REQ-SEC-007 / 04 S1, §11 | all PHI stores (DB, backups, Storage replica, audit store, logs) on Nepal hosts; no foreign SaaS for monitoring/logs/paging; egress register | 02-TRD §3, §5.5, CR-C1-006 |
| REQ-SEC-012/029/030/039/131 / 04 D5 | no app/job uses BYPASSRLS roles; ops roles `lims_monitor`, `lims_replicator`, `lims_audit_ship` are NOBYPASSRLS; image superuser only for pgBackRest (local socket) and Studio break-glass | 02-TRD §7.8, §7.10; CR-C1-002 |
| REQ-SEC-032/033 / 04 S3 | PostgREST schema `api`, `db-max-rows` 100, no public route to `/rest/v1` | 02-TRD §6.3, §7.3 |
| REQ-SEC-035 / 04 A14 | no public signed-URL path (08 A14.2: no files origin; signed URLs are internal to the API); query strings never logged; signing-key rotation runbook | 02-TRD §6.1, §6.7, §8.5 |
| REQ-SEC-036 / 04 S5 | Realtime off in Phase 1; Phase 3 override requires "public access" off (setting name UNVERIFIED) | 02-TRD §7.3 |
| REQ-SEC-037 / 04 S6 | every `.env.example` secret replaced; Studio/pg-meta never public, break-glass only; gateway 127.0.0.1; gateway config under version control (vendored snapshot) | 02-TRD §7.1–7.3, §7.10, §8.2 |
| REQ-SEC-045/133 | alert rules for RLS-denied spikes, auth failures, exports, rate-limit spikes, Studio, cert expiry, backup failures | 02-TRD §11.3 |
| REQ-SEC-064/078/079 / 04 §4 (as amended by 08 Addendum A1, A13 D-32/D-43, A19 D-116/D-122) | nginx flood guards keyed by client IP only: 60 POST/min/IP (burst 20) on public login/recovery routes, QR 10/min on portal `/v/*`, bridge agent 600/min/IP (burst 200; the per-device 60/min `ingest` tier is app-side), patient OTP 60/min/IP (burst 20), patient session resolve 120/min/IP, provider callbacks 60/min/IP, payment routes 10/s/IP; per-account login limits and the per-client-IP **failure** throttle (≥ 10 failures/10 min → 5/min for 30 min) are C2's; hourly/daily caps left to app/Valkey (`LIMS_CORE_RATELIMIT_BACKEND=redis`; Valkey down → logins/OTP fail closed, `ValkeyDown` page); no static-IP dependency | 02-TRD §6.5, §7.4, §11.3 |
| REQ-SEC-084 | ClamAV on `app_net` only, `tcp://clamd:3310` INSTREAM, `StreamMaxLength`/`MaxFileSize` 20M, keys `LIMS_CORE_SCANNER_URL`/`_TIMEOUT_MS` (08 A25 D-209) | 02-TRD §7.4 |
| REQ-SEC-085 | no files origin (08 A14.2 / A13 P-2): stored files are streamed by the API (`ctx.download.stream`, C0), which sets the download headers; nginx exposes no Storage path; inline exception for re-encoded rasters is the accepted risk of 08 A17 D-67 (C0/C11) | 02-TRD §6.1, §6.3, §6.4 |
| REQ-SEC-086 / 04 S14 | renderer on internal network, no egress, no metadata IP, memory cap | 02-TRD §3.2, §7.4 |
| REQ-SEC-087 / 04 S15, R7 | envelope for C6's pdf-sandbox (08 A25 D-204): `render_net` only, inbound from the workers only, no egress, non-root, read-only, tmpfs, 1 CPU / 512 MiB, pids 64, only its inbound token as secret; timeouts and parsing are C6's | 02-TRD §7.5 |
| REQ-SEC-090 / 04 I6 | HSTS `max-age=63072000; includeSubDomains` (no preload), headers on every response | 02-TRD §6.4 |
| REQ-SEC-091/092 | edge strips internal headers (except `X-Lims-Background` on BFF origins — 08 A25 D-206); `/v1/` and Supabase prefixes not proxied via staff_web/portal/partner; client IP trusted only from nginx or a BFF with a valid key (P-61); CORS/Origin checks are app-side (C0) | 02-TRD §6.3, §6.6 |
| REQ-SEC-095 | nginx 429/4xx bodies are generic problem+json; `server_tokens off` | 02-TRD §6.4–6.5 |
| REQ-SEC-096/097 / 04 D11 | audit/access/activity logs shipped to a separate, append-only store on another site, ≥ 5 years, daily hash chain | 02-TRD §10.3; 05-SCHEMA §3 |
| REQ-SEC-098 | access logs carry route templates only (`/r/{token}`, `/v/{token}`, provider-callback `{token}`, payment `:token`); no query strings; scrub filter; `log_parameter_max_length = 0` | 02-TRD §6.7, §7.7, §10.1 |
| REQ-SEC-099 | public path allowlist; everything else 404 at edge | 02-TRD §6.3; CR-C1-004 |
| REQ-SEC-123 / IC X6 | agent offline/backlog/degraded alerts from C7 metrics | 02-TRD §11.2 |
| REQ-SEC-124 / 04 I5 | TLSRef intermediate config, ECDSA P-256, 90-day ACME, tested by testssl.sh | 02-TRD §6.2 |
| REQ-SEC-125 | LUKS2 on every data volume; keys not on same host's plaintext disk | 02-TRD §5.3 |
| REQ-SEC-126/127 / 04 I2, I3 | pgBackRest aes-256-cbc per repo, separate cipher passes (none on dr-1; repo1's only on data-1 tmpfs), WAL to site B with `archive_timeout = 60s` and `RpoAtRisk` at 840 s (08 A25 D-205), monthly timed drill; post-promotion degraded mode with interim ops-1 repo and `NoOffsiteArchive` (D-210) | 02-TRD §9, §11.3 |
| REQ-SEC-128 | SOPS+age, secrets outside product repo, tmpfs rendering, gitleaks | 02-TRD §8 |
| REQ-SEC-129/138 / 04 I9 | digests pinned; trivy gate; monthly patching, critical 72 h | 02-TRD §12.2, §13 |
| REQ-SEC-130 | container hardening defaults; no docker.sock mounts; per-network `DOCKER-USER` allowlists (`edge_net` only via nginx, `db_net` only to the primary's DB ports + GoTrue SMTP, internal `app_net`/`auth_net`/`render_net` — 08 A25 D-203); Σ `mem_limit` ≤ 85 % host RAM (D-207) | 02-TRD §3.1, §3.2, §5.5, §5.7 |
| REQ-SEC-132 | only 80/443 public; SSH wg-only key-only; fail2ban (no 404-counting jail — 08 A25 D-211); monthly external scan | 02-TRD §3.3, §5.2, §6.8 |
| REQ-SEC-134 / 04 L17 | incident runbook with Privacy Act decision record; tabletop twice yearly | 03-APP-FLOW §12; 04-UI-UX §5 |
| REQ-SEC-135 / 04 I7 | no foreign CDN; local mitigation; ISP contact (UNVERIFIED) | 04-UI-UX §4.3 |
| REQ-SEC-136 | dev/staging/prod separated (hosts, secrets, keys, wg subnets); no real provider creds outside prod | 02-TRD §12.1 |
| REQ-SEC-137 | chrony; `ClockSkew` alert | 02-TRD §5.6 |
| REQ-SEC-140 | operator offboarding ≤ 1 business day | 04-UI-UX §2 |
| REQ-SEC-141 | vendor/egress register incl. DC provider (B12) | CR-C1-006 |
| REQ-SEC-142 | static status page, no PHI | 03-APP-FLOW §15 |
| CR-C2-012 | GoTrue on `auth_net` + `db_net` (DB and the SMTP relay exception only, 08 A25 D-203), no published port; `/v1/identity/auth/*` not public (patient-session exception when C16 ships); per-IP login flood guard on the **public** BFF/app login routes keyed by client IP, never on BFF-only API routes (08 R6 placement, Addendum A1); SMTP relay; `/auth/confirm` query excluded from logs; recovery TTL ≤ 60 min, refresh rotation (env names UNVERIFIED until C2 T1) | 02-TRD §3.2, §6.3, §6.5, §6.7, §7.3 |

## 2. Assets and trust boundaries

| Asset | Boundary | Most sensitive content |
|---|---|---|
| A1 Postgres primary (data-1) | wg0 only | all tenants' PHI |
| A2 Backup repos (repo1, repo2) | data-1 disk; dr-1 SFTP chroot | encrypted full DB copies |
| A3 Storage volume + replica | app-1, dr-1 | report PDFs, TRFs |
| A4 Audit store | dr-1:5433 | old/new values of clinical/billing changes |
| A5 Secrets repo + age keys | ops-1, founder/ops lead offline | every credential |
| A6 Edge (nginx) | internet | TLS keys, request stream |
| A7 Supabase services (GoTrue, Storage, gateway, Studio) | app_net/auth_net/db_net; gateway unpublished (127.0.0.1 only during break-glass) | auth DB access, service keys |
| A8 Renderer, pdf-sandbox (C6 images) | render_net (internal), no egress | report data during render; untrusted PDFs |
| A9 Ops-1 (CI runner, registry, monitoring, logs, agent release service) | wg0; GitHub outbound for runner | images, deploy capability, IP logs, C7 release signing key + client Authenticode certificate |
| A10 WireGuard mesh / SSH | public UDP, wg0 | admin access to everything |

## 3. Threat model (STRIDE per asset / entry point)

| Asset / entry | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| A6 edge | forged `X-Forwarded-For` → overwritten | header injection of `X-Lims-*` → stripped | access.json + `edge_request_id` | token URLs in logs → route templates; version banners → off | floods → limits, syncookies, fail2ban, ISP | path to internal services → default-deny allowlist |
| A1 DB | stolen app creds → wg0-only + pg_hba per source | direct writes bypassing API → no public port, role grants (C0) | audit triggers (C0) + store | dumps via exposed port → closed; logs with bind params → disabled | connection exhaustion → PgBouncer caps, `max_connections` | BYPASSRLS role misuse → only image superuser via local socket, Studio break-glass with approval |
| A2 repos | SFTP impersonation → host-key fingerprint pinned | repo tampering → pgBackRest checksums/`verify`, drill | `ops_audit` | stolen repo → aes-256-cbc, pass not on repo host | repo deletion on dr-1 → repo1 copy; dr-1 access limited to chroot account | — |
| A3 Storage | — | ransomware overwrite → replica `--ignore-existing`, no delete | replica logs | public bucket/route → none: no files origin, Storage only on `app_net` (08 A14.2) | disk fill → forecast alert, growable LV | — |
| A4 audit store | — | edit history → INSERT-only roles, hash chain, separate site | digests + `ops_audit` | investigator browsing → `audit_reader` split password, runbook approval | slot invalidation → alert + backfill runbook | superuser misuse → split password |
| A5 secrets | stolen age key → hardware/offline prod key, LUKS on ops-1 | secret file swap → git history (encrypted), decrypt audit | `ops_audit` decrypt lines | leak via repo → not in product repo; gitleaks | — | runner reading prod key → separate decrypt service gated by approval |
| A7 Supabase | GoTrue reachable by attacker → `auth_net` only; signup disabled | env drift → compose config in git + drift check | — | Studio basic-auth over HTTP → never public, ssh tunnel only; `OPENAI_API_KEY` unset | — | default secrets → AC-05.1 |
| A8 renderer/sandbox | other containers calling the sandbox → inbound only from the workers + C6 bearer token | malicious PDF → sandbox, no egress | job status (C6) | SSRF to internal network/metadata → no egress | hang/zip-bomb → C6 timeouts, memory/pids caps | container escape → non-root, cap_drop ALL, read-only, only its inbound token as secret |
| A9 ops-1 / CI | PR code on self-hosted runner → protected branches/tags only | poisoned image → digest pinning, trivy, mirror from upstream digests | CI logs, release locks | IP logs → restricted roles, 90-day retention | ops-1 down → Watchdog, Ansible from laptop | runner → prod → approval-gated decrypt |
| A10 WG/SSH | stolen laptop key → per-person peers, prompt revocation | — | auth logs shipped | — | UDP flood on 51820 → source-restricted | sudo → named accounts, `sudo -l` allowlists for on-call |

## 4. Abuse cases

| # | Abuse | Control | Test |
|---|---|---|---|
| AB-1 | Internet scanner probes 5432/6543/8000/Studio | binds + nftables + allowlist | AC-01, AC-06 |
| AB-2 | Attacker brute-forces staff login from one IP | C2 per-IP failure throttle (≥ 10 failures/10 min → 5/min for 30 min + alert) + per-account 10/hour (C2) + nginx 60/min/IP flood guard + fail2ban `lims-auth` only on login-zone flood rejections (≥ 300 `limit_req` 429s in 10 min → ban 15 min + alert `LimsAuthJailBan`; 401s never counted — 08 Addendum A3.2) | AC-04.1, AC-04.4, AC-04.5, AC-04.6; C2 07-SECURITY stuffing test |
| AB-2a | Shared lab NAT with many failing staff (typos at shift start) | no fail2ban ban from failed logins: `lims-auth` counts only login-zone `limit_req` rejections, `lims-ratelimit` ignores login-zone, `agent`/`otp`/`psession`-zone and app-generated 429s; C2's failure throttle slows (does not block) the IP (08 Addendum A1/A3.2, A27.2) | AC-04.6, AC-04.4a |
| AB-3 | Attacker enumerates QR tokens | 10/min/IP at nginx + 100/day app (C6) | AC-04.2 |
| AB-4 | Compromised lab PC floods the agent API | nginx 600 r/m/IP flood guard (08 A13 D-43) + per-device 60/min app tier `ingest` (C7/C0) + body 4 MiB (16 MB attachments) | AC-04.3, AC-04.3a |
| AB-5 | Crafted HTML in report data makes renderer fetch internal URL | renderer egress blocked | AC-09.1 |
| AB-6 | Malicious outsourced PDF exploits qpdf | C6 sandbox inside C1's envelope: no egress, only its inbound token, caps, reachable only from the workers | AC-10.1 |
| AB-7 | Insider copies a backup file | client-side encryption; pass elsewhere | AC-12.3 |
| AB-8 | Admin edits audit history to hide result tampering | separate store, INSERT-only, hash chain | AC-18.3; digest re-verify test |
| AB-9 | Developer commits `.env` | gitleaks; secrets outside repo | AC-05.2 |
| AB-10 | Fork PR runs on self-hosted runner to steal secrets | runner never takes PR jobs; no prod key for runner | CR-C1-001 test |
| AB-11 | Signed URL or report token leaks through logs | route-template logging, no query strings | AC-18.4 |
| AB-12 | Operator leaves Studio running | ≤ 4 h timer, hourly alert | AC-06.3 |
| AB-13 | Ex-employee keeps VPN access | offboarding ≤ 1 business day, peer removal | runbook check in quarterly access review |
| AB-14 | Attacker sends `X-Lims-Background`/`X-Request-Id` to skew idle tracking or logs | `X-Lims-Background` can only reduce session touching (BFF calls `resolveSession` with `touch: false`), so it is **not stripped on BFF origins** (staff_web, partner, portal) and spoofing it only shortens the sender's own session; stripped on the api origin; `X-Request-Id` and other `X-Lims-*` stripped everywhere (08 A25 D-206) | `routes.py` header test (pass-through on BFF origins, stripped on api) |
| AB-15 | Bridge agents of one lab NAT hit a renamed path (404 storm) | no jail counts 404s (08 A25 D-211); `EdgeNotFoundSpike` warn only | AC-04.7 |
| AB-16 | Attacker abuses payment launch/callback routes (POST bodies, token leaks via Referer/logs, floods) | GET/HEAD only, no body, 10 r/s/IP burst 20, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `:token` masking, no query strings logged (CR-C15-008) | AC-04.8, AC-18.4 |
| AB-17 | Forged `X-Forwarded-For` to shift per-IP counters | nginx overwrites it; the core trusts it only from the nginx peer (`LIMS_CORE_TRUSTED_PROXY_CIDRS`) or a BFF with a valid key (P-61) | AC-32.1 |
| AB-18 | Compromised container reaches the internet or another host directly | per-network `DOCKER-USER` allowlists; Squid FQDN allowlist for api/worker (08 A25 D-203) | AC-09.3 |

## 5. Required security tests

Cross-tenant probes: C1 owns no endpoint and no application table, so the CV §11.3 per-endpoint/per-table probes do not apply to C1 code; C1 **runs** every chunk's probe suite in staging smoke. C1-specific security tests:

| Test | File | Gate |
|---|---|---|
| External port scan (all VMs) | `tests/external/ports.py` | every deploy + monthly |
| TLS profile | `tests/external/tls.sh` (testssl.sh) | every deploy |
| Security headers (incl. payment-route headers) | `tests/external/headers.py` | every deploy |
| Route allowlist (Supabase/Studio/identity/health/`/storage/v1` paths 404 on every origin; explicit denies on BFF origins; generated YAML = committed YAML) | `tests/external/routes.py` | every deploy |
| Edge rate limits + 429 body | `tests/external/ratelimit.py` | staging deploy |
| Published ports have explicit host IPs | `tests/internal/published_ports.py` | CI + deploy |
| Secrets differ from `.env.example`, length rules, cross-env uniqueness | `tests/internal/secrets_not_default.py` | deploy |
| Container hardening (user, read_only, caps, no docker.sock) + Σ `mem_limit` ≤ 85 % host RAM | `tests/internal/container_hardening.py` | deploy |
| Renderer egress denied (internet, metadata IP, DB, other containers) | `tests/internal/renderer_egress.sh` | deploy |
| pdf-sandbox envelope (render_net only, inbound only from workers, no egress, caps, single secret) | `tests/internal/sandbox_envelope.sh` | deploy |
| Valkey persistence off, no volume | `tests/internal/valkey_ephemeral.sh` | deploy |
| DB role attributes (no BYPASSRLS/SUPERUSER for `lims_%`; REPLICATION only for the two roles) | `tests/internal/roles.sql` | deploy |
| Audit-store append-only privileges | `tests/internal/auditstore_roles.sql` | deploy |
| Log PHI scan: planted synthetic PHI-like fields are redacted by Fluent Bit; nginx log has no query strings | T-17 test | CI (dev) |
| Product-host and per-container egress: non-listed hosts fail; `db_net` only to the primary's DB ports; GoTrue only to the relay:587; `edge_net` members no egress | `tests/internal/egress_probe.sh` | deploy |
| Privilege escalation: `ops_oncall` cannot run non-allowlisted sudo / decrypt prod secrets | `tests/internal/oncall_sudo.sh` | quarterly |
| GoTrue not reachable from `edge_net`/`render_net` | `tests/internal/auth_net.sh` | deploy |

Centre-scoping tests: not applicable to C1 (no tenant data paths); C1 adds no label or dashboard that breaks centre scoping (no PHI on dashboards).

## 6. PHI handling and logging rules (C1)

1. Operators never query PHI rows for routine work; investigations use `audit_reader`/break-glass with founder approval recorded in `ops_audit`.
2. Restore drills handle real PHI only on ops-1 LUKS scratch volumes, output counts/timings only, and discard volumes after.
3. Logs: route templates only; no query strings, bodies, bind parameters, cookies, Authorization headers; user agent reduced to class; Fluent Bit scrub filter as second line (CV §9.2).
4. Metrics: drop-list of PHI-ish label names at scrape; only tenant/centre/agent UUIDs allowed as labels.
5. Alerts and e-mails: no names, phones, e-mails, barcodes, results; lint enforces.
6. Non-prod environments contain synthetic data only; no production backup is ever restored into dev/staging (REQ-SEC-136) — the drill restores to an isolated scratch instance on ops-1, never to staging.
7. Status page: component states only.

## 7. Secrets used / managed by C1

| Secret | Consumer | Storage | Rotation |
|---|---|---|---|
| All upstream Supabase secrets (02-TRD §8.2 list) | Supabase services | SOPS → tmpfs env/file | 365 d [CONV]; JWT keys with C2/C0 overlap procedure |
| `lims_*` DB passwords incl. `lims_monitor`, `lims_replicator`, `lims_audit_ship` | API, worker, migrator, exporter, standby, audit store | SOPS → tmpfs | 180 d [CONV] |
| Audit store role passwords (`audit_writer`, `audit_digest`, `audit_reader` split) | dr-1 | SOPS | 180 d |
| pgBackRest `repo1-cipher-pass`, `repo2-cipher-pass` | data-1 db container, drill | SOPS (offline escrow copy with founder) | new repo + full backup |
| SFTP/SSH keys (repo2, object replica) | data-1, app-1 | SOPS | 365 d |
| LUKS keys/passphrases | all hosts | SOPS (keyfiles), founder/ops lead (passphrases) | `luksAddKey`/`luksRemoveKey` 365 d |
| TLS private keys | nginx | generated on app-1 by ACME client; never leave host | every 90 days (ACME) |
| WireGuard private keys | each host/engineer | generated locally, never copied | on compromise/offboarding |
| Registry htpasswd, Grafana, ops nginx basic auth, Alertmanager SMTP relay creds, Valkey ACL (`valkey_lims_api_password`), internal CA key | ops-1, app-1 | SOPS | 365 d / offboarding (CA key 5 years [CONV]) |
| BFF keys `bff_key_staff_web`, `bff_key_partner`, `bff_key_portal` | api-a/b + the matching BFF only | SOPS → tmpfs file | 365 d, core accepts old + new during the overlap (08 A19 P-45) |
| C6: `reporting_otp_hmac_key`, `renderer_inbound_token`, `pdf_sandbox_inbound_token`, `reporting_channel_<secret_ref>` | worker/api; renderer; sandbox | SOPS → tmpfs file | 365 d / per C6 TRD (CR-C6-013) |
| C7: `instruments_config_signing_key` (api, worker); `instruments_release_signing_key`, `instruments_authenticode_cert` (ops-1 release service only, never a product host) | as stated | SOPS | per C7 runbook / certificate expiry (CR-C7-012) |
| C15: `payments_kek` | api-a/b, worker-a/b (read-only) | SOPS → tmpfs file | add → active → rewrap → remove (CR-C15-008) |
| `tenant_ops_contacts`, `alert_contacts` (e-mail addresses — personal data, not in git) | Alertmanager renderer (ops-1) | SOPS | on change |
| Provider credentials of other chunks (SMS, WhatsApp, relay, CBMS, gateways) | worker | SOPS (added by owner CRs); prod only | per owner TRD |
| age keys (per env) | ops-1 decrypt service, founder | hardware/offline + LUKS | on compromise; re-encrypt all files |

## 8. Residual risks / open items
- Logical-replication privilege model (T-15), pgBackRest packaging (T-09), compose split (T-05), intra-bridge filtering via `br_netfilter` (T-14): spikes with fallbacks (06 §5).
- After a DR promotion the second-site archive and the separate-host audit store are lost until switch-back (08 A25 D-210; `NoOffsiteArchive` pages; no third site ordered — B12).
- app-1 needs 32 GB (08 A27.1: 16 GB is not deployable as specified); founder cost confirmation F-09 (06 R14).
- DR site storage may need 2 TB (F-10, 08 A27.4); T-09 measures it before go-live.
- (Closed by 08 A27.2: `lims-ratelimit` never counts `agent`/`otp`/`psession`-zone rejections — 06 R15.)
- (Closed by 08 A27.3: renderer counters are re-exported by the C6 worker; 02-TRD §11.1.)
- Studio connects as BYPASSRLS `postgres` (upstream design) — mitigated only procedurally (break-glass approval, time limit).
- Foreign supply-chain downloads and e-mail relay remain outbound non-PHI touchpoints (CR-C1-006).
- DDoS above upstream capacity = downtime (accepted, REQ-SEC-135).
- IRD server access form unknown (B6); Privacy Regulation 2077 content unverified (B16).
