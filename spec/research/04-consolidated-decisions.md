# 04 — Consolidated Decisions and Facts (single source of truth)

Status: authoritative as of 2026-11-05, after Verification Pass 1 (fact-check) and Pass 2 (consistency) over 01/02/03, and Pass 2b (primary-source corrections from 05-pass2-critical-recheck.md; see the verification log at the end).

**Precedence rules for chunk documents (PRD/TRD/App Flow/UI-API guide/Schema/Plan/Security):**
1. `00-scope-baseline.md` is the record of what the client said. This file never overrides it.
2. This file overrides 01/02/03 wherever they differ. If a chunk document needs a value that is not here, it must cite 01/02/03 by section or REQ ID. It may not invent the value.
3. Status labels: **VERIFIED** = primary or named source opened (see Source). **UNVERIFIED** = must not be presented as fact, and code must not hard-depend on it. **DECISION** = engineering choice made in this research set (may be revisited via change request). **BLOCKED** = cannot be finalised until the named party answers.
4. REQ IDs (REQ-SEC-###, REQ-ARCH-###) keep their numbers. Cite them, don't copy them.

---

## 1. Stack and platform

| # | Item | Value | Status | Source |
|---|---|---|---|---|
| S1 | Hosting | All PHI storage, processing and traffic on servers physically in Nepal; ≥2 VMs + a third Nepal location for replica/backups | Client constraint | 00-scope header, §7.1; REQ-ARCH-002/003/005 |
| S2 | Backend platform | Hybrid: self-hosted Supabase used for GoTrue (Auth), Storage, Realtime; **Fastify (Node.js) API is the only write path** for clinical/billing data; Supabase services kept removable | DECISION (D1) | 03 §2.5 |
| S3 | Client data access | API-only for writes and clinical reads. PostgREST, if used at all, exposes only curated `api`-schema views/RPC for low-risk reads; `db-max-rows` set | DECISION (D2) | 03 D2; REQ-SEC-032/033 |
| S4 | Staff web app | Next.js as a **server-only BFF**: no browser-side Supabase client holding a session; HttpOnly+Secure+SameSite=Lax cookies set by server code; live updates via SSE/polling through the server | DECISION (Pass 2) | REQ-SEC-068; 03 §2.5 |
| S5 | Realtime | Supabase Realtime only for the Flutter apps, private channels only, "Allow public access" off, `realtime.messages` policies per tenant | DECISION | REQ-SEC-036 |
| S6 | Supabase API gateway | Envoy (stack default; Kong optional), never publicly exposed; Studio/pg-meta never public. The stock compose publishes gateway :8000 and Supavisor :5432/:6543 on 0.0.0.0 → override to 127.0.0.1/private-interface bindings + host firewall; an infra test asserts these ports are closed externally | VERIFIED (default) / DECISION | 03 §2.1 (Supabase self-hosting docs); REQ-SEC-037; REQ-ARCH-011/017 |
| S7 | Public edge | **nginx** only (TLS termination, `limit_req`, headers); fail2ban | DECISION (Pass 2) | REQ-SEC-078/090/124; REQ-ARCH-017/088 |
| S8 | Pooler | PgBouncer transaction mode for the API (stock compose ships Supavisor 2.9.13 as default pooler; D3 keeps PgBouncer via the official docker-compose.pgbouncer.yml override, with Supavisor disabled so only one pooler runs; PgBouncer ≥1.21 for prepared statements in transaction mode); workers and migrations on direct connections | DECISION (D3) | REQ-ARCH-015 |
| S9 | Per-request DB context | Transaction-local only (`set_config(..., true)` / `SET LOCAL`); bare `SET` banned | VERIFIED semantics / DECISION | REQ-ARCH-016; PostgreSQL SET docs |
| S10 | Job queue | Graphile Worker (transactional enqueue = outbox, cron). BullMQ rejected | DECISION (D8) | REQ-ARCH-037/038 |
| S11 | Redis | Allowed **only** as an ephemeral rate-limit counter cache (persistence off, no PHI, outside backup scope). Fallback: Postgres UNLOGGED table. Not for queues | DECISION (Pass 2) | REQ-SEC-078/079; 03 §4.1 |
| S12 | Migrations | Forward-only plain SQL in top-level `db/` (contracts in top-level `contracts/`) per program/01-CHUNK-MAP §3 — supersedes the earlier `packages/db` wording; runner Atlas or sqitch; not coupled to supabase CLI | DECISION (D7) | REQ-ARCH-026 |
| S13 | Migration linter | `atlas migrate lint` is **Atlas Pro only since v0.38** (VERIFIED). Choice between paid Atlas Pro and a free linter (squawk-cli 2.70.0 on npm (15 Oct 2026; GitHub v2.71.0, 29 Oct 2026); rule coverage UNVERIFIED; atlasgo.io/features lists some lint rules as "Open" for the community build — test the free binary before deciding B10) | **BLOCKED — founder** | 03 §3.5 / D7; npm registry |
| S14 | PDF engine | HTML → Chromium via Playwright pool (1 browser, 2–4 contexts, recycle, memory cap, timeout), behind `render(templateId, data)`; Typst fallback; egress-restricted; bundled assets only; Noto Sans Devanagari | DECISION (D10) | REQ-ARCH-043/044/045; REQ-SEC-086 |
| S15 | PDF merge/stamp | qpdf (12.4.2) for merge/sanitize in a sandboxed worker; stamping via a maintained pdf-lib **fork**: `@cantoo/pdf-lib` 2.11.1 (15 Sep 2026) or `@pdfme/pdf-lib` 6.2.8 (21 Oct 2026). Upstream `pdf-lib` last released 1.17.1 (Nov 2021) — not to be used | VERIFIED (npm registry, 2026-11-05) / DECISION | REQ-ARCH-046; REQ-SEC-087 |
| S16 | Bridge agent | Go static binary, Windows service (`x/sys/windows/svc`), `go.bug.st/serial`. Target **Windows 10/11 or Server 2016+ only** (Go ≥1.21 requirement). Toolchain Go ≥1.26 (x/sys v0.49.0 go.mod `go 1.26.0`; go-serial v1.8.0 requires 1.25) — pin the toolchain in go.mod/CI consistently. Linux build deferred | VERIFIED (Go 1.21 notes) / DECISION (D12) | 03 §6.3; https://go.dev/doc/go1.21 |
| S17 | Phlebotomy offline | Custom drift (SQLite) + append-only idempotent mutations, server-wins; no PowerSync/Electric for v1 | DECISION (D14) | REQ-ARCH-066/067 |
| S18 | PowerSync licence | PowerSync Service relicensed FSL → Apache 2.0, noted "Licensing update November 3, 2026" on powersync.com; GitHub `powersync-service` LICENSE = Apache 2.0; PowerSync legal overview page still says FSL | VERIFIED (powersync.com + GitHub) | https://powersync.com/blog/new-open-era-for-powersync ; https://raw.githubusercontent.com/powersync-ja/powersync-service/main/LICENSE |
| S19 | Repo / contracts | Monorepo with owned paths + CODEOWNERS; hand-written OpenAPI 3.1 kept 3.0-compatible; openapi-typescript/openapi-fetch (TS), openapi-generator dart-dio (Dart); generated clients committed; Prism + MSW mocks; oasdiff breaking-change gate | DECISION (D15) | REQ-ARCH-071..081 |
| S20 | Email | Transactional relay (Brevo/Postmark/SES-type), link-only bodies, no PHI — the only pre-allowed foreign touchpoint pattern | DECISION within baseline | 00-scope §7.1; REQ-ARCH-018/086 |

## 2. Database and tenancy conventions

| # | Item | Value | Status | Source |
|---|---|---|---|---|
| D1 | Model | Single DB, shared schema, `tenant_id uuid NOT NULL` on every tenant table; no default; set via claim/trigger | DECISION (D4) | REQ-ARCH-019; REQ-SEC-027 |
| D2 | Policy predicate | `tenant_id = (SELECT app.current_tenant_id())`; helper reads tenant from `request.jwt.claims`; API sets `request.jwt.claims` via `set_config(...,true)` from the JWT it verified itself. **Never** from body/header/query. Collection-centre scoping as a second predicate via membership table | DECISION (Pass 2) | REQ-SEC-013/017/022; REQ-ARCH-019 |
| D3 | Self-hosted Storage/Realtime populate `request.jwt.claims` the same way | — | **UNVERIFIED** — prove with cross-tenant probe suite | REQ-SEC-040 |
| D4 | RLS coverage | ENABLE + FORCE RLS on every tenant table; explicit per-command policies; `TO lims_app` (group role of the API/worker logins, narrower than `authenticated` — REQ-SEC-015; `authenticated` only on Supabase-served objects; 03-IC X9); no `USING (true)`; views `security_invoker = true`; CI checks | VERIFIED (Postgres/Supabase docs) / DECISION | REQ-SEC-011..016, 031 |
| D5 | Roles | Tenant tables owned by a **NOLOGIN, non-BYPASSRLS owner role**. Migrator login role `SET ROLE`s to the owner. API and Graphile Worker use separate non-BYPASSRLS login roles. No request path uses `postgres` / `supabase_admin` / `service_role`. Supabase's `postgres` has BYPASSRLS (as do `service_role`, `supabase_admin`, `supabase_etl_admin`, `supabase_read_only_user`), so FORCE RLS alone is insufficient; CI asserts rolbypassrls = false for every app role | VERIFIED (BYPASSRLS fact) / DECISION | REQ-SEC-012/029/030/039/131 |
| D6 | Graphile Worker least-privilege operation (pre-installed schema, no DDL rights) | — | **UNVERIFIED** — test before chunk build | 03 §4.1 |
| D7 | SECURITY DEFINER | Only in unexposed schemas, `SET search_path = ''`, schema-qualified, inventoried; includes any `add_job` wrapper and audit trigger functions | DECISION | REQ-SEC-019..021 |
| D8 | Foreign keys | Composite `(tenant_id, id)` FKs; parents `UNIQUE (tenant_id, id)` | DECISION | REQ-SEC-026; REQ-ARCH-020 |
| D9 | IDs | UUIDv7 primary keys (app-generated: the self-hosted stack's default image is supabase/postgres:17.6.1.136, and Postgres 17 has no built-in uuidv7()). Generate UUIDv7 in application code (Node API and Dart offline clients, RFC 9562 layout, one shared helper per codebase); columns typed `uuid` with no DB default; a DB-side generator (extension such as `pg_uuidv7`, or a SQL function) only if a migration/trigger needs one — must be present in the pinned image. Revisit when the image moves to PG 18 (native `uuidv7()`); never sequential IDs in URLs/QR | VERIFIED (image version, 05 T6) / DECISION | REQ-ARCH-021; REQ-SEC-028 |
| D10 | Partitioning | None in v1; time columns ready on results/audit tables | DECISION (D5) | REQ-ARCH-022 |
| D11 | Audit | (a) JSONB old/new trigger audit → `audit_log` with tenant, centre, actor, IP, user agent, request id, time. (b) App-level `access_log` for view/print/download/export/consent/role events. Both append-only (no UPDATE/DELETE grants), shipped to a separate store, retained ≥5 years | DECISION (Pass 2) | REQ-ARCH-025; REQ-SEC-096/097 |
| D12 | Time | Store UTC timestamps; B.S. is display/reporting only, via one internal module per codebase with shared golden fixtures (TS ↔ Dart). Dual-calendar display setting (Metro Labs reports show A.D.) | DECISION | REQ-ARCH-028; 01 §4.8; 00-scope §4 |
| D13 | B.S. libraries | JS: `bikram-sambat` 1.8.1 (9 Jun 2026, Apache-2.0), `@remotemerge/nepali-date-converter` 1.2.7, `@sbmdkl/nepali-date-converter` 2.0.5. Dart: `nepali_date_picker` 8.0.0 (+`nepali_utils` 3.0.8). Supported ranges (source/README): bikram-sambat 1970–2090 B.S. (**insufficient: not the primary JS lib**); @remotemerge 1975–2099 B.S.; @sbmdkl 1978–2099 B.S. but A.D. ≤2040; nepali_utils 1969–2100 B.S. Proposed DECISION: JS = @remotemerge/nepali-date-converter (pin 1.2.7); Dart = nepali_utils 3.0.8 (via nepali_date_picker 8.0.0); common range 1975–2099 B.S.; one shared golden-test table (TS ↔ Dart, CI-enforced on both sides) covering 2000–2099 B.S.; far-future month lengths are projections, re-check yearly | VERIFIED (registries + source) | 03 §3.6; 01 §4.8 |
| D14 | Results data model | Reference ranges and units versioned, result rows snapshot the range used; ordinal/semi-quantitative results (e.g. urine nitrite 1+/2+) supported; AST interpretation is an **extensible coded set** (CLSI: S, SDD, I, I^ [urine-concentrating agents], R, NS; colistin/polymyxin B: I/R only. EUCAST: S, I = "susceptible, increased exposure", R. ECOFF-based WT/NWT. Store the category code + breakpoint standard (CLSI/EUCAST) + version with each interpretation), never a 3-value enum; AST stores raw value (zone mm / MIC) + interpretation as received; attachment-bearing tests (images/PDFs) | VERIFIED (CLSI primary blog 2021; M100 text not opened) / DECISION | 01 §2.3, §3.2, §3.5; REQ-ARCH-036 |
| D16 | IRD "separately stored" billing data | **BLOCKED/OPEN** (B17): IRD Procedure 2074 cl.7(ख) requires each taxpayer's data on a rented/multi-tenant server to be stored separately — shared-schema + RLS vs schema-per-tenant vs separate database for billing data needs IRD clarification. **Design rule until resolved:** billing/invoice tables must be isolatable per tenant — one tenant's billing data can be exported or moved (to its own schema/DB) without touching others' (tenant_id leading in every key/index, no cross-tenant sequences/counters, tested per-tenant export/restore) | BLOCKED — IRD / DECISION (design rule) | 05 T3; L4 |
| D15 | Storage layout | Private bucket `reports`; object path `{tenant_id}/{yyyy}/{mm}/{report_id}-v{n}.pdf`; `storage.objects` policies on first path segment; sha256 in DB; immutable versions | DECISION | 03 §5.3; REQ-SEC-034; REQ-ARCH-047 |

## 3. Authentication, sessions, tokens — numeric parameters

| # | Parameter | Value | Status | Source |
|---|---|---|---|---|
| A1 | Password hashing (where we hash) | Argon2id m=19456 KiB (19 MiB), t=2, p=1 minimum (equivalents m=47104/t=1, 12288/3, 9216/4, 7168/5, all p=1) | VERIFIED (OWASP cheat sheet) | REQ-SEC-060 |
| A2 | Supabase Auth hashing | bcrypt at a **fixed cost of 10** (Go bcrypt.DefaultCost; no config option; hashes with a higher cost are re-hashed to 10 on login); 72-byte input limit; compensating controls per REQ-SEC-060 (MFA per A4, breached-password list check per A3, login rate limits per §4) | VERIFIED (supabase/auth internal/crypto/password.go, internal/models/user.go) | REQ-SEC-060 |
| A3 | Staff password policy | ≥12 chars; breached-password check against a **locally stored list** by default (online HIBP API is a foreign touchpoint → founder approval) | DECISION (Pass 2) | REQ-SEC-061 |
| A4 | MFA | TOTP mandatory for tenant-admin, platform-admin, finance/refund, data-export roles; platform superadmin hardware key or TOTP | DECISION | REQ-SEC-062/063 |
| A5 | Access JWT lifetime | ≤1 h (Supabase default 1 h) | VERIFIED default / DECISION | REQ-SEC-065 |
| A6 | Refresh tokens | Rotation with reuse detection on (hosted: single-use, 10 s reuse grace, session-wide revoke); self-hosted env config **UNVERIFIED** | VERIFIED (hosted) | REQ-SEC-065 |
| A7 | JWT verification | Pinned alg, reject `none`/substitution, check exp/aud/iss in the Node API; **no grace on expired tokens** (incl. offline phlebotomy uploads: refresh first, then upload) | DECISION (Pass 2) | REQ-SEC-066; REQ-ARCH-070; RFC 8725 |
| A8 | Staff idle / absolute timeout | Idle 15–30 min (tenant-configurable within range); absolute ≤12 h; enforced in BFF | DECISION | REQ-SEC-073 |
| A9 | Patient report OTP | ≥6 digits CSPRNG; TTL ≤10 min; max 5 verify attempts then invalidate; ≤3 sends/number/hour; bound to report link + channel; constant-time compare; no PHI in OTP message. If GoTrue phone OTP is used, its expiry/length must be configured to these values (GoTrue defaults UNVERIFIED) | DECISION | REQ-SEC-069/070 |
| A10 | Report link token | ≥128-bit random + OTP gate; TTL 30–90 days (tenant-configurable); revocable | DECISION | REQ-SEC-094 |
| A11 | QR verify token | ≥128-bit CSPRNG random, server-stored lookup (not HMAC/signed URL) | DECISION (D11) | REQ-SEC-093; REQ-ARCH-049 |
| A12 | Password reset token | Single-use, ≥128-bit, TTL ≤1 h, no account-existence oracle | DECISION | REQ-SEC-075 |
| A13 | Bridge device token | ≥256-bit CSPRNG, shown once, stored as SHA-256 hash, one per device per centre, individually revocable; DPAPI-encrypted on the agent | DECISION | REQ-SEC-071/072/118 |
| A14 | Storage signed URLs | Short TTL (minutes–hours), per request, never logged; cannot be individually revoked (VERIFIED) → signing-key rotation in runbook | VERIFIED / DECISION | REQ-SEC-035 |
| A15 | Mobile token storage | `flutter_secure_storage` (Keychain/Keystore); offline cache encrypted via drift on package:sqlite3 ≥3.x with its SQLCipher (or SQLite3MultipleCiphers) hook option — not sqlcipher_flutter_libs (EOL 0.7.0+eol); key in Keystore/Keychain; **logout blocked while unsynced mutations exist**; read-only data purged on logout | DECISION (Pass 2) | REQ-SEC-102/103 |
| A16 | Phlebotomy app re-auth | Biometric/PIN after >5 min in background | DECISION | REQ-SEC-110 |

## 4. Rate limits (single table — any other file must match)

| Surface | Limit | Enforced at | Source |
|---|---|---|---|
| Login | Per account: 10/hour; ≥5 failures → exponential backoff + step-up. Per client IP (as seen by the public edge, never the BFF): failed attempts only — ≥10 failures in 10 min → that IP limited to 5 attempts/min for 30 min + security alert; successful logins never count. Edge flood guard: 60 req/min/IP (burst 20) on public login/recovery routes. No static-IP or IP-registration dependency (founder decision 2026-11-06). | nginx (flood guard) + identity module (per-account and per-IP failure counters) | REQ-SEC-064/078 |
| OTP request | 3/hour/phone | Redis/app | REQ-SEC-069/078 |
| OTP verify | 5 attempts per issued OTP | app | REQ-SEC-069/078 |
| QR verify | 10/min/IP and 100/day/IP | nginx (per-min) + Redis/app (per-day) | REQ-SEC-078 |
| Report download | 20/hour/patient-link | Redis/app | REQ-SEC-078 |
| Bridge ingest | 60 **requests**/min/device; agent batches ≤100 messages/request | nginx/app | REQ-SEC-078 (Pass 2); 03 §6.4 |
| General API | 10 req/s/user, burst 20; per-tenant aggregate caps | app | REQ-SEC-078 |
| Algorithm | nginx `limit_req` (leaky bucket, r/s or r/m only — VERIFIED); hourly/daily caps in Redis/app using sliding-window or token-bucket | — | REQ-SEC-078/079 |

## 5. Infrastructure, backup, TLS

| # | Item | Value | Status | Source |
|---|---|---|---|---|
| I1 | Initial VMs | VM-1 data: 8 vCPU / 32 GB / NVMe ≥10k IOPS / 500 GB. VM-2 app: 8 vCPU / 16 GB / 200 GB. Object storage on a **separately growable volume or node** | DECISION (sizing = assumptions) | REQ-ARCH-002/003 |
| I2 | Backups | WAL archiving to a second Nepal site + nightly base backup (pgBackRest or WAL-G); encrypted; keys separate; RPO ≤15 min | DECISION | REQ-ARCH-006; REQ-SEC-126/127 |
| I3 | Restore drill | **Monthly**, timed, RTO documented (last drill <35 days) | DECISION (Pass 2: monthly supersedes 02's quarterly) | REQ-ARCH-007; REQ-SEC-126 |
| I4 | Object storage backup | Replicated to the DR site separately from DB backups | DECISION | REQ-ARCH-008 |
| I5 | TLS | TLSRef intermediate: TLS 1.2 + 1.3, ECDHE GCM/ChaCha20, curves X25519MLKEM768/X25519/prime256v1/secp384r1, ECDSA P-256 certs, 90-day ACME | VERIFIED (TLSRef) | REQ-SEC-124 |
| I6 | HSTS | `max-age=63072000` (VERIFIED TLSRef) + `includeSubDomains` (project choice); `preload` only after every subdomain is HTTPS-only | Mixed | REQ-SEC-090 |
| I7 | CDN / DDoS | **No foreign CDN or scrubber by default for any traffic**; non-PHI static content behind a foreign CDN only with explicit founder approval; local mitigation (nginx limits, kernel tuning, ISP contact). Which Nepali ISP offers scrubbing: UNVERIFIED | DECISION | REQ-SEC-135; REQ-ARCH-010 |
| I8 | Retention defaults | Reports 5 years online then archive; audit ≥5 years; raw analyser archive ≥1 year **server-side**; agent local queue truncated after upload (e.g. 72 h bound). Nepali legal retention period: **UNVERIFIED** | DECISION / UNVERIFIED | REQ-ARCH-048/062; REQ-SEC-097/117/139 |
| I9 | Patching | Monthly; critical CVEs 72 h | DECISION | REQ-SEC-129/138 |

## 6. Instrument interfacing

| # | Item | Value | Status | Source |
|---|---|---|---|---|
| N1 | Protocol stacks | Bridge supports **both** ASTM E1381/E1394 (LIS1-A/LIS2-A2) and HL7 v2 over MLLP **from sprint 1** | DECISION | 01 §3.1; REQ-ARCH-051/052 |
| N2 | CLSI LIS2-A2 = revision of ASTM E1394-97 | — | VERIFIED (CLSI preview) | 01 §3.1 |
| N3 | CLSI LIS1-A ↔ ASTM E1381 equivalence | — | UNVERIFIED | 03 log #60 |
| N4 | ASTM low-level | ENQ/ACK/NAK/EOT; frames `STX FN text ETB|ETX C1 C2 CR LF`; FN 1–7,0; checksum FN..ETB/ETX mod 256 as 2 uppercase hex; max frame 247 chars (240 data); contention: instrument retries after 1 s, host defers 20 s | VERIFIED (Beckman Coulter LIS1-A implementation) | 03 §6.1 |
| N5 | ASTM records | H, P, O, R, C, Q, L, S, M | VERIFIED | 01 §3.1 |
| N6 | Mindray BC-5380 | HL7 v2.3.1 over TCP + MLLP; instrument-initiated host query ORM^O01 → LIS replies ORR^O02 | UNVERIFIED — unofficial Scribd copy only; obtain the official Mindray LIS manual for the installed software version (B2) | 01 §3.2 |
| N7 | Mindray BS-120/200 | HL7 v2.3.1; ORU^R01 results; host query QRY^Q02 → LIS replies QCK^Q02 + DSR^Q03 | UNVERIFIED — unofficial Scribd copy only; BS-240 no source; official manual via distributor (B2) | 01 §3.2 |
| N8 | Autobio, Getein, urine analyser, ID/AST protocols | — | **UNVERIFIED** (no official manuals read) | 01 §3.2 |
| N9 | HL7 message set to implement | ORU^R01 in; ORM^O01/OML^O21 out; inbound host queries per N6/N7; QBP where a vendor uses it; ACK original + enhanced (AA/AE/AR, CA/CE/CR); MLLP 0x0B…0x1C 0x0D | VERIFIED (specs) / DECISION | REQ-ARCH-052 |
| N10 | Idempotency | Message-level: (instrument_id, MSH-10) for HL7, (instrument_id, sha256(raw)) for ASTM. Result-level: unique (instrument_id, sample_barcode, analyte_code, instrument_result_time) | DECISION (Pass 2) | REQ-ARCH-058; 01 §3.3 |
| N11 | Agent reliability | Persist raw frame to local encrypted SQLite (WAL) before ACK; at-least-once batched upload with backoff; heartbeat every 60 s; signed config + signed self-update (Authenticode + internal signature); outbound-only HTTPS; low-privilege service account | DECISION | REQ-ARCH-057/060/061; REQ-SEC-114..119 |
| N12 | Timestamps | Store instrument time and server `received_at`; display server time; track per-site clock offset | DECISION | REQ-ARCH-059 |
| N13 | ASTM library | Write the framing layer in-house; no maintained OSS ASTM lib found (UNVERIFIED — re-scan first); Medplum agent = partial prior art only | DECISION / UNVERIFIED | REQ-ARCH-055 |
| N14 | Bi-directional commitment | Results upload for all interfaced instruments; host query only where the vendor manual confirms it; "pending vendor documentation" clause per instrument in contract | DECISION | 01 §3.4 |
| N15 | Analyser reagent telemetry | Not assumed available; inventory uses LIS-count consumption models | DECISION / UNVERIFIED per model | 01 §2.6 |

## 7. Reports, verification, delivery

| # | Item | Value | Status | Source |
|---|---|---|---|---|
| R1 | Release | Two-step: technologist verify → pathologist approve; approved = locked; changes only via versioned amended report (old version kept, marked superseded) | DECISION (ISO 15189 basis UNVERIFIED) | 01 §1.3, §2.2 |
| R2 | Auto-verification | **Phase 2** (depends on the QC engine); Phase 1 = every result manually first-verified; delta checks + critical-value log in Phase 1 | DECISION | 01 §6 rows 10/11; REQ-ARCH-063 |
| R3 | QR verify page fields | Lab name; patient initials or masked name; test panel name(s); report issue date/time + version; status valid / superseded. Never results, phone, address, DOB. Revoked and unknown tokens get an identical response | DECISION (Pass 2 unified) | REQ-SEC-093; 03 §5.4; 01 §1.4 |
| R4 | WhatsApp delivery | Utility template carrying **link only, no PHI**; report fetched from Nepal portal behind OTP. PDF-as-attachment only as tenant opt-in after founder approval + patient consent | DECISION (Pass 2) | 01 §4.5; REQ-SEC-007/070; REQ-ARCH-083 |
| R5 | Email delivery | Link-only via relay; no PDF attachments by default | DECISION | REQ-ARCH-086 |
| R6 | SMS | Fallback channel and OTP; no PHI in body; per-tenant sender ID; Unicode support | DECISION | 01 §4.4; REQ-ARCH-085 |
| R7 | Outsourced PDFs | Treated as untrusted: malware scan, sandboxed qpdf merge, never through the Chromium pool | DECISION | REQ-SEC-083/084/087; REQ-ARCH-046 |
| R8 | Smart report | Rules-based, pathologist-approved template library; supplement upsell excluded; optional LLM only self-hosted in Nepal (a foreign API needs founder approval) | DECISION | 01 §5 |

## 8. Payments

| # | Item | Value | Status | Source |
|---|---|---|---|---|
| P1 | Phase 1 | Payment-method ledger entries (cash/card/wallet/QR recorded by operator), append-only, corrections as reversing rows; part-payments = multiple rows per invoice | DECISION | 01 §1.1; REQ-SEC-057 |
| P2 | Live gateways | eSewa / Khalti / Fonepay APIs in Phase 1.5–2 behind one `PaymentProvider` interface | DECISION | 01 §6 row 5; REQ-ARCH-090 |
| P3 | eSewa ePay v2 | Form POST `https://epay.esewa.com.np/api/epay/main/v2/form`; HMAC-SHA256 Base64 over `total_amount,transaction_uuid,product_code`; `transaction_uuid` alphanumeric + hyphen; status check `/api/epay/transaction/status/` (UAT `https://uat.esewa.com.np/...`); success only on `COMPLETE`; match both "AMBIGUOUS" and "AMBIGIOUS"; `code: 0` = retry. UAT form URL UNVERIFIED | VERIFIED (developer.esewa.com.np) | 01 §4.3; 02 §2; re-read 2026-11-06; details and open points in C15 02-TRD §0 (V1–V15) (08 A19 D-117) |
| P4 | Khalti KPG-2 | Initiate `POST https://khalti.com/api/v2/epayment/initiate/` (sandbox `dev.khalti.com`), `Authorization: Key <secret>`, amount in paisa (min 1000); lookup `POST /epayment/lookup/` with `pidx`. Success **only** `Completed`. Failed: `User canceled`, `Expired` (HTTP 400; also match the prose's "Canceled"/"Failed"). Hold + escalate: `Pending`, `Refunded`, `Partially Refunded`, unknown; `Initiated` is non-terminal (keep polling) until `expires_at` + grace, then hold + escalate (CR-C15-001; 08 A19.2) (all HTTP 200 — never use HTTP status as the signal) | VERIFIED (docs.khalti.com, 2026-11-05) | 01 §4.3; 02 §2; re-read 2026-11-06; details and open points in C15 02-TRD §0 (V1–V15) (08 A19 D-117) |
| P5 | Fonepay | Dynamic QR enabled via a partner bank (VERIFIED, Fonepay blog); API, signature, notification/webhook mechanism **UNVERIFIED**; interim static-QR manual reconciliation | Mixed | 01 §4.3; 02 §2 |
| P6 | Idempotency | Client idempotency key per checkout (unique); unique (gateway, gateway_txn_id); one open intent per order (partial unique index); effects only on the state transition | DECISION | REQ-SEC-050/051/053 |
| P7 | Verification | Server-to-server verification + exact amount match before marking paid; daily reconciliation | DECISION | REQ-SEC-046..048/054; REQ-ARCH-087/089 |

## 9. Regulatory and legal facts

| # | Fact | Status | Source |
|---|---|---|---|
| L1 | Legal basis: VAT Act 2052 s.14A + IRD **Electronic Invoice Procedure (विद्युतीय बीजक सम्बन्धी कार्यविधि), 2074**, in force 2074/09/16, 4th amendment 2076/09/09. The 2072 Procedure is historical (superseded; express repeal UNVERIFIED) | VERIFIED (IRD primary) | https://www.ird.gov.np/public/pdf/175356524.pdf ; https://www.ird.gov.np/public/pdf/1140227555.pdf ; 05 T3 |
| L2 | "2074.09.16" = commencement date of the Electronic Invoice Procedure 2074, which IRD publishes as the current procedure (express repeal of 2072 not checked) | VERIFIED (IRD primary) | 05 T3 |
| L3 | Software must be **listed with IRD** on the manufacturer's self-certification (Annex 1, cl.3(ख)); the LIMS provider issues each user an Annex 2 approval letter (cl.3(ग)); **each lab applies to its tax office (Annex 3) for permission** (cl.4); IRD may inspect/test at any time (cl.9) | VERIFIED (IRD Procedure 2074) | 01 §4.1 |
| L4 | Central/rented-server (SaaS) billing is expressly allowed under Procedure 2074 cl.7(ख): server operator registered in Nepal, server in Nepal, IRD notified and given access, **multi-tenancy with each taxpayer's data stored separately**, **Annex 7 tripartite contract (the LIMS provider / DC operator / each lab) filed with IRD**. Open: the form of "Department access", and whether shared-schema RLS counts as "stored separately" (see D16) | VERIFIED (IRD primary) / BLOCKED (interpretation — IRD) | 05 T3 |
| L5 | VAT Act s.29(1)(g2): **NPR 500,000 fine on the taxpayer (the lab), approved or not, found using software that can delete or correct data**; s.29(1)(c): NPR 10,000 for not issuing an invoice (NPR 1,000 per time is the buyer's fine for not taking one). Procedure cl.6(ख)/(ट): no deletion; corrections by ending the old record's validity and creating a new one, reported separately → invoices immutable: no edit, no delete; cancel/credit note only | VERIFIED (VAT Act English text, IRD; current to Finance Act 2078) | 01 §4.1; 03 §3.7 |
| L6 | Chronological invoice numbering; cancelled invoices viewable/printable; reprints marked "copy of original" + print count; per-user audit trail; real-time CBMS sync; sales/purchase register columns; also required (cl.6): SQL-capable DBMS, activity log + backup/recovery, per-record timestamp/active-flag/user, export Excel/XML/PDF, Nepali or English manual + in-app help, CBMS web-service/API capability. Real-time CBMS push is mandatory for taxpayers designated by IRD notice (cl.4(ङ), 8(ग)) | VERIFIED (IRD Procedure 2074 cl.6) | 01 §4.1; 03 §3.7 |
| L7 | **Gapless** numbering as a legal requirement | UNVERIFIED. DECISION: implement gapless per (tenant, B.S. fiscal year) counter row anyway (safe superset) | 03 D9; REQ-ARCH-032 |
| L8 | Invoice series granularity (per tenant vs per branch) | **BLOCKED — IRD/auditor**. Default per (tenant, fiscal year) | 03 §3.7 |
| L9 | Abbreviated tax invoice limit NPR 5,000 | UNVERIFIED (2018 source, possibly outdated) | 01 §4.1 |
| L10 | VAT Rules 46th amendment (2081): invoice formats must show ≥4-digit HS code + model/brand; vendors must update | VERIFIED (BizSewa, Jul 2024); applicability to lab services UNVERIFIED | 01 §4.1 |
| L11 | Dual calendar (B.S. + A.D.) and statutory books required for approval | VERIFIED (vendor post, not IRD text) | 01 §4.1 |
| L12 | E-billing threshold. *Reported (news only):* mandatory above Rs 200 M turnover (lowered from 250 M, Apr 2026; BFIs exempt). *IRD primary notices found:* Rs 10 crore from 2079/04/01 (notice 2079/02/20; hotels/restaurants/ISPs Rs 5 crore), alcohol/tobacco makers from 2079/10/01 (notice 2079/08/07), and an undated CBMS-registration notice at Rs 35 crore. Client requires IRD-approved billing regardless | UNVERIFIED from primary — the Rs 200 M figure is reported by ICT Frame/Ratopati only; IRD notices found show Rs 10 crore from 2079/04/01 and a Rs 35 crore CBMS-registration notice (undated). Obtain the current notice from IRD | 01 §4.1; 00-scope G5 |
| L13 | Current IRD submission checklist + CBMS API spec | UNVERIFIED — obtain from IRD before billing sprint | 01 §4.1; REQ-ARCH-034 |
| L14 | VAT standard rate 13% (VAT Act s.7(1)) | VERIFIED (primary) | 01 §4.2 |
| L15 | Diagnostic lab services VAT-exempt (Schedule 1); an ICNL copy excludes VAT-registered institutions | UNVERIFIED — **BLOCKED — client's auditor**; billing engine supports both exempt and taxable lines. Finance Bill 2081 removed some Group-5 goods (incl. diagnostic kits HS 3002.90.10) from Schedule 1 (IRD 457398751.pdf), so kit/reagent sales may be taxable | 01 §4.2; 05 T4 |
| L16 | Fiscal year starts Shrawan 1 | VERIFIED | 01 §4.8 |
| L17 | Privacy Act 2075: duties are addressed to public bodies (s.25, s.27(1)), public bodies and bodies corporate (s.26), or **any person** (s.12(4), s.29), so individual staff are personally liable (training and access policy must say so); health = sensitive (s.27(2)); s.12(4)(a) no disclosure of health-examination details without consent; s.26(1) binds bodies corporate; s.25 security duty and s.27(1) bind **public bodies only**; s.29(2) ≤3 years and/or ≤NPR 30,000; s.30 complaint within 3 months; s.31 compensation; no data-localisation clause | VERIFIED (Law Commission English text, giwmscdnone.gov.np/…/1721034328_44.pdf) | 01 §4.7; 02 §0 |
| L18 | Privacy Regulation 2077 exists (8 Bhadra 2077); content | Exists VERIFIED; content UNVERIFIED | 01 §4.7; 02 §0 |
| L19 | NMC clause-level prohibition of referral commissions; NHPC codes on commissions; TDS on referral payouts | UNVERIFIED. DECISION: referral-incentive reporting only, never labelled "commission", payouts outside the system or behind a tenant flag | 01 §1.5, §4.6 |
| L20 | Lab record/report legal retention period in Nepal | UNVERIFIED | REQ-SEC-097/139; REQ-ARCH-048 |
| L21 | ISO 15189 requires a critical-result notification protocol | VERIFIED (Biochem Med 2019) | 01 §2.2 |
| L22 | ISO 15189 requires an amended-report path; rejection rate as a standard QI | UNVERIFIED | 01 §1.3, §2.1 |
| L23 | Westgard rules: 1-2s warning; 1-3s, 2-2s, R-4s (one > +2SD and another < −2SD, within-run only), 4-1s, 10x rejection; classic vs modern multirule = per-lab flag; rule set depends on N controls per run (N=2/4: 2-2s, 4-1s, 8x/10x/12x; N=3: 2of3 2s, 3-1s, 6x/9x) — the engine takes N from the QC configuration | VERIFIED (westgard.com) | 01 §2.5 |
| L24 | CLSI M100 current edition Ed36 (26 Jan 2026); specimen-site breakpoint dimension | Edition VERIFIED; site dimension UNVERIFIED (keep in lookup key) | 01 §2.3 |
| L25 | Health Service Tax (स्वास्थ्य सेवा कर, IRD revenue code 11442) exists for health services by institutions other than government/community hospitals. Rate, applicability to diagnostic labs and invoice presentation **UNVERIFIED — BLOCKED — client's auditor**. The billing engine must support an additional per-line tax type besides VAT | UNVERIFIED (existence VERIFIED, IRD revenue-heading list https://ird.gov.np/public/pdf/1774171894.pdf) | 05 T3 |
| L26 | IRD software requirements (Procedure 2074 cl.6): SQL-capable DBMS (क); activity log + backup/recovery (ग); every record carries timestamp, active status flag and user (घ); serial numbering per fiscal year (ङ); each number printed once, reprints marked "Copy of Original"/"प्रतिलिपि" with print count stored (च); cancel with reason + cancelled-invoice report (ज); audit-trail report (ञ); no deletion, corrections by ending validity + new record (ख/ट); export to Excel/XML/PDF (ठ); Nepali/English user manual + in-app help (ढ); able to send data to CBMS by web service/Web API (ण). **Real-time CBMS push only for taxpayers IRD designates by notice** (cl.4(ङ), 8(ग)); others must be capable of it | VERIFIED (IRD Procedure 2074, near-verbatim from garbled-font PDF) | 05 T3; https://www.ird.gov.np/public/pdf/175356524.pdf |

## 10. Third-party facts with dates (re-verify at integration time)

| # | Fact | Status | Source |
|---|---|---|---|
| T1 | WhatsApp per-message pricing since 1 Jul 2025; categories marketing/utility/authentication (+service); rates vary by country | VERIFIED (Meta pricing page) | 01 §4.5; 03 §9.1 |
| T2 | Meta pricing page (current docs path) rate cards effective 1 Apr 2026 or 1 Jul 2026 (the two Meta page variants differ; neither copy reached is dated after 1 Oct 2026); free entry point window: all messages free 72 h; "Utility templates delivered within an open customer service window are free"; "All non-template messages are free" | VERIFIED (fetched 2026-11-05) | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing |
| T3 | From 1 Oct 2026: in-window utility templates chargeable from the first message; 1,000 free service messages per number/month | **Reported by BSPs, not confirmed on Meta's pricing page — UNVERIFIED**. Cost model assumes the BSP-reported (charged) case | respond.io, baat.ai, Zoho (01 §4.5) |
| T4 | Unverified WhatsApp businesses: 2 numbers, 250 business-initiated templates/24 h | VERIFIED (BSP source, Clickatell) — not Meta primary | 01 §4.5 |
| T5 | Nepal WhatsApp: leaves "Rest of Asia Pacific" with its own lower utility/authentication rates (+ new authentication-international rate) under the Meta rate-card update effective 1 Oct 2026 per Meta's pricing page; figure UNVERIFIED (download the current rate card). In-window utility charging stays BSP-reported/UNVERIFIED (T3). Sparrow/Aakash SMS pricing UNVERIFIED | Mixed | 03 §9.1 |
| T6 | Mirth Connect 4.6+ commercial only; 4.5.2 last open-source → design reference only | VERIFIED | 03 §6.2 |
| T7 | Graphile Worker v0.18.0; pg-boss v12.38.0; node-hl7-client 4.1.2; drift 2.35.3; openapi-typescript 7.13.0; openapi-fetch 0.17.0; fastify-openapi-glue 4.12.0; Prism 5.16.0 (3.1 support UNVERIFIED); MSW 3.0.3; oasdiff 1.35.0 (26 Oct 2026; OAS 3.1 only in v2.2.0-openapi31 beta — pin the stable 1.35.x line, spec stays 3.0-compatible); go.bug.st/serial v1.8.0; x/sys v0.49.0; qpdf 12.4.2 | VERIFIED (registries, 03 Pass 1) | 03 log |
| T8 | dart-dio generator OAS 3.1 completeness (generator docs list OAS2/OAS3 only; v7.27.0, 2 Nov 2026) | UNVERIFIED → spec stays 3.0-compatible | REQ-ARCH-072 |

## 11. Data residency and foreign touchpoints (register seed for REQ-SEC-141)

| Touchpoint | Data | Status | Rule |
|---|---|---|---|
| Transactional email relay | Link + non-PHI text | Pre-allowed pattern (00-scope §7.1) | Link-only, no attachments |
| WhatsApp Cloud API / BSP (Meta) | Phone number, template text, link | Inherently abroad (00-scope §7.1 flag) | Link-only; consent checkbox at registration; PDF attachment needs founder approval |
| SMS gateways (Sparrow, Aakash) | Phone number, text, OTP | Hosting location UNVERIFIED → treat as cross-border | No PHI in text |
| HIBP Pwned Passwords range API | 5-char SHA-1 prefix | Foreign; **needs founder approval** | Default: local list |
| External LLM API | — | Foreign; **needs founder approval** | Default: self-hosted model in Nepal |
| Foreign CDN / DDoS scrubber | Traffic | **Needs founder approval**; never for PHI endpoints | Default: none |
| Payment gateways (eSewa, Khalti, Fonepay) | Order ref, amount | Nepali providers (server location not verified) | Gateway references only, no PHI |
| Device maps app hand-off (phlebotomy app, C17) | Visit address passed to the phone's own maps app via OS intent/URL; no embedded map SDK | **APPROVED by founder 2026-11-06** (resolves CR-C17-012) | Address only, no name/tests/phone in the hand-off |

## 12. Module phasing (from 01 §6; binding for 02/03 phase applicability)

| Phase | Modules |
|---|---|
| **1** | One-page registration & billing; discounts with reason + approver; part-pay; urgent charge; IRD-compliant immutable invoicing + CBMS sync; payment-method ledger; barcodes, accept/reject, specimen state machine; analyser import (upload for all interfaced instruments, bi-directional where supported, phased per driver); results entry, formulas, short codes, previous results; two-step verification, lock, amended reports; delta checks + critical-value log; report delivery (print/PDF, SMS, email, WhatsApp link-only, hold-till-paid, bulk release, QR verify, letterhead toggle, outsourced-PDF merge); narrative report engine (radiology/USG/endoscopy); roles, audit, masters; per-doctor/centre price lists + Excel import/export, credit-party billing; referral-incentive reporting; daily cash report + named MIS dashboards; TAT timestamps + pending list; QC data capture (no engine); responsive web patient portal |
| **1.5–2** | Live eSewa/Khalti/Fonepay integration |
| **2** | Auto-verification engine; QC LJ charts + Westgard engine; TAT targets/alerts; microbiology (isolates, AST, prelim/final); molecular; histopathology/cytology/IHC; inventory (consumption models, lots/expiry, PO, wastage); B2B partner portal (web); queue token display; B2C follow-up reminders; smart report (rules-based) starts (2–3) |
| **3** | Native patient app + phlebotomy app (**BLOCKED — client priority**, see B1); appointment slots; loyalty/membership (minimal); cascade AST reporting rules; optional LLM smart-report fluency layer |
| **DROP / integrate** | Dedicated cytogenetics module (use narrative engine); real-time reagent telemetry; smart-report supplement upsell; kiosk; CRM (export + external tool); generic patient document vault; HR/payroll; marketing & sales-team management; marketing website/CMS; PACS/DICOM (for now) |

Rule: a 02/03 requirement applies from the phase in which its component ships. REQ-SEC §1, §3, §4, §6, §7 and REQ-SEC-057 apply from Phase 1. §2 gateway requirements apply from Phase 1.5–2. §5 mobile requirements apply when the apps ship.

## 13. Blocked items (cannot be finalised without input)

| # | Item | Blocked on | Default until answered |
|---|---|---|---|
| B1 | Module priority ranking, incl. whether the patient/phlebotomy apps (client formula) and B2B portal move earlier than 01 recommends | Client (00-scope §6 item 4) | 01 §6 phasing |
| B2 | Exact analyser model list and official host/LIS interface manuals (Autobio, Mindray, Getein, urine, ID/AST system) | Client + vendors/distributors (00-scope §6 item 2) | Both ASTM and HL7 stacks; no bi-directional promise per instrument |
| B3 | Test list with prices and reference ranges | Client (00-scope §6 item 1) | Synthetic catalog |
| B4 | eLabs export format / migration sample | Client (00-scope §6 item 3) | No migration build. C18's documents specify the canonical export format, staging, mapping, validation and cut-over runbook (design only); no DDL, ports or tool code before the client delivers the eLabs export sample. |
| B5 | Ownership/licensing terms the LIMS provider ↔ anchor client | Client + founder (00-scope §6 item 5) | — |
| B6 | IRD: submission checklist, CBMS API spec, cl.7 interpretation ("Department access"; RLS as "stored separately"), Annex 7 contract template, invoice-series granularity, current e-billing threshold notice | IRD / auditor | Gapless per (tenant, FY); immutable invoices; billing tables isolatable per tenant (D16) |
| B7 | VAT treatment of the lab's services (Schedule 1), HS-code applicability, and Health Service Tax applicability/rate (L25) | Client's auditor | Engine supports exempt and taxable lines |
| B8 | Fonepay merchant API/webhook spec | Lab's acquiring bank / Fonepay | Static-QR manual reconciliation |
| B9 | Meta business verification per legal entity; WhatsApp volume; Nepal rate | Client | Budget the BSP-reported charges |
| B10 | Atlas Pro budget vs free linter | Founder | No lint gate assumed free |
| B11 | Approval of any foreign touchpoint beyond the email relay (HIBP, LLM API, CDN/scrubber, WhatsApp PDF attachments) | Founder | Not used |
| B12 | Nepal DC/VM provider, SLA, DR site | Founder / procurement | Spec in I1 |
| B13 | Referral-incentive compliance position | Client management | Reporting only, no "commission" label |
| B14 | Named pathologist owning smart-report templates and critical-value SOP | Client | — |
| — | **Founder decisions recorded 2026-11-06:** (1) Authenticode code-signing certificate for the bridge agent is purchased and owned by the client (C7 CR-C7-012); (2) app-store developer accounts, listings and signing keys for the patient and phlebotomy apps are owned by the client (C16 FA-1, C17); (3) maps hand-off APPROVED (see §11); (4) every smart-report summary requires its own pathologist approval — KEPT (C14 risk R1 accepted; volume mitigated by `min_mapped_results`, default 3) | Founder | Closed |
| B15 | Legal retention periods for lab records | Nepali counsel | 5-year default, per-tenant config |
| B16 | Privacy Regulation 2077 content; NMC/NHPC code texts | Nepali counsel | Controls as specified in 02 |
| B17 | IRD "each taxpayer's data stored separately" (Procedure 2074 cl.7(ख)): shared-schema + RLS vs schema-per-tenant vs separate database for billing data (D16) | IRD (clarification) | Shared schema + RLS, with billing/invoice tables isolatable per tenant (export/move one tenant's billing data without touching others) |

## 14. Capacity assumptions (all ASSUMPTION unless noted; 03 §1)

| Item | Value |
|---|---|
| Patients/day/lab | 500 (client upper bound "1–500/day", G2) |
| Branches + collection centres | 20 (G3) |
| Billable orders/day/lab | 5,000 (10 per patient, assumption) |
| Result rows/day/lab | 15,000–25,000 |
| Analyser messages/day/lab | 1,500–3,000 (3–6 per patient) |
| PDFs/day/lab | 500–700 (≤1,000 with reprints); 150 KB/PDF UNVERIFIED — measure |
| Peak hour | 25% of daily volume (conservative) |
| Concurrent staff/lab | ~60; 6–12 req/s, bursts ~50 req/s |
| N = 10 labs | 60–120 req/s sustained, ~500 req/s burst; derived ≲50 writes/s; 250 writes/s headroom target |
| Storage | ≈47.5 GB/year/lab (PDFs ≈33, DB ≈9, raw archive ≈5.5); ≈475 GB/year at N = 10 |

---

## Pass 2 conflict list (27, all fixed in 01/02/03)

1. WhatsApp 1 Oct 2026 changes (01↔03) · 2. WhatsApp PDF attachment vs link-only (01↔02/03/00) · 3. Staff web BFF vs browser Supabase/Realtime (02↔03) · 4. RLS tenant source `app.tenant_id` vs JWT claims (02↔03) · 5. Table owner/BYPASSRLS/connection roles (02↔03) · 6. "ASTM dominant on Autobio/Getein" + LIS2 status (01↔03) · 7. Mindray host-query direction (01↔03) · 8. Ingest idempotency keys (01↔03) · 9. Ingest rate limit vs backlog drain (02↔03) · 10. Raw archive location vs agent queue retention (02↔03) · 11. Bridge agent OS / Go Windows 10+ (01↔02↔03) · 12. IRD gapless + immutability/penalties (01↔03) · 13. QR token type + verify field list (01↔02↔03) · 14. pdf-lib decision line (03↔02) · 15. Redis (02↔03) · 16. Restore-drill cadence (02↔03) · 17. Edge proxy nginx vs HAProxy, gateway Kong vs Envoy (02↔03) · 18. Foreign CDN scope (02↔03↔00) · 19. Offline token grace (02↔03) · 20. Phlebo cache purge vs unsynced queue (02↔03) · 21. Audit-log fields/access events (02↔03) · 22. bikram-sambat version + B.S. range (01↔03) · 23. HIBP foreign call (02↔00) · 24. External LLM API (01↔00) · 25. SMS gateways "local" (03↔00) · 26. Phasing: auto-verify, apps, payments (01↔02↔03↔00) · 27. Khalti status strings (01↔02).

---

## Verification log — Pass 2b (primary-source corrections, 2026-11-05)

Source of every change: `05-pass2-critical-recheck.md` (05), section and correction item number given. `00-scope-baseline.md` not modified.

| Item | Old | New | Source (from 05) |
|---|---|---|---|
| L1 | Legal basis = Procedure related to Computerized Invoicing, 2072 — VERIFIED (Pioneer Law) | VAT Act s.14A + Electronic Invoice Procedure 2074 (in force 2074/09/16, 4th amdt 2076/09/09); 2072 historical, express repeal UNVERIFIED — VERIFIED (IRD primary) | 05 T3, item 1; ird.gov.np 175356524.pdf, 1140227555.pdf |
| L2 | Directive 2074.09.16 supersedes 2072 — UNVERIFIED | 2074.09.16 = commencement of Procedure 2074 (current) — VERIFIED | 05 T3, item 2 |
| L3 | One-time IRD certification (developer) + per-taxpayer use approval — Pioneer Law | Listing by manufacturer self-certification (Annex 1, cl.3(ख)), Annex 2 letter (cl.3(ग)), lab permission from tax office (Annex 3, cl.4), IRD inspection (cl.9) — IRD Procedure 2074 | 05 T3, item 3 |
| L4 | Multi-tenant SaaS coverage — UNVERIFIED, ask IRD | cl.7(ख): Nepal server, Nepal-registered operator, IRD notified + access, each taxpayer's data stored separately, Annex 7 tripartite contract — VERIFIED / interpretation BLOCKED (IRD) | 05 T3, item 4 |
| L5 | NPR 1,000 per instance; NPR 500,000 for software permitting modification/deletion — Pioneer Law | NPR 500,000 on the taxpayer (lab) using software that can delete/correct (VAT Act s.29(1)(g2)); NPR 10,000 non-issuance (s.29(1)(c)); NPR 1,000 = buyer's fine; Procedure cl.6(ख)/(ट) correction mechanism | 05 T3, item 5; 1140227555.pdf s.29 |
| L6 | Status: community vendor thread | Added cl.6 requirements (SQL DBMS, activity log/backup, timestamp+active flag+user, Excel/XML/PDF export, manual/help, CBMS API capability); real-time CBMS only for designated taxpayers — VERIFIED (Procedure 2074 cl.6) | 05 T3, item 6 |
| L12 | Rs 200 M threshold — VERIFIED (ICT Frame, Ratopati) | Rs 200 M = news only → UNVERIFIED from primary; IRD notices show Rs 10 crore from 2079/04/01 and undated Rs 35 crore CBMS notice | 05 T3, item 7; 859820448.pdf, 252578448.pdf, 89878961.pdf |
| L15 | Source 01 §4.2 | + Finance Bill 2081 removed diagnostic kits (HS 3002.90.10) etc. from Schedule 1 | 05 T4, item 11; 457398751.pdf |
| L17 | "applies to public bodies and Nepali bodies corporate"; ADB English text | Duties addressed to public bodies (s.25, s.27(1)), public bodies + bodies corporate (s.26), any person (s.12(4), s.29) → staff personally liable; Law Commission English text | 05 T12, item 12 |
| L23 | Westgard rule set without N | + rule set depends on N controls per run (N=2/4 vs N=3 variants) | 05 T9, item 13 |
| L25 (new) | — | Health Service Tax (revenue code 11442) — applicability/rate UNVERIFIED, BLOCKED → client's auditor; per-line extra tax type | 05 T3, item 8; 1774171894.pdf |
| L26 (new) | — | Procedure 2074 cl.6 software requirements listed in full; real-time CBMS only for designated taxpayers | 05 T3 (L6 row) — added by Pass 2b instruction |
| B6 | current directive text, multi-tenant certification scope | cl.7 interpretation, Annex 7 template, current threshold notice; default adds billing isolatable per tenant | 05 T3, item 10 |
| B7 | Schedule 1 + HS code | + Health Service Tax applicability/rate (L25) | 05 T3, item 9 |
| D16 / B17 (new) | — | BLOCKED/OPEN: IRD "separately stored" — shared-schema+RLS vs schema-per-tenant vs separate DB for billing data; design rule: billing/invoice tables isolatable per tenant | 05 T3 (L4 row) — added by Pass 2b instruction |
| D5 | postgres BYPASSRLS only | + service_role, supabase_admin, supabase_etl_admin, supabase_read_only_user; CI asserts rolbypassrls = false for app roles | 05 T6, item 19 |
| D9 | app-generated unless PG 18 uuidv7() available — version UNVERIFIED | Image supabase/postgres:17.6.1.136 (PG 17) → no native uuidv7(); app-code UUIDv7 (Node + Dart helpers), extension only if in pinned image | 05 T6, item 18 |
| D13 | B.S. ranges UNVERIFIED | bikram-sambat 1970–2090 (insufficient); @remotemerge 1975–2099; @sbmdkl 1978–2099 (A.D. ≤2040); nepali_utils 1969–2100; proposed JS @remotemerge 1.2.7 + Dart nepali_utils 3.0.8; shared golden table 2000–2099 B.S. | 05 T13, item 22 |
| D14 | (S, I / "susceptible, increased exposure", R, SDD, NS, WT/NWT…); Mayo | CLSI S/SDD/I/I^/R/NS (colistin I/R only); EUCAST S/I(increased exposure)/R; WT/NWT; store category + standard + version; CLSI blog | 05 T10, item 14 |
| A2 | bcrypt; enforce cost ≥10; configurability UNVERIFIED | Fixed cost 10, not configurable, re-hash to 10 on login; compensating controls (MFA, breach-list, rate limits) — VERIFIED (supabase/auth source) | 05 T6, item 17 |
| A15 | offline cache SQLCipher/encrypted | drift on package:sqlite3 ≥3.x SQLCipher/SQLite3MultipleCiphers hook; not sqlcipher_flutter_libs (EOL) | 05 T13, item 23 |
| N6 | VERIFIED (secondary Scribd copy) | UNVERIFIED — unofficial copy only; official manual via distributor (B2) | 05 T11, item 15 |
| N7 | VERIFIED (secondary Scribd copy); BS-240 UNVERIFIED | UNVERIFIED — unofficial copy only; BS-240 no source | 05 T11, item 16 |
| S6 | never publicly exposed | + stock compose binds :8000, :5432, :6543 on 0.0.0.0 → bind 127.0.0.1/private + firewall + infra test | 05 T6, item 20 |
| S8 | PgBouncer transaction mode | + stock ships Supavisor 2.9.13; D3 keeps PgBouncer via official docker-compose.pgbouncer.yml override, Supavisor disabled; PgBouncer ≥1.21 | 05 T6/T13, item 21 |
| S13 | squawk-cli 2.70.0 exists | squawk-cli 2.70.0 on npm (GitHub v2.71.0); Atlas community lint nuance | 05 T13 + Additional, item 26 |
| S16 | Go ≥1.21 only | + toolchain Go ≥1.26 (x/sys v0.49.0 go.mod), pin consistently | 05 T13, item 28 |
| T2 | rate cards effective 1 Apr 2026 | 1 Apr or 1 Jul 2026 (variants differ); free entry point window 72 h | 05 T1, item 24 |
| T5 | Nepal rate region/price UNVERIFIED | Nepal own lower utility/auth rates from 1 Oct 2026 (Meta page); figure UNVERIFIED; in-window charging stays BSP-reported/UNVERIFIED | 05 T1, item 25 |
| T7 | oasdiff 1.35.0 | + 3.1 only in v2.2.0-openapi31 beta; pin stable 1.35.x | 05 T13, item 27 |
| T8 | dart-dio 3.1 UNVERIFIED | + generator docs list OAS2/OAS3 only; v7.27.0 | 05 T13 (optional) |
| Header | Pass 1 + Pass 2 | + Pass 2b reference | this pass |
| D4 | TO authenticated | TO lims_app (X9 wording) | 08-CR-REGISTER R5 |
| §4 Login | 5/min/IP + 10/hour/account | per-IP failed attempts only + edge flood guard 60/min/IP; no static-IP dependency | 08 Addendum A1 (supersedes R6; CR-C1-009) |
| B4 | No migration design | design only, no build | 08 R15 (CR-C18-010) |
