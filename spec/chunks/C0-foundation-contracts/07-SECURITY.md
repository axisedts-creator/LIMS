# C0 — Foundation & Contracts — 07 SECURITY

Status: DRAFT for build, 2026-11-05. Abbreviations as in `01-PRD.md`. REQ IDs are cited, not copied (04 precedence rule 4). Phase applicability: REQ-SEC §1, §3, §4, §6, §7 apply from Phase 1. §2 (gateways) applies to C0 only as the `PaymentProviderPort` contract/fake. §5 (mobile) applies to `lims_ui`/`lims_shared` when the apps ship (04 §12 rule).

C0 is the security floor for every other chunk. A defect here is a defect everywhere. Every control below has an implementation location and a test (DoD §4).

---

## 1. Applicable requirements

### 1.1 Multi-tenancy isolation (REQ-SEC §1)

| REQ | How it applies in C0 | Where | Test |
|---|---|---|---|
| REQ-SEC-001/002 | ASVS 5.0 L2 target; BOLA is the primary threat class for every core design decision | all | security sign-off (DoD §4) |
| REQ-SEC-004 | per-column PHI class in `db/meta/tables.yaml` for every table C0 creates (incl. translations) | 0B | `check-registry` fails on a missing class |
| REQ-SEC-011 | ENABLE RLS on every tenant table; exemptions only in `rls_exempt.txt` | 0B | AC-0B-2.1 |
| REQ-SEC-012 | FORCE RLS; tables owned by NOLOGIN non-BYPASSRLS `lims_owner`; no request path as `postgres`/`service_role` | 0B, 0D | AC-0B-1.x |
| REQ-SEC-013 | tenant only from verified claims → `request.jwt.claims` | 0D `core/auth`, `core/db/tx.ts` | AC-0D-2.2 |
| REQ-SEC-014 | one policy per command; UPDATE has explicit WITH CHECK equal to USING | 0B | policy-shape suite |
| REQ-SEC-015 | policies `TO lims_app` (IC X9), or the narrower `lims_owner`/`lims_queue`/`lims_reporting_lookup` for DEFINER paths; never `public`/`anon`/`authenticated` on module tables | 0B | AC-0B-2.2 |
| REQ-SEC-016 | default deny; `USING (true)` banned | 0B | AC-0B-2.2, `check-migrations` |
| REQ-SEC-017 | centre scope via `app.has_all_centres()`/`app.current_centre_ids()` + membership tables | 0B | AC-0B-3.4; helpers-positive test |
| REQ-SEC-018 | nothing granted to `anon`; `api` schema empty in v1 | 0B | grant suite |
| REQ-SEC-019/020/021 | DEFINER only in `app`, `search_path=''`, schema-qualified, inventoried, no caller-supplied tenant | 0B | DEFINER inventory test |
| REQ-SEC-022 | helpers wrapped `(SELECT …)` in every policy | 0B | `EXPLAIN` check on sample queries shows InitPlan |
| REQ-SEC-023 | `tenant_id` leads every index; documented exceptions only | 0B | `check-registry` |
| REQ-SEC-024 | explicit tenant filter in `ctx.core` queries and in the lint guidance for module repositories | 0D | code review rule + unit test on core-repo SQL |
| REQ-SEC-025 | load test with production-shaped data | 0D T0D-16 | load report |
| REQ-SEC-026 | composite FKs; FK/unique violations mapped to `404 common.not_found` (no oracle) | 0B, 0D | AC-0B-3.5, AC-0D-3.2 |
| REQ-SEC-027 | `tenant_id NOT NULL` without default; insert WITH CHECK against claims | 0B | `check-migrations`; isolation insert probe |
| REQ-SEC-028 | UUIDv7 ids; no integer ids in routes (`routes.yaml` params UUID/token only) | 0A, 0C | spec lint rule 5; `buildRoute` rejects non-UUID params |
| REQ-SEC-029/030 | service/secret key server-side only; allowlist of files that may reference it (§7) | 0A | CI grep (AC-0B-1.3) |
| REQ-SEC-031 | every view `security_invoker = true` | 0B | view suite |
| REQ-SEC-032/033 | PostgREST exposes only the empty `api` schema; `db-max-rows` set in the dev stack (prod: C1) | 0A dev stack | config test |
| REQ-SEC-034/035 | Storage policy templates on the first path segment; signed URLs never logged (logger denylist `url`) | 0B, 0A | SP-4 probes; logger corpus |
| REQ-SEC-036 | Realtime policies only after SP-4; Flutter-only | 0B | SP-4 |
| REQ-SEC-037 | dev stack generates fresh secrets; never `.env.example` values; Studio bound to 127.0.0.1 | 0A | AC-0A-6.2/6.3 |
| REQ-SEC-038 | no view or function joins `auth` schema data into module schemas | 0B | `check-migrations` grep for `auth.` |
| REQ-SEC-039 | grants per table class (`05-SCHEMA.md` §5) | 0B | grant suite |
| REQ-SEC-040/041/044 | probe suites for every table (0B) and every operation (0C manifest + owner probes); two permanent synthetic tenants | 0B, 0C, 0A | gate 10 |
| REQ-SEC-042 | negative test per policy, in the same PR | 0B | gate 9 checklist item 10 |
| REQ-SEC-045 | `lims_rls_denied_total` metric + alert proposal | 0D | metric presence test |

### 1.2 Authentication and sessions (REQ-SEC §3)

| REQ | How it applies in C0 | Where | Test |
|---|---|---|---|
| REQ-SEC-065 | access JWT ≤ 1 h (GoTrue config recorded in SP-1); refresh is server-side in C2 (`resolveSession`; GoTrue refresh tokens never reach the BFF or apps — 08 R10) | 0D web core | session tests |
| REQ-SEC-066 | pinned alg, reject `none`/substitution, `exp` 0 s leeway, `iss`, `aud` | 0D `core/auth/jwt.ts` | AC-0D-2.1 |
| REQ-SEC-067 | tenant/membership/actor claims built only by the identity `claimsResolver` from the `identity.sessions` row (08 R10); JWT claims other than `sub`, `session_id`, `aal`, `exp`, `iat` ignored; privileged re-validation is IdentityPort's (C2) | 0D, 0B (identity DEFINERs) | SP-1 (`session_id`/`aal` present); tampered-claim token test (re-signed with a wrong key); JWT with own `tenant_id` claim → ignored (AC-0D-2.2a) |
| REQ-SEC-068 | BFF only; no Supabase client or tokens in the browser; cookies HttpOnly/Secure/SameSite=Lax with `__Host-` prefix | 0D web core | AC-0D-7.3 |
| REQ-SEC-073 | idle 15–30 min / absolute ≤ 12 h enforced in the BFF core | 0D | AC-0D-7.2 |
| REQ-SEC-074 | access-action codes for auth events seeded; C2 writes them | 0B seed | seed test |

### 1.3 API and web (REQ-SEC §4)

| REQ | How it applies in C0 | Where | Test |
|---|---|---|---|
| REQ-SEC-078/079 | rate-limit tiers exactly per 04 §4; sliding window/token bucket; fail-closed for brute-force tiers | 0D `core/ratelimit` | boundary-burst tests |
| REQ-SEC-080 | strict spec validation, `additionalProperties: false`, unknown params rejected | 0C lint, 0D openapi mount | spec lint; unknown-field test |
| REQ-SEC-081 | kit and core never serialise rows; `ctx.core` returns typed fields; module mappers own per-role field lists | 0D | type tests |
| REQ-SEC-082 | parameterised SQL only; `format('%I')` in PL/pgSQL purge loops | 0A lint, 0B | lint fixtures; SQL review |
| REQ-SEC-083 | `FileUpload` client hints (type, 15 MB); server enforcement is the module's; body-size guard in core | 0D | size guard test |
| REQ-SEC-088 | no `dangerouslySetInnerHTML` (lint); kit renders text nodes only | 0A, 0D | lint; XSS payload corpus over components |
| REQ-SEC-089 | CSP from `middleware.ts`: `default-src 'self'; img-src 'self' data:; script-src 'self' 'nonce-<per request>'; …` — `data:` images only for `PrintFrame` branding (08 A18.1); no remote image origin; report-only first | 0D | header test (AC-0D-7.6) |
| REQ-SEC-090 | security headers in the BFF middleware (nginx also sets them — C1) | 0D | header test |
| REQ-SEC-091 | Origin/Sec-Fetch-Site check on every BFF mutation and server action | 0D | AC-0D-7.4 |
| REQ-SEC-092 | API CORS: none for browsers (the BFF is server-to-server); exact-origin allowlist config if ever enabled | 0D | CORS probe returns no `Access-Control-Allow-Origin` |
| REQ-SEC-095 | problem+json without internals; `request_id` reference only | 0D | AC-0D-3.1 |
| REQ-SEC-096/097 | audit trigger + access-log API; append-only grants | 0B, 0D | AC-0B-4.3, 5.x |
| REQ-SEC-098 | no PHI in URLs (spec lint), logs (logger), metrics labels (review) | 0A, 0C, 0D | log PHI scan (DoD §1.8) |
| REQ-SEC-099 | every route in a spec; `x-public` with justification; route inventory diff (Fastify routes vs specs) at boot | 0C, 0D | boot check |
| REQ-SEC-100 | bulk limit 200 ids in `_common.yaml` conventions; privileged flag for bulk export permissions comes from `permissions.yaml` | 0C | lint |

### 1.4 Infrastructure-adjacent (REQ-SEC §7) and mobile (§5)

| REQ | How it applies in C0 |
|---|---|
| REQ-SEC-128 | secrets only from files/env injected by the secret store; gitleaks gate 11; `.env.devstack` gitignored |
| REQ-SEC-129 | lockfiles committed; exact versions; base images by digest; osv/audit gate 12 |
| REQ-SEC-130 | service Dockerfiles: non-root user, read-only root FS where possible, no docker.sock; trivy gate 14 |
| REQ-SEC-131 | role model of `05-SCHEMA.md` §1 (`lims_analytics` reserved for views) |
| REQ-SEC-133 | metrics + alert proposals (`02-TRD.md` §13) |
| REQ-SEC-136 | synthetic data only; undeliverable phone/email generators; seeds refuse production |
| REQ-SEC-137 | timestamps from DB `now()`/server clock only; NTP is C1 |
| REQ-SEC-141 | no foreign touchpoint in any C0 package (fonts, icons, telemetry bundled or absent); dev stack uses the local mail sink |
| REQ-SEC-102/105/107/111 | `lims_ui` defaults: no TLS bypass helpers, no secrets, sensitive fields without suggestions; secure storage is the apps' (C16/C17) concern |

---

## 2. Threat model (STRIDE per asset / entry point)

| Asset / entry point | S — Spoofing | T — Tampering | R — Repudiation | I — Information disclosure | D — Denial of service | E — Elevation of privilege |
|---|---|---|---|---|---|---|
| **JWT verification** (`core/auth`) | forged token, `alg:none`, key confusion → pinned alg, local key file, 0 s exp leeway (AC-0D-2.1) | claim edit → signature check; tenant claims only from the identity `claimsResolver` (08 R10) | `auth_failures_total{reason}` + access log entries by C2 | error bodies identical for invalid/expired (`auth.*` code only) | verification is local (no network); rate-limited | token for tenant A used on B's ids → RLS + 404 |
| **Request context → RLS** (`core/db/tx.ts`) | — | body/header `tenant_id` → never read (spec rejects unknown fields; claims built server-side) | `app.request_id` in every audit row | pooled-connection leak → transaction-local `set_config` only (SP-9, AC-0D-2.3) | `statement_timeout` 5 s, `lock_timeout` 3 s | bare `SET role` from app code → lint ban; `lims_api` cannot `SET ROLE` (no membership in owner roles) |
| **DB roles and DEFINER functions** | connecting as `postgres`/`service_role` → CI grep allowlist (§7) | DEFINER hijack via `search_path` → `search_path=''` | DEFINER inventory reviewed per change | owner-bypass → FORCE RLS + NOLOGIN owner; `owner_only` policies stay tenant-bound or carry the function's narrow fixed predicate (`tenant_id IS NULL` for `app.dl_*`; sole `USING (true)`: `identity.platform_staff__select__owner_only`, 08 A10.5) or a transaction-local GUC the DEFINER sets and resets (`app.pre_*` pre-tenant lookups, `app.maintenance = '<function name>'` ANDed with the expiry predicate for every purge/expiry function — no static maintenance policy, 08 A15.3; `TO lims_owner` only, so a `lims_app` session setting the GUC gains nothing — 08 A12.1–A12.3) | runaway purge → batched loops with a 4-min cap inside a 300 s statement timeout, one transaction per purge, capped metric (08 A25 D-200) | a new DEFINER sneaks in → inventory equality test (REQ-SEC-020); worker/API logins hold no CREATE on the database or `app` (08 A25 D-201, schema test 30) |
| **Migrations** | runner credentials leak → `lims_migrator` has no BYPASSRLS; secrets in store | malicious migration → C0-only path, CR reference, checklist, scripted checks | git history + PR approvals | seeds with real data → synthetic only, generator-based | long locks → `lock_timeout`, CONCURRENTLY rules | migration grants DELETE on C/B → grant suite fails |
| **Claims resolver** (identity `claimsResolver` → `app.identity_resolve_session`) | JWT minted outside C2's login flow → no session row → 401; session of one kind on another endpoint family → `401 auth.session_expired` | JWT-embedded tenant claims ignored; session-kind binding only from `X-Lims-Bff-Key` / endpoint family, no client header trusted | C2 auth events | DEFINER returns only the row for `(session_id, sub)` | resolver p95 ≤ 3 ms (C2 02-TRD §12) | DEFINER inventoried, EXECUTE to `lims_api` only; no GoTrue hook (08 R10) |
| **Non-staff actors** (partner/portal/patient/device) | non-staff actor gains centre scope → `app.has_all_centres()` false for every non-`user`/`system` type, CHECK `actor_type = 'user' OR NOT all_centres`, scope-row trigger (08 R3) | — | — | every `__tenant` policy has `app.is_staff_or_system()` in the DDL, enforced by `check-registry` and probe step 9 (08 A17 P-16); only `shared_with` tables (C0: `core.event_log`, `core.idempotency_keys`, `audit.access_log`) add actor policies — own-row INSERT, no SELECT except own idempotency rows (08 A23.3) | — | actor-specific policies only where the owner chunk lists them; `device` and `staff_mobile` sessions reach only `/v1/instruments/agent/*` (generated probe, 08 A19.1) |
| **Idempotency store** | replay with another actor's key → PK includes `actor_id`; policy checks actor | body swap under the same key → hash check `422` | — | stored responses (may hold PHI) → RLS by tenant + actor, 7-day purge | key flooding → general rate limit; 64-char keys | — |
| **Outbox / event log / queue** | job inserted for another tenant → `app.enqueue_job` tenant-match check; cron fan-out and tenant dead-letter replay enqueue only inside `withTenantScope(tenant, module system actor)`, never relaxed (08 A23.1, A23.2) | event payload tamper after commit → class A, no UPDATE grant | `event_log` keeps actor, request id 90 days | queue payloads ids only (P1); `event_log` envelope P3 under tenant RLS | event storm → fan-out lag alert; per-tenant general cap upstream | unknown task identifier → registry check |
| **Audit tables** | — | edit/delete history → no UPDATE/DELETE grants, DEFINER-only insert for `audit_log` | the purpose of the asset | `old/new_values` hold P3 → tenant RLS + `audit.log.read` (privileged, C2) | growth → changed-columns-only, measured (R-5) | `lims_app` direct insert to forge history → no INSERT grant (AC-0B-5.3) |
| **Port registry / fakes** | fake in prod returns fabricated data → boot guard, phase-stub allowlist only | — | boot log lists the resolution | fakes contain synthetic data only | — | stub that "allows" → stubs only deny/disable (CR-C0-010) |
| **BFF session** (web core) | session-id guessing → 256-bit random, `__Host-lims_sid` cookie; session state, refresh and expiry are C2's (`resolveSession` + BFF key, 08 R10); spoofed client IP → `X-Forwarded-For` honoured only with a valid BFF key or from `LIMS_CORE_TRUSTED_PROXY_CIDRS` (08 A25 P-61) | CSRF → Origin check, SameSite=Lax, POST-only mutations | session events by C2 | tokens never sent to the browser; no Supabase client in bundles | session store outage → 503, no fallback to client-side tokens | idle/absolute limits enforced server-side |
| **Web shell / UI kit** | — | XSS through patient-entered strings → text nodes only, lint ban, payload corpus | — | PHI in URLs/query → routes UUID-only, POST search; barcodes never logged by the kit | huge tables → virtualisation, cursor pages ≤ 200 | nav hides entries but the API enforces (no client-side authority) |
| **Dev stack** | default Supabase secrets → generator refuses `.env.example` values | — | — | ports exposed on LAN → 127.0.0.1 binds + scan test | — | Studio public → bound to loopback, profile-gated |
| **CI / supply chain** | spoofed branch prefix for path check → CODEOWNERS approval still required | dependency confusion → `@lims/*` scope workspace-only, lockfile | — | secrets in logs → gitleaks, masked CI secrets | — | banned/unsafe deps → gates 12–14 |
| **Codegen / contracts** | — | spec drift from IC → equality tests; generated files diff-checked | git history | examples with real data → synthetic-only review + lint for phone/email shapes in examples | — | a spec declaring `tenant_id`/`status` in a request body → lint rule 7 |

---

## 3. Abuse cases (each becomes a test)

| # | Abuse | Expected result | Test location |
|---|---|---|---|
| AB-1 | Tenant-A user replays a request with tenant B's object id in the path | `404 common.not_found`; no B row touched (DB check as owner in harness) | owner probes (generated manifest), core sample-module probe |
| AB-2 | Tenant-A user adds `"tenant_id": "<B>"` to a body | `400 common.validation_failed` (`common.unknown_field`) | core integration |
| AB-3 | Token re-signed with HS256 using a guessed or public key while ES256 is pinned (or vice versa) | `401 auth.token_invalid` | `core/auth` tests |
| AB-4 | Expired token by 1 s | `401 auth.token_expired` | `core/auth` tests |
| AB-5 | A module handler forgets `assertRole` | dev/ci/staging `500` + `authz_not_asserted`; production metric/alert | authz-guard tests |
| AB-6 | A migration adds a table without RLS, or a policy with `USING (true)` | CI gate 9/10 fails | `check-migrations` fixtures |
| AB-7 | A bulk endpoint receives a mix of A and B ids | per-id `common.not_found` for B ids, no B side effect | probe generator template for `bulk-*` operations |
| AB-8 | Two concurrent requests from different tenants share one PgBouncer server connection | each sees only its own tenant | SP-9 test kept as a permanent CI test |
| AB-9 | Statement without a transaction (raw pool misuse) | impossible from modules (pool not exported); if reached, NULL tenant → zero rows | AC-0B-3.7 |
| AB-10 | `lims_api` calls `graphile_worker.add_job` directly | permission denied (no USAGE on `graphile_worker`) | grant suite |
| AB-11 | Enqueue a job with another tenant's `tenant_id` in the payload | `job_tenant_mismatch` | 0B function test |
| AB-12 | Insert into `audit.audit_log` or update `audit.access_log` as `lims_app` | permission denied | grant suite |
| AB-13 | User with memberships in two tenants logs in | partial global unique index (08 R27) prevents a second staff membership; C2 login refuses; a GoTrue JWT without a C2 session row → `401` at the API | C2 login tests; resolver tests; AC-0D-2.2a |
| AB-14 | Idempotency key reused by a different actor in the same tenant | treated as a new key (actor-scoped); never replays the other actor's response | idempotency tests |
| AB-15 | Production boot with a fake port (other than allowlisted stubs) | boot fails | registry tests |
| AB-16 | Cross-origin form POST to the BFF | `403 auth.csrf_failed` | web core tests |
| AB-17 | XSS payload as a synthetic patient name rendered through every text component | rendered inert as text | kit XSS corpus test |
| AB-18 | Brute force of OTP verify while Redis is down | fail-closed `503`, no unlimited attempts | rate-limit tests |
| AB-19 | Log line containing a synthetic phone number, barcode, OTP or JWT | redacted | logger corpus |
| AB-20 | Spec example contains a Nepali-mobile-shaped number | spec lint fails | lint fixture |
| AB-21 | A module other than core (e.g. `services/api/src/modules/identity/**`) contains SQL naming `core.dead_letters`, or a C2 SQL file grants on it (08 A8.6) | `no-foreign-schema-sql` lint fails; dead letters change only through `ctx.core.deadLetters` | lint fixture (T0A-03); C2 07-SECURITY D-T12 |
| AB-22 | A caller reads dead letters expecting the job payload (08 A8.5) | `ctx.core.deadLetters.list` returns `DeadLetterRow` without `job_payload`; for a platform-row replay, `app.dl_resolve` hands `job_payload` to core only, which strips it and re-enqueues it (08 A10.1) | AC-0D-5.9, AC-0D-5.13 tests |
| AB-23 | A SECURITY DEFINER silently sees no rows because FORCE RLS applies to its owner and no `owner_only` policy admits them, e.g. `app.is_platform_actor()` always false, or a purge deleting nothing; or a test hides this by disabling RLS on a stand-in table (08 A10.5) | narrow `<table>__<cmd>__owner_only` policy `TO lims_owner` per touched table and command (`05-SCHEMA.md` §4.3 rule and audit); contract tests run with FORCE RLS on; static check forbids disabling RLS in tests | AC-0B-2.4; `05-SCHEMA.md` §10 schema tests 13–17 (GUC-bound policies: expected rows, nothing for `lims_app` setting the GUC, GUC `''` after return, 08 A12.7; purge policies gated on `app.maintenance`, 08 A15.3) and 21 (`app.is_platform_actor()` created in C0 before its referencing policies, granted to `lims_app`, 08 A15.6) |
| AB-25 | A bridge-agent device token or `staff_mobile` session calls a staff or patient route outside `/v1/instruments/agent/*` (08 A19.1) | `401`/`403` | generated device-boundary probe (`02-TRD.md` §5.3; T0C-09) |
| AB-26 | A request without a BFF key, from a peer outside `LIMS_CORE_TRUSTED_PROXY_CIDRS`, sends `X-Forwarded-For: <victim IP>` to steer per-IP limits (08 A25 P-61) | header ignored; `ctx.clientIp` = TCP peer | AC-0D-2.5 |
| AB-27 | Patient/partner/portal claims select `core.event_log`, `audit.access_log`, `core.tenants`, or insert an event/access row under another actor id or tenant (08 A23.3) | 0 rows; `42501` → 404 | `05-SCHEMA.md` §10 schema test 24; probe step 9 |
| AB-28 | Platform operator replays a tenant dead letter to enqueue a job outside the tenant's scope, or a cron tick enqueues for an `offboarded` tenant (08 A23.1, A23.2) | `job_tenant_mismatch` without the scope; offboarded/provisioning tenants never listed | schema tests 22–23; AC-0D-5.14/5.15 |
| AB-24 | A change to an audited row is not recorded because its `app.tg_row_audit` trigger has no arguments: `TG_ARGV` is NULL, so `jsonb - NULL` and `key <> ALL (NULL)` give NULL and every UPDATE looks like a no-op (08 A15.5) | excluded-column list `coalesce(TG_ARGV::text[], '{}')`; an UPDATE writes one audit row with the changed columns, INSERT/DELETE rows carry `new_values` / `old_values` | `05-SCHEMA.md` §10 schema test 20 |

---

## 4. Required security tests (summary checklist for the chunk gate)

- [ ] Isolation probes for **every** tenant table C0 creates or translates (select/insert/update/delete/FK/no-claims/centre) — `db/tests/isolation`.
- [ ] Cross-tenant probe for **every** operation in every spec — coverage gate (owner probes + generator), including `core.yaml` (public health endpoints return no tenant data).
- [ ] Centre-scoping tests: a centre-scoped actor cannot see another centre's rows on every centre-scoped table, **and** a positive test that it can see its own (R-14).
- [ ] Privilege-escalation tests: `lims_api`/`lims_worker` cannot `SET ROLE` to `lims_owner`/`lims_queue`(api)/`lims_reporting_lookup`; no `lims_%` BYPASSRLS/superuser; `rolreplication` only `lims_replicator`/`lims_audit_ship`; `lims_audit_ship` reads 0 rows via SQL; no privilege for `supabase_auth_admin` in `app`; `role_permissions` rejects `platform.*`; a centre-scoped membership cannot widen itself (C2 logic, but `membership_centres` insert WITH CHECK stays tenant-bound — probe).
- [ ] DEFINER inventory equality + `search_path` check.
- [ ] DEFINER owner policies (08 A10.5; AC-0B-2.4; `05-SCHEMA.md` §4.3, §10 schema tests 13 and 15): every inventoried DEFINER that touches a FORCE-RLS table has its `owner_only` policy and a contract test run with FORCE RLS on (`app.is_platform_actor()` true for an active staff row; purges delete their seeded expired rows); no test disables RLS or uses an RLS-less stand-in; the only `USING (true)` policy is `identity.platform_staff__select__owner_only`. GUC-bound owner policies (08 A12, A15; `05-SCHEMA.md` §10 schema tests 15–19, 21): every policy reading `app.pre_*` / `app.maintenance` is `TO lims_owner` only; every purge owner policy is gated on `app.maintenance` = its function's name (no static maintenance policy, 08 A15.3); `app.is_platform_actor()` is C0 DDL created before the policies that reference it, EXECUTE `lims_app` only (08 A15.6); `app.platform_list_tenants` and the C2 pre-tenant lookups return their rows, a `lims_app` session setting the GUC sees nothing, the GUC is `''` after return; `core.tenants` changes in platform context are audited under the tenant's own id; no audit trigger on platform-only tables.
- [ ] Dead letters (08 A8.4–A8.6, A9.1–A9.4; `05-SCHEMA.md` §10 schema tests 7 and 9–12; AC-0D-5.7–5.12): `resolution_note` CHECK 1–500 and stored on discard and (optional) replay; trigger lets only `state`/`resolved_by`/`resolved_at`/`resolution_note`/`version` change; no `job_payload` in `DeadLetterRow`, in `app.dl_list_platform` or in any API response or log; `app.dl_resolve` returns it for `'replayed'` to core only (08 A10.1); `__platform` policies admit only `tenant_id IS NOT NULL` rows (08 A10.4); `app.dl_list_platform` / `app.dl_resolve` see and change no row outside platform context, EXECUTE only `lims_api` (and `app.dl_insert_platform` only `lims_worker`); no `core.dead_letters` SQL outside core (AB-21).
- [ ] Membership lifecycle (08 A3.4; `05-SCHEMA.md` §10 schema tests 1–4): writing `core.memberships.is_active` fails (generated from `status`); a duplicate `invited` membership is rejected; a pending staff invite in one tenant blocks a staff membership in a second tenant (R27).
- [ ] Immutability: every C/B table rejects updates of frozen columns; no DELETE grants on C/B/A.
- [ ] Audit: every audited table writes exactly one audit row per changed row with complete context; writes without claims fail; an argument-less `app.tg_row_audit` trigger audits UPDATEs and records full INSERT/DELETE rows (`coalesce(TG_ARGV::text[], '{}')`, 08 A15.5; `05-SCHEMA.md` §10 schema test 20).
- [ ] JWT matrix (AB-3, AB-4, wrong `iss`/`aud`, missing tenant claims).
- [ ] Idempotency matrix (AC-0D-4.x, AB-14).
- [ ] Rate-limit tiers at boundaries, fail-open/closed behaviour.
- [ ] BFF: cookie flags, CSRF, no tokens/`@supabase/*` in browser bundles, idle/absolute timeout.
- [ ] Logger PHI corpus; DoD §1.8 log scan in integration runs.
- [ ] Spec lint security rules (no PHI path params, no server-authority fields in request bodies, `additionalProperties: false`).
- [ ] Dev stack: loopback-only ports, fresh secrets.
- [ ] Per-tenant billing export/restore isolation (AC-0B-6.4; 04 D16).
- [ ] Review fix pass 2026-11-06 (08 A13–A28): staff guard on every `__tenant` policy and non-staff probe step 9 (P-16, A23.3; schema test 24); device/`staff_mobile` boundary probe (A19.1; AB-25); no standing CREATE (D-201; schema test 30); cron fan-out and tenant replay only under `withTenantScope` (A23.1/A23.2; schema tests 22–23); uncast centre predicate absent (A16.1; schema test 26); NULL-tenant idempotency and audit rules (D-213, D-215; schema tests 27–28); pre-tenant/maintenance GUC tests for `app.cron_tenant_ids`, `app.core_resolve_tenant_code`, `app.identity_tenants_for_email_hmacs` (schema tests 22, 29); maintenance audit and audit-viewer centre clause (A28.5, A28.6; schema tests 32–33); client-IP rule (P-61; AB-26); download helper headers and quarantine (P-2; AC-0D-3.3); CSP `img-src 'self' data:` (A18.1).

---

## 5. PHI handling and logging rules (C0-specific additions to CV §9.2)

1. C0 code never logs request or response bodies, SQL parameters, event payloads, job payloads beyond ids, or stored idempotency responses.
2. `core.event_log.envelope` and `core.idempotency_keys.response_body` may hold P2/P3 data. They are tenant-RLS protected, retained 90 days / 7 days, and never copied to logs or metrics.
3. `audit.audit_log.old_values/new_values` hold P3. Read access is through C2's viewer with the privileged `audit.log.read`. Each read of those columns is itself recorded by C2 in `access_log` (`audit.view` code requested by CR if C2 needs it).
4. Dead-letter `last_error_message_redacted` is passed through the logger scrubber before insert. `job_payload` holds ids only and is never returned by `ctx.core.deadLetters` (`DeadLetterRow`, 08 A8.5); a platform-row replay receives it from `app.dl_resolve` inside core only and passes it only to `app.enqueue_job` (08 A10.1). `resolution_note` holds the operator's discard reason / replay note (1–500 chars, 08 A8.4).
5. Metrics labels never carry patient, order, specimen, barcode or user ids (CV §9.4).
6. Fakes, fixtures, seeds, spec examples, stories and screenshots use only `@lims/test-fixtures` synthetic data (00 §7.5; REQ-SEC-136). The client's sample PDFs never enter the repo (00-README hard rule 2).
7. UI kit: `BarcodeInput`/`useScanCapture` never log or persist values; `FileUpload` never previews untrusted files inline on the app origin (REQ-SEC-085). Files reach browsers only through the API streaming helper `ctx.download.stream` (08 A13 P-2; `Content-Disposition: attachment`, `nosniff`, `no-store`; only re-encoded PNG/JPEG may be inline, D-67); `ctx.storage.signedUrl` never leaves `services/{api,worker}` (no files origin, 08 A14.2).

---

## 6. Secrets used by C0 components

| Secret | Used by | Source | Rotation note |
|---|---|---|---|
| `lims_migrator`, `lims_api`, `lims_worker` DB passwords | runner, API, worker | secret store (C1); dev: `init-secrets` | rotate via `ALTER ROLE … PASSWORD` + redeploy |
| JWT verification key (`LIMS_CORE_JWT_KEY_FILE`) | API core | secret store mount | follows GoTrue key rotation (C1/C2 runbook) |
| Rate-limit HMAC key (`LIMS_CORE_RATELIMIT_KEY_FILE`) | API core | secret store | rotation resets counters (acceptable) |
| BFF keys `LIMS_WEB_BFF_KEY_FILE` (`staff_web`), `LIMS_PARTNER_BFF_KEY_FILE` (`partner`), `LIMS_PORTAL_BFF_KEY_FILE` (`portal`) [CONV names] — listed in `LIMS_CORE_BFF_KEY_FILES` (08 A13 D-32, A19 P-45) | each BFF (its own key, server memory only, never logged or sent to a browser); API core verifies | secret store (C1), file-mounted | C1 runbook, 365 d; core accepts old + new key for one overlap window |
| Storage service credential (`LIMS_CORE_STORAGE_KEY_FILE` [CONV]) | API and worker core storage adapter (`services/{api,worker}/src/core/storage/**`) only (08 R12b) | secret store, file path | with the Storage stack's key rotation (C1) |
| Supabase stack secrets (JWT secret/keys, Postgres superuser password, dashboard credentials, SMTP) | dev stack only (prod: C1) | `init-secrets` (dev), secret store (prod) | REQ-SEC-037 |
| Redis URL (optional) | API core | config | no persistence; no PHI |

No C0 component holds gateway, SMS, WhatsApp or email-relay credentials.

DB privilege note (08 A25 D-201): `lims_queue` and `lims_reporting_lookup` hold CREATE only inside the migration that creates their objects; no standing CREATE remains. If SP-2 shows that Graphile Worker must run its own migrations at worker start, that residual privilege is recorded here and in `services/worker/src/core/DECISIONS.md` (SP-2 outcome).

## 7. Allowlist for privileged-role references (AC-0B-1.3)

The CI grep for `postgres` (as a connection user), `supabase_admin`, `service_role`, `supabase_etl_admin`, `supabase_read_only_user`, and the Supabase secret/service key env names permits matches **only** in:
- `db/bootstrap/**` (provisioning superuser, one-off);
- `tools/devstack/**` (local stack configuration);
- `services/{api,worker}/src/core/storage/**` (the core storage adapter; reads the Storage credential from a file path only — 08 R12b, review C0 #22);
- `packages/test-fixtures/src/gotrue/**` (synthetic user seeding; refuses `LIMS_CORE_ENV=production`);
- `db/migrations/*_storage__*.sql` / Realtime policy files (`TO authenticated` on Supabase-served objects only — IC X9);
- `infra/**` (C1, outside C0's grep scope but listed for completeness).

Any other match fails CI. Adding a path needs a security-relevant CR (program/04 §3.6).
