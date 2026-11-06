# C1 — Infrastructure & Operations — 01 PRD

Status: DRAFT for build, 2026-11-06. Phase 1 (Wave 1, 01-CHUNK-MAP §1). Owned path: `infra/` only (01 §3).
Abbreviations: **04 X** = row X of `research/04-consolidated-decisions.md`; **CV** = `program/02-CONVENTIONS.md`; **IC** = `program/03-INTERFACE-CATALOG.md`; **CM** = `program/01-CHUNK-MAP.md`; **00** = `research/00-scope-baseline.md`. Labels VERIFIED / UNVERIFIED / DECISION / BLOCKED / ASSUMPTION / [CONV] as defined in `program/00-README.md`.

---

## 1. Purpose

C1 turns the code that the other chunks build into a running, hardened, observable, recoverable service **on servers in Nepal** (00 header "Data residency"; 04 S1). It delivers, as code under `infra/`:

1. Host configuration for plain Linux VMs (provider-agnostic, B12).
2. The self-hosted Supabase stack in hardened form (04 S6, REQ-SEC-037).
3. The nginx public edge with TLS, HSTS, rate limits, security headers and fail2ban (04 S7, I5, I6, §4).
4. PgBouncer as the only pooler (04 S8); supervised Graphile Worker processes (04 S10); isolated runtime envelopes for C6's Chromium renderer and C6's pdf-sandbox images (04 S14, S15, R7; the sandbox image and its HTTP interface are C6's — 08 A25 D-204); an ephemeral rate-limit cache (04 S11); a malware-scanner service (REQ-SEC-084).
5. Backups with WAL archiving to a second Nepal site, RPO ≤ 15 min, encrypted, keys separate (04 I2); monthly restore drills (04 I3); object-storage replication (04 I4).
6. Monitoring, metrics, logs, alerting, an append-only audit-log store (04 D11), all self-hosted in Nepal (04 §11).
7. Secrets management, CI/CD deploy pipelines, three environments.
8. Runbooks: DR, incident response tied to the Privacy Act (04 L17), patching (04 I9), DDoS posture without a foreign CDN (04 I7).
9. Infra tests that prove ports are closed, TLS is correct and headers are present.

C1 writes **no business logic, no tables in the application database, no endpoints**. It consumes the other chunks' deployables, metrics and alert proposals.

## 2. Users and roles

C1's users are operators, not lab staff. There are no C1 API endpoints, so no `x-permission` codes are introduced. Application-level platform roles that touch C1's outputs come from IC §11:

| User | Identity | What they do with C1 | Access path |
|---|---|---|---|
| Ops engineer (the LIMS provider) | Linux account on VMs + WireGuard peer key + Grafana `ops_admin` [CONV role name] | provisions VMs, runs Ansible, deploys, patches, restores, rotates secrets | WireGuard VPN → SSH (key-only) |
| On-call engineer (the LIMS provider) | as above, Grafana `ops_oncall` [CONV] | receives alerts, follows runbooks, escalates | WireGuard → Grafana/Alertmanager UI; alert e-mail |
| Founder (the LIMS provider) | approver | approves prod releases, foreign touchpoints (B11), break-glass use | release approval in CI; runbook sign-off |
| Platform superadmin | `platform_superadmin` (IC §11) | replays/discards dead letters (`platform.dead_letter.manage`) — the screen is C2's; C1 only alerts on dead letters | staff web (C2 console) |
| Platform support | `platform_support` (IC §11) | tenant support sessions (C2); reads C1 status board for incident comms | staff web; status page |
| Chunk agents C0–C18 | developers | deliver images, metrics, alert proposals; read runbooks | Git PR to their own paths; CR to C1 for infra needs |
| Tenant admin (lab) | `tenant_admin` (IC §11) | receives maintenance/incident notices (REQ-SEC-142) | e-mail via relay; status page |
| IRD (tax authority) | external | "IRD notified and given access" to the Nepal server (04 L4) — form of access **BLOCKED B6** | defined when B6 answers |

Grafana/infra roles are DECISION names, not application permissions: `ops_admin` (all), `ops_oncall` (view + silence alerts), `ops_readonly` (view dashboards, no log access containing IPs).

## 3. Problems this chunk solves

| # | Problem | Evidence |
|---|---|---|
| P1 | The stock Supabase compose publishes gateway :8000 and Supavisor :5432/:6543 on all interfaces; Studio is protected only by basic auth over HTTP | 04 S6; research 05 Target 6; REQ-SEC-037 |
| P2 | Stock compose ships placeholder secrets (`.env.example` says "YOU MUST CHANGE ALL THE DEFAULT VALUES") | REQ-SEC-037; upstream `docker/.env.example` (fetched 2026-11-06) |
| P3 | No foreign CDN/WAF is allowed, so the edge must defend itself | 04 I7, REQ-SEC-135, REQ-ARCH-088 |
| P4 | Self-hosting means DB *and* Storage objects must be backed up separately, encrypted, off-site, tested | research 03 §2.2; 04 I2–I4; REQ-SEC-126/127 |
| P5 | Audit logs must be shipped to a separate, append-only store ≥ 5 years | 04 D11; REQ-SEC-097 |
| P6 | Every chunk emits metrics and proposes alerts, but nobody runs the stack | CV §9.4; 05-DoD §3.7 |
| P7 | Untrusted PDFs and an HTML renderer are SSRF/RCE surfaces (C6 builds both; C1 confines them) | REQ-SEC-086/087; 04 S14, R7 |
| P8 | Self-hosted components must be patched by us | REQ-SEC-138; 04 I9 |
| P9 | Privacy Act exposure means incidents need fast, documented fact-finding | 04 L17 (s.30 three-month complaint window); REQ-SEC-134 |

## 4. Scope

### 4.1 In scope (mapped to client baseline and 04)

| ID | Item | Client baseline (00) | 04 / REQ |
|---|---|---|---|
| IS-01 | Provider-agnostic VM configuration as code (Ansible), provider bits in `infra/providers/<name>/` | 00 header (Nepal residency); §3 item 1 ("online cloud or server based") | 04 S1, I1, B12 |
| IS-02 | Self-hosted Supabase compose hardening: port rebinding, firewall, Studio/pg-meta never public, every default secret replaced, unused services off | §3 item 1 | 04 S2, S6; REQ-SEC-037; REQ-ARCH-011/012/017 |
| IS-03 | Envoy gateway internal-only; nginx allowlist of Supabase paths actually needed | — | 04 S6 |
| IS-04 | nginx edge: TLS (04 I5), HSTS (04 I6), `limit_req` per 04 §4 and 08 decisions, security headers, token-path log exclusion, fail2ban; public routes of C6 (provider callbacks), C7 (bridge agent) and C15 (payment pages) | §3 item 1; A11/D2/D6 delivery links rely on it | 04 S7, I5, I6, §4; REQ-SEC-078/090/124/132; CR-C6-013, CR-C7-012, CR-C15-008 |
| IS-05 | PgBouncer via official override, Supavisor removed; DB parameters | — | 04 S8, S9; REQ-ARCH-015 |
| IS-06 | Graphile Worker process supervision | A11 (SMS), D2/D3 (delivery) run as jobs | 04 S10; REQ-ARCH-037/039/042 |
| IS-07 | Chromium renderer runtime isolation + egress block | D (reports) | 04 S14; REQ-SEC-086; REQ-ARCH-043 |
| IS-08 | pdf-sandbox runtime envelope (image + HTTP interface owned by C6, 08 A25 D-204) | D5 (outsourced reports) | 04 S15, R7; REQ-SEC-087 |
| IS-09 | Malware-scanner service (ClamAV) for TRF/outsourced PDF/xlsx uploads | A7, D5, E4 | REQ-SEC-084; CR-C4-005, CR-C3-005 |
| IS-10 | Ephemeral rate-limit cache (Valkey) | — | 04 S11; REQ-SEC-078/079 |
| IS-11 | pgBackRest backups: WAL to second Nepal site, RPO ≤ 15 min, encrypted, keys separate | G5 IRD (Procedure 2074 cl.6(ग) backup/recovery — 04 L26) | 04 I2; REQ-SEC-126/127; REQ-ARCH-005/006 |
| IS-12 | Monthly automated restore drill with timed RTO | G5 | 04 I3; REQ-ARCH-007 |
| IS-13 | Object-storage replication to DR, growable storage volume | D (report PDFs) | 04 I1, I4; REQ-ARCH-003/008 |
| IS-14 | Retention configuration for infra stores | — | 04 I8; B15 |
| IS-15 | Patching cadence and procedure | — | 04 I9; REQ-SEC-129/138 |
| IS-16 | Monitoring/metrics/alerting stack (Prometheus, Alertmanager, Grafana) in Nepal | F (owner dashboard depends on uptime) | CV §9.4; REQ-SEC-133; REQ-ARCH-009 |
| IS-17 | Log shipping (Fluent Bit → VictoriaLogs) + separate audit store (`audit_log`, `access_log`, `billing.activity_log`) | E1 (audit for staff), G5 | 04 D11; REQ-SEC-096/097/098 |
| IS-18 | Secrets management (SOPS + age), no secrets in repo | — | REQ-SEC-128/037 |
| IS-19 | CI/CD deploy pipelines; environments dev/staging/prod | — | REQ-SEC-136; REQ-ARCH-081 |
| IS-20 | DR runbook (site loss, DB loss, Storage loss) | G5 | REQ-SEC-127; REQ-ARCH-005 |
| IS-21 | Incident-response runbook tied to Privacy Act 2075 | 00 §7.5 confidentiality | 04 L17; REQ-SEC-134 |
| IS-22 | DDoS posture without foreign CDN | 00 header | 04 I7; REQ-SEC-135 |
| IS-23 | Infra tests: closed ports, TLS, headers, secrets-not-default, renderer egress, per-network egress, Redis persistence off, memory budget | — | 04 S6 ("an infra test asserts these ports are closed externally") |
| IS-24 | Agent-health metrics ingestion contract + alert rules (X6); C7 release pipeline, signing secrets and release mount (CR-C7-012) | C1 (results from machines) | IC §3.16, X6; REQ-SEC-123; REQ-ARCH-061; 04 N11 |
| IS-25 | Identity infra rules (CR-C2-012) | E1 | C2 02-TRD §15 |
| IS-26 | Deploy-time DB flow execution (bootstrap, migrations, registry sync) | — | C0 03-APP-FLOW §1.4 |
| IS-27 | Host baseline: LUKS volumes, NTP, SSH via VPN only, container hardening | — | REQ-SEC-125/130/132/137 |
| IS-28 | Operator experience: dashboards, alert routing, on-call, runbooks, status page | wishlist 9 (training) | REQ-SEC-142; 05-DoD §3.7 |

### 4.2 Out of scope

| Item | Owner / reason |
|---|---|
| Application DDL, RLS, roles inside the app DB | C0 (`db/`); C1 requests ops roles by CR-C1-002 |
| Local developer stack (`pnpm dev:up`, `tools/devstack/`) | C0 |
| GitHub workflow files under `.github/` | C0 (C1 provides scripts under `infra/ci/`; hooks by CR-C1-001) |
| Dockerfiles of `services/api`, `services/worker`, `apps/web` | C0; `services/renderer` and `apps/portal` Dockerfiles: C6 |
| Renderer code, render API, Chromium launch flags | C6 (C1 provides the container runtime envelope) |
| Calling the scanner / sandbox from module code | C0 core (`ctx.uploads`, CR-C4-005), C6 (sandbox client) |
| pdf-sandbox image, HTTP interface and its qpdf behaviour | C6 (`services/renderer`; 08 A25 D-204) |
| Dead-letter replay UI | C2 (`platform.dead_letter.manage`) |
| Tenant-level retention settings UI | C2 |
| Payment/SMS/WhatsApp provider integration | C6, C15 |
| Foreign CDN, foreign error tracking, foreign paging SaaS | forbidden by 04 §11 (B11) |
| Kubernetes / multi-node orchestration | DECISION: not needed at 04 §14 volumes (≤ 500 req/s burst at N = 10) |

## 5. User stories and acceptance criteria

Every criterion is an automated test unless marked *(manual, recorded)*. Test locations are in `06-IMPLEMENTATION-PLAN.md`.

**US-01 Closed ports (04 S6; REQ-SEC-132).** As an ops engineer I need every non-edge port closed from outside so that Postgres, the gateway and Studio cannot be reached from the internet.
- AC-01.1 Given a deployed environment, When the external probe (`infra/tests/external/ports.py`) scans the public IPv4 of every VM for TCP 1–65535 and UDP 51820, Then only `app-1:80/tcp` and `app-1:443/tcp` accept connections (WireGuard 51820/udp never answers unauthenticated packets, so it must read open|filtered, and its nftables rule must restrict sources to the peer list), and the test fails if any other TCP port accepts a connection.
- AC-01.2 Given the same, When TCP 5432, 6432, 6543, 8000, 8443, 3000, 8080, 9999, 4000, 5433, 9090, 9093, 3100, 9428, 9464, 6379, 3310, 22 are probed from outside, Then each is closed/filtered.
- AC-01.3 Given `docker compose config` of every host, When `infra/tests/internal/published_ports.py` parses it, Then every published port has an explicit host IP of `127.0.0.1` or the host's WireGuard IP, except nginx 80/443 on the public IP.
- AC-01.4 Given a VM, When `nft list ruleset` is read, Then the input policy is drop and the `DOCKER-USER` chain drops traffic to container networks from the public interface except to nginx.

**US-02 TLS (04 I5; REQ-SEC-124).** 
- AC-02.1 Given each public origin, When `testssl.sh` runs, Then only TLS 1.2 and 1.3 are offered, the TLS 1.2 suites are exactly the six ECDHE GCM/ChaCha20 suites of 04 I5 (TLSRef intermediate), TLS 1.3 suites are `TLS_AES_128_GCM_SHA256`, `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`.
- AC-02.2 Given the leaf certificate, Then it is ECDSA P-256 and its validity is ≤ 90 days (04 I5).
- AC-02.3 Given a certificate with < 21 days left, Then alert `TLSCertExpiringSoon` fires; < 7 days → `TLSCertExpiryCritical` [CONV thresholds].
- AC-02.4 Given plain HTTP on :80, When any path other than `/.well-known/acme-challenge/` is requested, Then a 301 to HTTPS is returned.

**US-03 Security headers (04 I6; REQ-SEC-090/085).**
- AC-03.1 Given any HTTPS response from the staff_web, portal, partner and api origins, Then `Strict-Transport-Security: max-age=63072000; includeSubDomains` is present (no `preload` — 04 I6), plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` as in 02-TRD §6.4.
- AC-03.2 Given the deployed edge, Then no files origin exists: no `LIMS_ORIGIN_FILES` host name is configured, no nginx server proxies to `api-gw`/Storage, and `/storage/v1/…` on every public host returns 404 from nginx (08 A14.2 / A13 P-2; file download headers are the API's — C0 `ctx.download.stream`).
- AC-03.3 Given an nginx response, Then no `Server` version string is present (`server_tokens off`).

**US-04 Edge rate limits (04 §4).**
- AC-04.1 Given 60 POSTs from one IP to the public staff_web login route `/auth/login` (shared lab NAT) evenly spaced over 60 s, Then none is rejected at the edge; given 41 POSTs sent at once from one IP, Then 21 are accepted (1 + burst 20) and 20 return 429 with `Retry-After: 60` and body code `common.rate_limited` (08 Addendum A1 flood guard); given 100 `GET /auth/login` page loads at once, Then none is rejected by the login zone (only POSTs are counted). The per-IP **failure** throttle is C2's (C2 07-SECURITY).
- AC-04.1a Given a request to `/v1/identity/auth/login` (BFF-only API path) from the public origins, Then the edge returns 404 (internal only); no per-IP login zone is configured on BFF-only API routes (08 R6 placement rule).
- AC-04.2 Given 11 GETs sent at once from one IP to `/v/{token}` on the portal origin, Then the 11th returns 429 (10 r/m, burst 9); given 11 `POST /v1/reporting/verifications` from the portal server, Then nginx applies no QR zone to them (08 A13 D-32; the API keys `qr_verify` on `app.client_ip`).
- AC-04.3 Given requests from one IP to `/v1/instruments/agent/` (08 A13 D-43 flood guard, 600 r/m, burst 200): 600 requests evenly spaced over 60 s → none rejected; 401 requests sent at once → 201 accepted (1 + burst 200) and 200 return 429 with `Retry-After: 60`. No edge zone is keyed by a device token; the per-device 60/min limit is the app tier `ingest` (C7/C0, 04 §4).
- AC-04.3a Given a `POST /v1/instruments/agent/message-batches` body of 4 MiB + 1 byte, Then nginx returns 413; a 4 MiB body passes the edge; given a `POST /v1/instruments/agent/attachments` body of 16 MiB + 1 byte, Then 413, and 15 MB + metadata passes (CR-C7-012).
- AC-04.4 Given an IP that triggers ≥ 20 nginx `limit_req` rejections in 10 min **outside the `login`, `agent`, `otp` and `psession` zones**, Then fail2ban (`lims-ratelimit`) bans it for 1 h [CONV] and logs the ban. App-generated 429s (e.g. C2's per-IP failure throttle) are not counted (08 Addendum A3.2); nor are `agent`-, `otp`- and `psession`-zone rejections — those zones carry shared-NAT traffic (bridge agents behind a lab NAT, patient phones behind carrier-grade NAT) that the app tiers handle (08 A27.2).
- AC-04.4a (08 A27.2) Given 300 `agent`-zone rejections (e.g. 501 requests at once to `/v1/instruments/agent/`, then more bursts) from one IP within 10 min, or 100 `otp`-zone or `psession`-zone rejections, Then no fail2ban jail bans that IP.
- Test profile for US-04 (08 A27.2): the burst ACs AC-04.2, AC-04.8 and AC-04.9 each produce up to 20 jail-countable rejections from one IP, so `tests/external/ratelimit.py` sends each from a distinct source IP, or runs them with `lims-ratelimit` disabled in the test profile; AC-04.4 and AC-04.4a run with the jail enabled.
- AC-04.5 Given an IP that triggers ≥ 300 nginx `limit_req` rejections in the `login` zone within 10 min, Then fail2ban (`lims-auth`) bans it for 15 min [CONV], logs the ban and alert `LimsAuthJailBan` fires to the LIMS provider on-call; given 299 such rejections, Then no ban. Login 401 responses are never counted by any jail (08 Addendum A3.2).
- AC-04.6 Given 60 failed staff logins per minute from one client IP for 10 minutes (600 login POSTs to a `zone=login` route, evenly spaced at one per second, every one a wrong password — including those answered with an app-generated 429 once C2's per-IP failure throttle engages), Then no fail2ban jail bans that IP: the identity throttle handles them (C2 07-SECURITY AU-T2b), and the 60 req/min flood guard rejects none of them (08 Addendum A3.2).
- AC-04.7 Given 30 requests within 5 min from one IP to unknown paths under `/v1/instruments/agent/` (all answered 404 by the edge or the API), Then no fail2ban jail bans that IP — no jail counts 404s (08 A25 D-211); if such 404s stay above 30 per 5 min from one IP for 15 min, Then warn alert `EdgeNotFoundSpike` fires and still no ban follows.
- AC-04.8 (CR-C15-008) Given the api origin, When `POST` is sent to `/v1/payments/result`, `/v1/payments/launch/<x>` or `/v1/payments/callbacks/<x>`, Then 405; When a `GET` carries a body (`Content-Length` > 0 or `Transfer-Encoding`), Then 413; given 41 GETs at once from one IP to these routes, Then 21 pass (10 r/s, burst 20) and the rest return 429; every response carries `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and HSTS; the access log shows `/v1/payments/launch/:token` / `/v1/payments/callbacks/…/:token…` and no query string.
- AC-04.9 (CR-C6-013) Given 41 `POST /v1/reporting/provider-callbacks/<token>` at once from one IP, Then 21 pass (60 r/m, burst 20) and the rest return 429; the access log line shows `/v1/reporting/provider-callbacks/{token}`.
- AC-04.10 (08 A19 D-122) Given 41 requests at once from one IP to `/v1/engagement/auth/otp-challenges*`, Then 21 pass (60 r/m, burst 20); the binding OTP limits stay in the app.

**US-05 Default secrets replaced (REQ-SEC-037).**
- AC-05.1 Given a rendered environment, When `infra/tests/internal/secrets_not_default.py` compares every variable listed in 02-TRD §8.2 against the pinned upstream `.env.example`, Then no value is equal and every length rule of `.env.example` is satisfied.
- AC-05.2 Given the repository, When gitleaks runs over `infra/`, Then zero findings; and no file under `infra/` contains a decrypted secret (SOPS metadata check).
- AC-05.3 Given GoTrue env, Then `GOTRUE_DISABLE_SIGNUP=true`, `GOTRUE_EXTERNAL_PHONE_ENABLED=false`, `GOTRUE_SMS_AUTOCONFIRM=false`, `GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false`, `GOTRUE_MAILER_AUTOCONFIRM=false`; and Studio's `OPENAI_API_KEY` is unset (foreign touchpoint, 04 §11).

**US-06 Studio and pg-meta never public (04 S6).**
- AC-06.1 Given the api origin, When any path that is not in `public-routes.yaml` is requested (incl. `/`, `/pg/`, `/api/mcp`, `/mcp`, `/rest/v1/`, `/graphql/v1`, `/functions/v1/`, `/auth/v1/`, `/storage/v1/`), Then 404 from nginx; given the staff_web, portal and partner origins, When `/v1/`, `/rest/v1/`, `/graphql/v1`, `/functions/v1/`, `/auth/v1/`, `/storage/v1/`, `/realtime/v1/`, `/pg/`, `/api/mcp`, `/mcp` are requested, Then 404 from nginx via the explicit `location` denies of 02-TRD §6.3 (never proxied), while `/` and the app's own paths are served.
- AC-06.2 Given the Envoy gateway in normal operation, Then it has no published port on app-1 and is reachable only from `app_net`/`auth_net`; only during Studio break-glass is `127.0.0.1:8000` published (02-TRD §7.10).
- AC-06.3 Given production, Then the `studio` and `meta` containers are not running unless the break-glass flag `studio_enabled` is true; turning it on raises alert `StudioEnabled` (info) every hour.

**US-07 Single pooler (04 S8).**
- AC-07.1 Given the data host, Then the `supavisor` container does not exist and `pgbouncer` (image from the official override; PgBouncer ≥ 1.21) runs in `pool_mode = transaction`.
- AC-07.2 Given the API container, Then `LIMS_CORE_DATABASE_URL` points to PgBouncer and `LIMS_CORE_WORKER_DATABASE_URL` (worker) points directly to Postgres :5432 (04 S8); PgBouncer, `pg_hba`, the audit subscription and the bootstrap all use the configured `app_db_name`.
- AC-07.3 Given two API requests on the same PgBouncer server connection with different tenants, Then C0's PgBouncer-context-isolation test (AC-0D-2.3) passes on staging.

**US-08 Worker supervision (04 S10).**
- AC-08.1 Given a worker container killed with SIGKILL, Then Docker restarts it within 10 s and `up{job="worker"}` returns to 1 within 60 s.
- AC-08.2 Given a deploy, When workers receive SIGTERM, Then in-flight jobs finish within `stop_grace_period` (60 s [CONV]) before exit (verified by a long synthetic job in staging).
- AC-08.3 Given `lims_queue_depth` > 500 [CONV] for 10 min, Then alert `QueueBacklog` fires.

**US-09 Renderer isolation (04 S14; REQ-SEC-086).**
- AC-09.1 Given the renderer container, When it attempts TCP to any internet address, to `169.254.169.254`, to the DB host, or to any container other than its callers, Then the connection fails (test runs `infra/tests/internal/renderer_egress.sh` inside the container network namespace).
- AC-09.3 (08 A25 D-203) Given `egress_probe.sh` run in the network namespaces of api-a, worker-a, auth, rest, storage, web and portal, Then: from `db_net` members, TCP to the data-1 wg IP on 5432/6432 succeeds and TCP to any other address (internet, ops-1, `169.254.169.254`, data-1 other ports) fails; from `auth`, TCP to the SMTP relay on 587 succeeds and to the relay on any other port, or to any other host on 587, fails; from web/portal (edge_net), any TCP to the internet fails; from api/worker, an HTTPS request through `http://squid:3128` to an allowlisted FQDN succeeds and to a non-listed FQDN returns 403.
- AC-09.2 Given the renderer, Then memory limit ≤ 1.5 GiB, `read_only: true`, `cap_drop: [ALL]`, non-root UID, `pids_limit` set (`docker inspect` assertion).

**US-10 pdf-sandbox runtime envelope (04 S15, R7; REQ-SEC-087; image and interface: C6).**
- AC-10.1 (08 A25 D-204) Given C6's `pdf-sandbox` container, Then (`docker inspect` + `sandbox_envelope.sh`): it is attached to `render_net` only; a new TCP connection to it from api-a or renderer fails while one from worker-a/b succeeds; any outbound TCP from it fails; it runs as a non-root UID with `read_only: true`, `tmpfs /work`, `cap_drop: [ALL]`, memory ≤ 512 MiB, 1 CPU, `pids_limit` 64; exactly one secret is mounted (its inbound auth token); its health check calls C6 `GET /internal/health`. (Timeout and malformed-PDF behaviour are C6's tests.)

**US-11 Redis ephemeral (04 S11).**
- AC-11.1 Given the Valkey container, Then `CONFIG GET save` returns empty, `appendonly` is `no`, no volume is mounted, and it listens only on the internal network.
- AC-11.2 Given the backup inventory (02-TRD §9), Then Valkey is not listed.
- AC-11.3 Given api-a/b and worker-a/b in staging/prod, Then `LIMS_CORE_RATELIMIT_BACKEND=redis` and `LIMS_CORE_REDIS_URL` names user `lims_api` on `valkey:6379`; given Valkey stopped, Then `ValkeyDown` (page) fires within 2 min.

**US-12 Backups and RPO (04 I2).**
- AC-12.1 Given production, Then PostgreSQL `archive_mode = on`, `archive_timeout = 60s` (08 A25 D-205), `archive_command` = pgBackRest `archive-push` to repo1 (local disk) and repo2 (DR site); repo2 is in a different Nepal site.
- AC-12.2 (08 A25 D-205) Given normal operation with write activity, Then metric `lims_ops_wal_repo2_newest_age_seconds` (now − time of the newest WAL segment in repo2, from `pgbackrest info`/`repo-ls`) stays < 300 s; > 600 s → `WalArchiveLagging` (warn); > 840 s → `RpoAtRisk` (page); 2 failed `check` runs in a row → `WalArchiveFailing` (page); on an idle database (no unarchived WAL) neither age alert fires.
- AC-12.3 Given both repos, Then `repo1-cipher-type` and `repo2-cipher-type` are `aes-256-cbc` and the passphrases differ; repo2's host (dr-1) never holds any cipher pass; repo1's pass exists only on tmpfs on data-1 (never on a data-1 disk).
- AC-12.4 Given a nightly schedule, Then a backup (full weekly, incremental otherwise [CONV]) completes and `lims_ops_backup_last_success_timestamp_seconds{repo}` is < 26 h old, else `BackupMissed`.

**US-13 Restore drill (04 I3).**
- AC-13.1 Given the monthly drill job, When it restores repo2 to a scratch instance at a point-in-time 30 min before start, Then the instance starts, `infra/drill/verify.sql` checks pass, and the result (duration = measured RTO, target time, verified LSN) is recorded in `lims_ops_restore_drill_last_success_timestamp_seconds` and the drill log.
- AC-13.2 Given no successful drill for 35 days, Then `RestoreDrillOverdue` fires (04 I3 "last drill < 35 days").
- AC-13.3 Given staging, Then a drill passes before a wave is declared production-ready (05-DoD §5.3).

**US-14 Object storage (04 I1, I4).**
- AC-14.1 Given Storage's file backend, Then its directory is on a dedicated LVM logical volume that can be grown online, separate from the root and DB volumes.
- AC-14.2 Given a new object written on app-1, Then it exists on dr-1 within 30 min [CONV] (`lims_ops_object_replica_lag_seconds` < 1800), and a deletion on app-1 does not delete the DR copy.
- AC-14.3 Given the monthly drill, Then a 200-object random sample has identical SHA-256 on both sides.

**US-15 Retention (04 I8; B15).** 
- AC-15.1 Given infra configuration, Then every store in 05-SCHEMA §2 has a retention value from config, and audit-store retention is never below 5 years (config validation fails otherwise).

**US-16 Patching (04 I9).**
- AC-16.1 Given the monthly window, Then `patch.yml` applies OS + image updates to staging, waits 24 h soak [CONV], then prod; `lims_ops_last_patch_timestamp_seconds` per host < 35 days, else `PatchOverdue`.
- AC-16.2 Given a CVE marked critical in the triage file, Then the fix is in prod ≤ 72 h *(manual, recorded in `infra/runbooks/patching.md` log)*.

**US-17 Monitoring and alerting (CV §9.4; REQ-SEC-133; 05-DoD §3.7).**
- AC-17.1 Given each service, Then Prometheus scrapes it and `up == 1`; a missing target for 2 min → `TargetDown`.
- AC-17.2 Given every alert proposed in the C0 and C2–C18 TRDs as they land (rule files under chunk paths and TRD lists — 02-TRD §11.3 intake, 08 A13 P-14), Then a rule exists in `infra/monitoring/rules/` (imported or transcribed) with a runbook link and the owner's threshold, `promtool test rules` covers each, and CI fails when an imported file drifts from its source.
- AC-17.3 Given a firing page-level alert, Then the on-call e-mail is sent via the relay within 2 min and contains no PHI (rule template lint).

**US-18 Logs and audit store (04 D11).**
- AC-18.1 Given app JSON logs, Then they reach VictoriaLogs within 60 s and are retained 90 days [CONV].
- AC-18.2 Given an insert into `audit.audit_log`, `audit.access_log` or `billing.activity_log` on the primary, Then the row is in the audit store on dr-1 within 60 s (`lims_ops_auditstore_lag_seconds`).
- AC-18.3 Given the audit store, Then the writer role has INSERT only and no role used by people has UPDATE/DELETE/TRUNCATE (role assertion test).
- AC-18.4 Given nginx access logs, Then requests to `/r/…`, `/v/…`, `/auth/confirm`, `/v1/reporting/provider-callbacks/…` and `/v1/payments/{launch,callbacks}/…` log only the route template (`/r/{token}`, `/v1/reporting/provider-callbacks/{token}`, `/v1/payments/launch/:token`) and no request carries its query string into any log line (IC §7; CR-C2-012, CR-C6-013, CR-C15-008).

**US-19 Secrets (REQ-SEC-128).**
- AC-19.1 Given a host, Then secrets exist only as files under `/run/lims/secrets/` (tmpfs, mode 0400, owner = consuming UID) and are passed as `*_FILE` or Docker secrets — never in `docker inspect` env output for keys listed in 02-TRD §8, except the ids marked `exposure: env` in the secrets schema (upstream Supabase values and `LIMS_CORE_REDIS_URL` until C0 adds its `_FILE` form — 02-TRD §8.3).
- AC-19.3 Given the secrets schema, Then it lists `bff_key_staff_web`, `bff_key_partner`, `bff_key_portal`, `valkey_lims_api_password`, `reporting_otp_hmac_key`, `renderer_inbound_token`, `pdf_sandbox_inbound_token`, `instruments_config_signing_key`, `instruments_release_signing_key`, `instruments_authenticode_cert`, `payments_kek`, `tenant_ops_contacts`, `alert_contacts`; each BFF key file is mounted only into api-a/b and its own BFF; `instruments_release_signing_key` and `instruments_authenticode_cert` exist on no product host (render-target assertion); `payments_kek` is mounted read-only into api-a/b and worker-a/b only.
- AC-19.2 Given a rotation run for `lims_api` DB password, Then the API reconnects with the new password with zero failed requests over 5 min of synthetic load.

**US-20 CI/CD.**
- AC-20.1 Given a merge to `main`, Then images are built on the Nepal runner, scanned (trivy, no critical unfixed without triage entry), pushed by digest to the Nepal registry and deployed to dev automatically.
- AC-20.2 Given a release tag, Then staging deploy runs migrations, registry-sync and smoke; prod deploy requires founder approval and takes a pre-deploy incremental backup.
- AC-20.3 Given a failed post-deploy smoke in prod, Then the pipeline redeploys the previous image digests automatically (migrations are forward-only and additive — CV §5.12).

**US-21 Environments (REQ-SEC-136).**
- AC-21.1 Given dev, staging, prod, Then each has distinct VMs, DBs, buckets, secrets (no shared value — test compares secret hashes across envs), and non-prod has no real provider credentials.
- AC-21.2 Given non-prod, Then the GoTrue SMTP points to the local mail sink and seeds are synthetic (CV §11.2).

**US-22 DR (REQ-SEC-127).**
- AC-22.1 Given loss of the primary data VM, When the on-call runs `dr-promote.yml`, Then the dr-1 standby is promoted and the app reconnects; measured RTO ≤ 1 h [CONV target] in the semi-annual game day *(manual, recorded)*. **Degraded mode after promotion (08 A25 D-210):** the primary, repo2 and the audit store are then all at site B (dr-1), so the RPO holds against the loss of one host (once the interim repo exists) but **not** against the loss of site B, and the audit store is no longer on a separate host from the primary; the incident record names this period until switch-back.
- AC-22.3 Given a promotion, Then within 4 h [CONV, D-210] `dr-promote.yml` has created a pgBackRest repo on ops-1 (different host, same site — interim only) and `check` passes against it; `NoOffsiteArchive` (page) fires from promotion until a repo on a site other than dr-1's site is configured.
- AC-22.2 Given loss of the whole primary site, Then `dr-site-failover` runbook brings up app services at site B from the registry mirror within RTO ≤ 4 h [CONV target] *(game day, recorded)*.

**US-23 Incident response (04 L17; REQ-SEC-134).**
- AC-23.1 Given a suspected PHI disclosure, When the runbook is followed, Then evidence is frozen (audit-store snapshot, log export with hash) within 4 h [CONV], and the tenant-notification decision is recorded with the Privacy Act sections from 04 L17 *(tabletop twice a year, recorded)*.

**US-24 DDoS posture (04 I7).**
- AC-24.1 Given the flood test in staging (10× the 04 §14 burst, 5,000 req/s for 60 s from the load generator), Then nginx sheds with 429/503, the API p95 for authenticated staff traffic stays < 2× baseline, and no host runs out of file descriptors.

**US-25 Agent health (IC §3.16, X6; REQ-SEC-123).**
- AC-25.1 Given C7's metric `lims_instruments_agent_state{agent_id,state}` reporting `offline` for an agent for 15 min, Then `BridgeAgentOffline` (warn) fires; after 60 min → `BridgeAgentOfflineLong` (page during lab hours 06:00–20:00 NPT [CONV]).
- AC-25.2 Given state `backlog` for 30 min or `degraded` for 30 min, Then the matching alert fires with labels `tenant_id`, `centre_id`, `agent_id` only (no PHI).

**US-26 Identity infra (CR-C2-012).**
- AC-26.1 Given the public edge, When `/v1/identity/auth/*` is requested on the api origin, Then 404 (only the BFF reaches it, over the internal network) — except `POST /v1/identity/auth/patient/session/resolve` and `…/logout` (C2 `resolvePatientSession` / `logoutPatientSession`, `x-edge-exposure: public`), which are exposed (zone `psession`) once C16 ships; the test reads the exemption list from `public-routes.yaml`.
- AC-26.2 Given the GoTrue container, Then it is attached only to `auth_net` (shared with the API and the gateway) and `db_net` (Postgres + the SMTP relay exception, 08 A25 D-203); no port is published; it is not reachable from `edge_net`/`render_net` (`auth_net.sh`).
- AC-26.3 Given GoTrue env, Then SMTP host is the transactional relay (prod) and mailer URL paths point to `{staff_web}/auth/confirm`; recovery/invite TTL ≤ 60 min (env names per C2 T1 mapping — UNVERIFIED until then).

**US-27 Deploy-time DB flow (C0 03-APP-FLOW §1.4).**
- AC-27.1 Given a first deploy, Then `db/bootstrap/*.sql` runs once as the provisioning superuser with passwords from the secret store, and a marker prevents re-running.
- AC-27.2 Given every deploy, Then migrations (as `lims_migrator`), `pnpm worker:registry-sync`, then seeds 001–003 (prod) run before API/worker start; any failure stops the pipeline.

**US-28 Malware scanner (REQ-SEC-084).**
- AC-28.1 Given the clamd service, When the EICAR test string is submitted with INSTREAM over `tcp://clamd:3310` from api-a, Then it reports `FOUND`; `clamd.conf` has `StreamMaxLength 20M` and `MaxFileSize 20M`; api-a/b and worker-a/b carry `LIMS_CORE_SCANNER_URL=tcp://clamd:3310` and `LIMS_CORE_SCANNER_TIMEOUT_MS=30000` (08 A25 D-209); clamd has no published port.
- AC-28.2 Given signatures older than 3 days [CONV], Then `ScannerSignaturesStale` fires.

**US-29 Host baseline (REQ-SEC-125/130/132/137).**
- AC-29.1 Given DB, Storage, backup, audit-store volumes, Then each is LUKS2-encrypted and the key is not on the same host's plaintext disk (unlock via Clevis/Tang-style network unlock is **not** assumed; DECISION: passphrase entered by ops at boot or keyfile from ops VM over WireGuard — 02-TRD §5.3).
- AC-29.2 Given each host, Then chrony is synchronised (offset < 100 ms [CONV]); > 500 ms → `ClockSkew`.
- AC-29.3 Given SSH, Then it listens only on the WireGuard address, password auth off, root login off.

**US-30 Host memory budget (08 A25 D-207).**
- AC-30.1 Given the rendered compose files of a host, When `container_hardening.py` sums `mem_limit` over every container that host runs (Supabase services, exporters and Fluent Bit included), Then the sum is ≤ 85 % of the host's RAM from inventory; app-1 is sized 8 vCPU / 32 GB by default (F-09 founder cost confirmation; 02-TRD §3.1 shows the budget and that the 16 GB fallback fails this test with the current limits).

**US-31 Bridge-agent release infrastructure (CR-C7-012).**
- AC-31.1 Given api-a/b, Then `LIMS_INSTRUMENTS_RELEASES_DIR` points to a read-only bind mount (`docker inspect` `RW=false`) and a write attempt from inside the container fails.
- AC-31.2 Given a release run of `infra/ci/agent-release.sh` in staging with a test certificate, Then the signed zip appears in the mount, the `instruments.g_agent_releases` seed row exists, and the release signing key and Authenticode certificate were read only on ops-1 (`ops_audit` lines; no copy on app-1).

**US-32 Trusted client IP (08 A25 P-61).**
- AC-32.1 Given api-a/b, Then `LIMS_CORE_TRUSTED_PROXY_CIDRS=172.30.10.10/32` (the nginx container on `edge_net`); a request to an api-origin public route through nginx with a forged `X-Forwarded-For` is logged by the API with the real client address (nginx overwrote the header), and a request from another container without a BFF key is attributed to its peer address.

## 6. Success metrics

| Metric | Target | Source |
|---|---|---|
| External port-scan findings in prod | 0 (monthly automated scan, REQ-SEC-132) | AC-01 |
| RPO (WAL age in DR repo) | ≤ 15 min, 99.9 % of minutes per month | 04 I2 |
| Restore drills | 12/year, each < 35 days apart | 04 I3 |
| Measured RTO (DB PITR restore drill) | recorded every month; target ≤ 1 h at 1× data [CONV] | REQ-ARCH-007 |
| Patch compliance | 100 % hosts patched ≤ 35 days; critical CVE ≤ 72 h | 04 I9 |
| Alert coverage | every TRD-proposed alert implemented with a runbook | 05-DoD §3.7 |
| Audit-store lag | p99 ≤ 60 s | 04 D11 |
| Monthly availability of staff_web + api (synthetic probe from site B) | ≥ 99.5 % [CONV, not an SLA — the SLA depends on B12] | REQ-SEC-135 (document downtime honestly) |

## 7. Phase

Phase 1 (Wave 1). Wave 2/3 additions (partner origin, Realtime for Flutter apps, C16/C17 public routes) are configuration additions behind flags in this same design; C15's payment routes are configured now and enabled in production when C15 reaches PG-T23 (CR-C15-008).

## 8. Dependencies (contracts only)

| Dependency | From | Contract | Default until delivered |
|---|---|---|---|
| Images for api, worker, web | C0 (Dockerfiles) | CV §1.1 (Node 26 LTS by digest); env keys C0 02-TRD §11 | build C0 Dockerfiles as-is |
| Renderer, pdf-sandbox and portal images | C6 (`services/renderer`, `apps/portal`) | runtime envelope in 02-TRD §7.4/§7.5 (CR-C1-005 envelope part, CR-C6-013, 08 A25 D-204) | placeholder container that returns 503 |
| Metrics on `LIMS_CORE_METRICS_PORT` (9464) | C0 | CV §9.4 metric names | — |
| Health endpoints `/v1/core/health/live`, `/ready` | C0 | C0 02-TRD §8 | — |
| Bootstrap SQL, migrations, registry-sync, seeds | C0 | C0 03-APP-FLOW §1.4 | — |
| Ops DB roles + audit publication | C0-0B | CR-C1-002 | backups/monitoring use the image superuser via local socket only; audit shipping disabled (alert `AuditShippingDisabled`) |
| Agent metrics | C7 | IC §3.16 + CR-C1-003 | alert rules written against the contract; no data until C7 ships |
| Alert proposals | every chunk | 02-TRD §11.4 intake | — |
| GoTrue env mapping | C2 T1 (`gotrue/mapping.md`) | CR-C2-012 | values per C2 TRD; env names UNVERIFIED |
| Upload pipeline calling clamd | C0-0D (CR-C4-005/CR-C3-005) | clamd INSTREAM on `tcp://clamd:3310`, keys `LIMS_CORE_SCANNER_URL` / `LIMS_CORE_SCANNER_TIMEOUT_MS` (02-TRD §7.4; 08 A25 D-209) | scanner runs, unused |
| Agent release artefacts, signing keys, rule file | C7 | CR-C7-012 (02-TRD §7.11) | no self-update until the first signed release |
| Payment public routes, KEK, gateway egress, alert list | C15 | CR-C15-008 (02-TRD §7.12) | routes configured, enabled in production at C15 PG-T23 |
| Supabase image digests for the dev stack | C0 reads C1 `UPSTREAM.lock` | 08 A25 D-208 | — |
| CI workflow hooks | C0-0A | CR-C1-001 | operators run `infra/ci/*.sh` manually on the runner |

## 9. Blocked items and defaults

| # | Blocked | Default built now |
|---|---|---|
| B12 | Nepal DC/VM provider, SLA, DR site | Plain Linux VM inventory with I1 sizes (ASSUMPTION); provider bits in `infra/providers/generic/` (manual checklist); a provider directory is added when chosen |
| B11 | Foreign touchpoints: ClamAV signature download, SMS paging, OS/package/registry upstreams (non-PHI supply chain) | CR-C1-006 / 07-BLOCKERS F-01. Default built now: e-mail-only paging via the pre-allowed relay; `freshclam` and package/image downloads only on ops-1 through the allowlisted Squid egress proxy (F-01 default), every destination in `egress-allowlist.yaml`; manual signature import only if F-01 is refused |
| F-09 | Confirm the 32 GB app VM cost (16 GB is not deployable as specified) — 08 A27.1 rewording of A25.1 / D-207 | 32 GB is **required** for the specified stack; the D-207 16 GB fallback is withdrawn (it sums to 19.25 GiB and fails its own 85 % test, 02-TRD §3.1) |
| F-10 | DR site storage may need 2 TB; confirmed by the T-09 measurement before go-live (08 A27.4: worst-case WAL ≈ 840 GiB over 35 days vs dr-1 1 TB) | dr-1 built at 1 TB (04 I1); T-09 measures the compressed archive; `DiskFillForecast` on dr-1 pages before it fills (02-TRD §9.4) |
| B15 | Legal retention periods | 5-year floor for audit store; per-store config (05-SCHEMA §2) |
| B6 | IRD "Department access" form; Annex 7 | No IRD access path built; runbook placeholder; per-tenant billing export tool from C0 (`export-tenant-billing.ts`) is runnable by ops |
| B17 | Billing "stored separately" | Per-tenant billing restore is part of the drill checklist (C0 tool) |
| I7 (UNVERIFIED) | Which Nepali ISP offers scrubbing | Local mitigation only; ISP contact field empty in runbook until B12 |
