# Extracted CR sections from every chunk 02-TRD.md (auto-generated 2026-11-06)


# C0-foundation-contracts  (own CRs: 10)

## 17. Change requests raised

Format per `program/04-CHANGE-REQUESTS.md` §2 (abridged; full text is filed as issues at T0-01). Each is designed in these documents **as if accepted**.

**CR-C0-001 — Path ownership listing for C0 sub-paths** · To: doc owner (CM §3) · Type: shared-lib/docs · Blocking: no.
Problem: CM §3 does not list `tools/devstack/`, `tools/lint/`, the service/app package root files (`services/*/package.json`, `services/*/src/main.ts`, `Dockerfile`s, `apps/web/{package.json,next.config.*}`, `apps/web/src/middleware.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/(staff)/layout.tsx`), or a home for staff login routes. Proposed: add these as C0 (split per §1.1 of this TRD), and add `apps/web/src/app/(auth)/**` as C2 for login/MFA pages. Backward compatible: yes. Security impact: none.

**CR-C0-002 — Dependencies in shared packages** · To: doc owner (CM §4) · Type: docs · Blocking: no.
Problem: CM §4 lets a chunk add dependencies "to its own package's package.json", but API/worker modules and web features live inside the shared packages `services/api`, `services/worker`, `apps/web`. Proposed: dependencies for those packages are added by C0-0D on a CR (turnaround per program/04 §3.3); each chunk lists the dependency row in its own TRD. Alternatives: per-module workspace packages (rejected: version drift and Next.js transpile config churn).

**CR-C0-003 — BFF session store contract** · To: C2 · Type: api · Blocking: no (C0 ships an in-memory dev provider).
Problem: CV §6 requires a server-side BFF session lookup holding GoTrue tokens, but no interface or storage owner is defined. Proposed: C0 defines `BffSessionStore` and `TokenRefresher` (§12.1). C2 implements them in `apps/web/src/features/identity/session.provider.ts` with storage in C2's `identity` schema via C2 API endpoints authenticated by a BFF client credential (C2 TRD). Tests: AC-0D-7.2/7.3.

**CR-C0-004 — Platform-operator identity in claims** · To: C2 · Type: port/api · Blocking: no.
Problem: IC/CV define support sessions (`actor_type: 'user'`, `support_session_id`) but not how the core recognises a platform operator outside a tenant (tenant list, platform dead letters). Proposed: platform console handlers run under a support session in a tenant for tenant data. For cross-tenant platform data, they call only the inventoried DEFINER functions (`app.dl_list_platform`, `app.dl_resolve`; C2 may request `app.platform_list_tenants` by CR), after `IdentityPort.assertRole` on a `platform.*` permission. Security: REQ-SEC-063.

**CR-C0-005 — Emission of `auth.session_expired` by the BFF core** · To: doc owner (IC §8) · Type: api · Blocking: no.
Problem: IC §8 lists owner C2; the code that detects idle/absolute expiry lives in C0's web core (CM §3 "BFF session"). Proposed: keep owner C2 (policy), allow emission from `apps/web/src/core/session/policy.ts`. Update the IC §8 note "except `common.*`/`auth.*` emitted by the C0 core" to also cover this one.

**CR-C0-006 — Health endpoint naming exception** · To: doc owner (CV §3) · Type: api · Blocking: no.
Proposed: allow `/v1/core/health/{live,ready}` as a documented exception to plural-resource naming. Alternative `/v1/core/health-checks/...` rejected as unidiomatic for orchestrator probes.

**CR-C0-007 — Extra DB roles `lims_queue` and `lims_auth_hook`** · To: doc owner (CV §5.9) · Type: schema · Blocking: no.
Problem: IC §12 says `app.enqueue_job` is "owned by a role holding the Graphile Worker queue privileges", and the GoTrue hook must read memberships before any tenant context exists. CV §5.9 lists no such roles. Proposed: add `lims_queue` (NOLOGIN, NOBYPASSRLS; owns `graphile_worker` schema and the enqueue/queue-depth DEFINER functions; `lims_worker` is a member) and `lims_auth_hook` (NOLOGIN, NOBYPASSRLS; owns only `app.custom_access_token_hook`; SELECT on 4 core tables restricted by an `__auth_hook` policy). Also extend the CV §3 policy-scope list with `auth_hook` and `owner_only` usage as defined in `05-SCHEMA.md` §4. Security: both roles have no LOGIN, no BYPASSRLS; covered by AC-0B-1.1.

**CR-C0-009 — Tenant accent colour in `TenantSettings`** · To: C2 + doc owner (IC §4.6) · Type: port · Blocking: no (default accent used).
Problem: the design system must stay brand-neutral with a per-tenant accent (C0 scope), but `TenantSettings` has no branding field. Proposed (additive): `readonly branding?: { readonly accentColor?: string /* '#RRGGBB' */ }`. C2 validates the format (`identity.setting_out_of_range` on bad values), and the kit derives accessible variants (`04-UI-UX.md` §1.6). Security: none (not PHI).

**CR-C0-010 — Phase stubs for ports without a Phase-1 owner** · To: doc owner (CV §8.2, IC §4.9–§4.11) · Type: port · Blocking: **yes for the first production deploy** (not for development).
Problem: CV §8.2 fails production boot on any fake, while IC §4.11 says Phase 1 uses the registered QualityPort fake, and SmartReportPort/PaymentProviderPort have no Phase-1 owner. Proposed: the phase-stub mechanism in §9 (explicit allowlist, minimal stubs, separate metric, CI check that removes a stub once its owner exists). Alternatives: owner chunks C9/C14/C15 ship stub modules early (rejected: puts C0-style plumbing into feature chunks and creates fake schemas). Security: stubs only ever deny or disable. Tests: AC-0D-6.2 extended — production boot passes with exactly the allowlisted stubs and fails with any other fake.

**CR-C0-008 — Glossary alignment** · To: doc owner (`program/06-GLOSSARY.md`) · Type: docs · Blocking: no.
Problem: the glossary says `core` table `centres` (Collection centre row) and RLS policies `TO authenticated`. IC §9.1 says `core.collection_centres`, and IC X9 binds policies to `lims_app`. Proposed: fix the glossary to match IC. C0 builds to IC (higher precedence per `00-README.md`).


# C1-infrastructure-ops  (own CRs: 9)

## Change requests raised

```
Title: CR-C1-001: Deploy workflow hooks + self-hosted Nepal runner
From chunk: C1            To owner: C0-0A
Type: shared-lib (CI)     Blocking? partly — T-24 (automated deploys); default: operators run infra/ci/*.sh on ops-1 manually
Problem: .github/ is C0-owned (CM §3); US-20 needs workflows that build on a Nepal runner and call infra/ci/*.sh.
Proposed change: add .github/workflows/deploy-dev.yml, deploy-staging.yml, deploy-prod.yml (thin wrappers:
  runs-on [self-hosted, nepal-ops]; on push main / tags v*; GitHub environments dev/staging/prod with required
  reviewers for prod; steps call infra/ci/build.sh, scan.sh, push.sh, deploy.sh, smoke.sh). Repository settings:
  self-hosted runner never used for pull_request events. CODEOWNERS: C0 owns the files, C1 reviewer required.
Backward compatible: yes. Security: runner isolation per 02-TRD §12.2; no secrets stored in GitHub.
Tests: workflow dry-run on dev; PR from a fork cannot schedule a job on the nepal-ops label.
```
```
Title: CR-C1-002: Ops DB roles + insert-only audit publication
From chunk: C1            To owner: C0-0B
Type: schema              Blocking? yes for T-15 (audit store) and T-12 (standby); default: shipping disabled + alert AuditShippingDisabled; standby built from pgBackRest archive only (restore_command, no streaming)
Problem: 04 D11 requires audit_log/access_log shipped to a separate store; standby and monitoring need dedicated least-privilege roles; db/bootstrap is C0's.
Proposed change (db/bootstrap/00_roles.sql + a migration):
  CREATE ROLE lims_monitor     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'lims_monitor_pw';
  GRANT pg_monitor TO lims_monitor;
  CREATE ROLE lims_replicator  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION NOBYPASSRLS PASSWORD :'lims_replicator_pw';
  CREATE ROLE lims_audit_ship  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION NOBYPASSRLS PASSWORD :'lims_audit_ship_pw';
  GRANT USAGE ON SCHEMA audit, billing TO lims_audit_ship;
  GRANT SELECT ON audit.audit_log, audit.access_log, billing.activity_log TO lims_audit_ship;
  CREATE PUBLICATION lims_audit_ship FOR TABLE audit.audit_log, audit.access_log, billing.activity_log WITH (publish = 'insert');
  CI role assertion: allow rolreplication = true only for lims_replicator and lims_audit_ship; BYPASSRLS/SUPERUSER still forbidden.
  Rule for future migrations: a column added to a published table is announced in the PR so C1's auditstore-drift job runs first.
Backward compatible: yes. Tenant/security impact: lims_audit_ship sees no rows through SQL (FORCE RLS, no policy for it);
  it only decodes WAL for the publication. PHI leaves to the audit store on dr-1 (Nepal, LUKS). REQ-SEC-097, 131.
Tests: role attribute assertions; publication exists with pubinsert = true, pubupdate/pubdelete/pubtruncate = false; T-15 spike.
```
```
Title: CR-C1-003: Bridge-agent health metrics contract
From chunk: C1            To owner: C7 (+ C0-0C to note it in IC §3.16)
Type: api (metrics)       Blocking? no — alert rules ship disabled until c7_metrics_live
Problem: X6 fixes only lims_instruments_agent_state{agent_id,state}; routing alerts to a lab and showing backlog/clock
  needs tenant_id/centre_id labels and the heartbeat fields of IC §3.16 as gauges.
Proposed change: the six series and semantics in 02-TRD §11.2 item 3 (labels tenant_id, centre_id, agent_id[, state|agent_version]);
  all four state series always present per agent (value 0/1); exported by whichever C7 process evaluates heartbeats.
Backward compatible: yes (adds labels to the X6 series). Security: agent ids are device UUIDs; no PHI.
Tests: promtool tests in infra; C7 unit test asserts exposition format and the 0/1 invariant.
```
```
Title: CR-C1-004: Public edge exposure registry (origins + per-operation exposure)
From chunk: C1            To owner: C0-0C (+ C2, C7 confirm their paths)
Type: api                 Blocking? no — default: hand-maintained infra/edge/public-routes.yaml
Problem: nginx must default-deny the API; it needs to know which operations are public (bridge ingest, provider callbacks),
  which BFF routes carry login/recovery (per-IP login limit), and the origin names for api/files.
Proposed change: (1) add origins api {env LIMS_ORIGIN_API, owner C1} and files {env LIMS_ORIGIN_FILES, owner C1} to routes.yaml;
  (2) OpenAPI extension x-edge-exposure: public|internal (default internal) on every operation, spec-lint enforced;
  (3) C7 confirms the ingest path prefix and the device-token header name; (4) C2 lists the BFF login/recovery route paths.
Backward compatible: yes. Security: shrinks public surface (REQ-SEC-099 inventory).
Tests: infra/ci/gen-routes.sh output equals public-routes.yaml; tests/external/routes.py.
```
```
Title: CR-C1-005: Renderer runtime envelope + qpdf sandbox spool contract
From chunk: C1            To owner: C6
Type: port (runtime)      Blocking? no — placeholder renderer container until C6 ships
Problem: S14/R7 isolation is enforced by C1's runtime, but C6 owns the code that runs inside and calls it.
Proposed change: renderer: render_net only, no egress, 1.5 GiB, read-only rootfs + tmpfs /tmp, non-root, cap_drop ALL, default seccomp;
  if Chromium's sandbox needs extra privileges C6 states exactly which in its TRD (C1 then reviews).
  pdf-sandbox: spool protocol in 02-TRD §7.5 (request.json ops, READY marker, status.json); C6's worker task is the only client.
  Portal origin: C6 reserves the path prefix `/status/` for the nginx-served static status page (REQ-SEC-142).
Backward compatible: n/a (new). Security: REQ-SEC-086/087.
Tests: AC-09, AC-10; C6 integration test through the spool.
```
```
Title: CR-C1-006: Non-PHI egress register approval (supply chain + paging)
From chunk: C1            To owner: Founder (B11)
Type: foreign touchpoint  Blocking? partly — default e-mail-only paging; downloads only via ops-1 proxy, logged
Problem: operating the stack needs outbound fetches that carry no PHI: OS package mirrors, container image upstreams
  (Docker Hub/GHCR-class for Supabase/nginx/exporter images), ClamAV signature mirrors, the ACME CA (04 I5 implies it),
  the Git hosting used for source/CI; optional SMS paging of ops via the Nepali SMS aggregator (04 §11 SMS row, no PHI).
Proposed change: approve the register in infra/edge/egress-allowlist.yaml (destinations, purpose, data sent = none beyond
  request metadata); all fetches only from ops-1 through Squid with logging; product hosts have no direct egress except
  worker → provider FQDNs approved under 04 §11 and app-1 → ACME CA.
Tests: egress probe from data-1/app-1/dr-1 to a non-listed host fails.
```
```
Title: CR-C1-007: Licence policy scope for operations tooling
From chunk: C1            To owner: Doc owner (CV §15.2)
Type: shared policy       Blocking? no
Problem: CV §15.2 bans GPL/AGPL/SSPL in shipped code. Required ops tools are GPL/AGPL/MPL: Ansible (GPL-3.0), fail2ban (GPL-2.0+),
  ClamAV (GPL-2.0), Grafana (AGPL-3.0), testssl.sh (GPL-2.0), Squid (GPL-2.0), SOPS (MPL-2.0), rsync (GPL-3.0). fail2ban and
  ClamAV are required by 04 S7 / REQ-SEC-084 themselves.
Proposed change: add to CV §15.2: "Operations tools run unmodified as separate processes on the LIMS provider servers, never linked into,
  vendored into or distributed with product code, are outside 'shipped code'. Modified copies or redistribution need review."
  SSPL/BUSL/RSAL stay banned everywhere (hence Valkey instead of Redis ≥ 8).
Tests: CI licence check treats infra/ tooling list as reviewed.
```
```
Title: CR-C1-008: Runtime hooks for supervision and egress
From chunk: C1            To owner: C0-0D
Type: shared-lib/core     Blocking? no
Problem: (a) the worker has no HTTP listener for a liveness check; (b) outbound provider calls must go through the Squid
  FQDN allowlist; (c) graceful shutdown semantics are needed for rolling deploys.
Proposed change: (a) metrics server on LIMS_CORE_METRICS_PORT also serves GET /health/live (200 when the event loop is
  responsive and the DB pool is usable) in API and worker; (b) the core outbound HTTP client honours LIMS_CORE_EGRESS_PROXY_URL
  (HTTP CONNECT) for every module; (c) on SIGTERM the worker stops taking jobs, finishes in-flight jobs up to
  LIMS_CORE_SHUTDOWN_GRACE_S (default 55) and exits 0; the API stops accepting, drains, exits.
Backward compatible: yes.
Tests: AC-08.1/08.2; egress probe from worker to a non-listed host fails.
```
```
Title: CR-C1-009: Login per-IP limit vs. lab NAT (04 §4)
From chunk: C1            To owner: Doc owner (04 §4)
Type: shared policy       Blocking? no — 04 values are implemented exactly
Problem: 04 §4 sets login 5/min/IP. Twenty collection centres and the hub lab each sit behind one public IP (00 G3); ~60 staff
  starting shifts at 07:00 can exceed 5 logins/min from one IP.
Proposed change: allow tenant-registered static egress IPs (configured by platform admin, audited) to use a separate nginx zone
  (e.g. 30/min/IP) while per-account limits (10/hour/account) and backoff stay unchanged.
Backward compatible: yes (config). Security: per-account limits remain the main brute-force control (REQ-SEC-064).
Tests: ratelimit.py with registered and unregistered IPs.
```


# C2-identity-admin  (own CRs: 17)

## 15. Change requests raised

Each CR follows the `program/04-CHANGE-REQUESTS.md` template; C2 builds as if accepted, against fakes, until merged.

**CR-C2-001: Web route groups for auth pages and platform console**
From C2 → C0-0D · Type ui-kit (path allocation) · Blocking: T12, T20.
Problem: login/MFA/reset pages must render without a session (US-A1–A8); the platform console must not use the tenant staff shell (REQ-SEC-063; US-E*). 01 §3 only allocates `apps/web/src/app/(staff)/<module>/`.
Proposed: allocate `apps/web/src/app/(auth)/auth/**` and `apps/web/src/app/(platform)/platform/**` to C2 in CODEOWNERS; C0 provides `(auth)/layout.tsx`-free shell primitives (C2 owns the layouts inside these groups); remove `(staff)/platform/` from C2's list. URLs unchanged vs `routes.yaml`. Backward compatible: yes. Security: new unauthenticated pages (no data); CSP same as shell.

**CR-C2-002: CI exception — identity repository access to `core` admin tables and `audit` reads**
From C2 → C0-0A (CI) · Type shared-lib/CI · Blocking: T6–T10, T15.
Problem: 01 §3 makes C2 the logic owner of `core` tables and the `audit` viewer, but 02-CV §5.13 CI grep rejects `<other_schema>.` references in `repository/`.
Proposed: allowlist `services/api/src/modules/identity/repository/{core-admin,audit-read}.repo.ts` for `core.{tenants,branches,collection_centres,users,memberships,membership_centres,membership_branches,membership_roles,roles,role_permissions,dead_letters}` (read/write) and `audit.{audit_log,access_log}` (read only). Backward compatible: yes. Security: no new grants beyond §5.9 class rules.

**CR-C2-003: `core` table columns, constraints and inventory functions required by C2** — full list in 05-SCHEMA §3 and §6. To C0-0B · schema · Blocking: T2.

**CR-C2-004: Platform request context**
To C0-0D (API/worker core) + C0-0B · Blocking: T18–T22.
Proposed: (a) C0 core accepts a resolved claims object of `kind: 'platform'` and builds `PlatformRequestContext { actor, requestId, tx, now, platformRole, platformStaffId }` (no `tenantId`, no port registry access); handlers declare `x-context: platform` in the spec; (b) SQL helper `app.is_platform_actor() RETURNS boolean` (DEFINER, `SET search_path=''`): true iff claims `scope ∈ ('platform')` and `platform_staff_id` maps to an active `identity.platform_staff` row and claims `aal = 'aal2'`; (c) `__platform` policies on tables listed in 05-SCHEMA §5.3; (d) `ctx.db.withTenantScope(tx, tenantId, fn)` available only in platform context of module `identity`, which `set_config('request.jwt.claims', <system claims of identity for tenantId>, true)` for the duration of `fn` and restores the platform claims after; every use writes an access-log `tenant_lifecycle`/`support_session` event. Security: new privileged context; inventory + probes required (07-SECURITY T-P*).

**CR-C2-005: Claims-resolver extension point and identity DEFINER functions**
To C0-0D + C0-0B · Blocking: T3, T4.
Proposed: `ModuleManifest.claimsResolver?: ClaimsResolver` (§6.1), accepted only from module `identity`; core auth step 2 (02-CV §6) calls it for `actor_type` user JWTs and uses the returned claims JSON for `set_config`; device/portal paths unchanged. Functions `app.identity_resolve_session`, `app.identity_login_context`, `app.identity_session_by_token`, `app.identity_record_auth_event`, `app.identity_user_exists`, `app.identity_bootstrap_platform_admin` per 05-SCHEMA §6, added to the DEFINER inventory (04 D7).

**CR-C2-006: Permission registry additions** (`contracts/permissions.yaml`) To C0-0C.
```yaml
  - { code: audit.log.export,     privileged: true,  roles: [tenant_admin] }      # insider-export control (02 failure mode #10)
  - { code: identity.self.manage, privileged: false, roles: [tenant_admin, front_desk, finance, lab_technologist, pathologist, lab_manager, centre_staff, phlebotomist, owner_viewer] }
  - { code: platform.staff.manage, privileged: true, roles: [platform_superadmin] }
```

**CR-C2-007: Error-code additions** (`contracts/errors.yaml`) To C0-0C.
```yaml
- { code: identity.code_duplicate,          http: 409, owner: C2, title: "Code already used", meaning: "Tenant/branch/centre/role code not unique in scope" }
- { code: identity.self_action_forbidden,   http: 409, owner: C2, title: "Not allowed on your own account", meaning: "Lock/deactivate/revoke-current/MFA-reset of self" }
- { code: identity.tenant_not_ready,        http: 409, owner: C2, title: "Tenant not ready", meaning: "Activation needs an accepted admin, a branch and a centre" }
- { code: identity.annex_invalid_transition, http: 409, owner: C2, title: "IRD annex status change not allowed", meaning: "03-APP-FLOW §2.5" }
- { code: identity.export_too_large,        http: 422, owner: C2, title: "Export range too large", meaning: "Range > 31 days or > 500,000 rows" }
- { code: identity.platform_ip_denied,      http: 403, owner: C2, title: "Access not allowed from this network", meaning: "Platform staff IP allowlist (REQ-SEC-063)" }
```

**CR-C2-008: `IdentityPort.TenantSettings` additive fields** (C2 owns the port; C0-0C transcribes; consumers C4, C6, C8, C14 may use).
```ts
readonly branding: { readonly legalName: string; readonly displayName: string; readonly addressText?: string; readonly contactPhone?: string;
  readonly contactEmail?: string; readonly website?: string; readonly logoRef?: string; readonly letterheadHeaderRef?: string; readonly letterheadFooterRef?: string };
readonly retention: { readonly clinicalYears: number; readonly auditYears: number; readonly rawInstrumentYears: number };  // floors 5/5/1 (04 I8, B15); retentionYears = clinicalYears
readonly featureFlags: Readonly<Record<string, boolean>>;    // codes from identity.g_feature_flags
// inside ird:
readonly annexReadiness: 'complete' | 'incomplete';          // tracking-derived, not a legal determination
// inside numbering:
readonly receiptNoPattern: string;                           // 03 §9.3 lists receipt_no (owner C4) but TenantSettings.numbering lacks it
```
Backward compatible: yes (new keys). Fake must return defaults.

**CR-C2-009: BFF session integration contract** To C0-0D (web core).
Proposed: cookie `__Host-lims_sid` (§4); `bffSession` security scheme = that cookie, forwarded server-to-server by the BFF only; BFF core calls `resolveSession` (cache ≤ 60 s, `touch` true for user-initiated requests, false when the browser request carries `X-Lims-Background: 1`, which `@lims/ui` polling/SSE helpers set); on `401 auth.session_expired` → redirect `/auth/session-expired`; on states `mfa_pending`/`mfa_enrolment_required`/`password_setup` → redirect to the matching `/auth/*` page; `(platform)` layout requires `session.kind = 'platform'`; `(staff)` layout rejects platform sessions without an active support session; logout clears cookie after `logoutSession`. Shell shows the support-session banner from `SessionState.actor.support_session`.

**CR-C2-010: `audit` tables — columns, indexes, RLS and access-event types needed by the viewer** To C0-0B. Columns/indexes in 05-SCHEMA §3.3; RLS `__select__tenant` (tenant_id match; centre predicate `centre_id IS NULL OR has_all_centres() OR centre_id = ANY(current_centre_ids())`); `ctx.audit.access` accepts the event types listed in §9.

**CR-C2-011: Shared upload pipeline + storage adapter** To C0-0A. `ctx.uploads.accept({ file, allow: ['image/png','image/jpeg'(,'application/pdf')], maxBytes, reencodeImages: true, scan: true, bucket, path })` implementing 02-CV §10.2 (magic bytes, re-encode, ClamAV-class scan, quarantine) and `ctx.storage.read/write` via server-side credentials; also needed by C4 (TRF) and C6 (outsourced PDFs).

**CR-C2-012: Infra rules for identity** To C1. GoTrue port reachable only from the API network; `/v1/identity/auth/*` reachable only from the BFF network (nginx deny for public origin); per-IP `limit_req` 5/min on `/v1/identity/auth/login` and `/v1/identity/auth/password/recover` (04 §4); GoTrue SMTP via the transactional relay (REQ-ARCH-018) with link-only templates pointing at `{staff_web}/auth/confirm?token_hash=…&type=…`; exclude query strings of `/auth/confirm` from nginx access logs (token is a secret, like `/r/` and `/v/` routes in routes.yaml); GoTrue recovery/invite link TTL ≤ 60 min (04 A12); refresh-token rotation + reuse detection on (04 A6); buckets `tenant-assets` and `exports` private (with C0-0B policies).

**CR-C2-013: System-actor permission lookup** To C0-0D. Expose `ctx.core.systemActorPermissions(actorId): readonly PermissionCode[]` built from worker manifests (02-CV §2.3, 03 §11 `system:` row) so `IdentityPort` can authorise system actors.

**CR-C2-014: Service-role key use by the identity GoTrue adapter** To C0 (audited module list, 02-CV §10.2; REQ-SEC-029/030). Only `services/api/src/modules/identity/gotrue/gateway.http.ts` may read `LIMS_IDENTITY_GOTRUE_SERVICE_KEY`; it is sent only to the internal GoTrue URL, never used for PostgREST or DB; CI grep enforces.

**CR-C2-015: Glossary table-name fix** To doc owner. `06-GLOSSARY.md` "Collection centre" row says `core` table `centres`; 02-CV §5.3 and 03 §9.1 say `core.collection_centres`. C2 uses `core.collection_centres`.

**CR-C2-016: UI-kit components** To C0-0D — list in 04-UI-UX §2.2.

**CR-C2-017: Exceptions to "tenant_id leads every index/unique constraint"** To C0-0B (02-CV §5.3 rule; REQ-SEC-023). Requested global unique indexes: `identity.sessions(token_sha256)`, `identity.sessions(gotrue_session_id)`, partial `core.memberships(user_id) WHERE actor_type = 'user'`. Justification: pre-tenant lookups through inventoried DEFINER functions only; values are 256-bit random hashes or a one-tenant-per-user invariant (02-CV §6); no client-reachable query exposes a uniqueness violation across tenants (invite collisions return the generic `identity.user_exists`, 07-SECURITY A-6). Tenant-leading secondary indexes are also present. Also `UNIQUE NULLS NOT DISTINCT (tenant_id, …)` on tables with platform rows (PostgreSQL 15+ feature; PG 17 per 04 D9).


# C3-catalog-pricing  (own CRs: 6)

## 15. Change requests raised

All are designed as if accepted. Template per `program/04-CHANGE-REQUESTS.md` §2.

### CR-C3-001 — CatalogPort V1 additive fields and three methods
```
Title: CR-C3-001: CatalogPort additive fields + getReferrer/getCreditParty/resolveCommentCodes
From chunk: C3            To owner: C0-0C (C3 implements; consumers C4, C5, C6 must acknowledge)
Type: port
Blocking? no (C3 implements behind the V1 interface once merged; consumers keep working without the new fields)
Problem: (a) C6 must print "Referred By" and NotificationPort must reach the referrer/centre/credit party
  (03-IC §4.8 "resolves contact details … via … catalog doctors") — CatalogPort has no referrer/credit-party read.
  (b) C5 must expand comment short codes server-side and store code+version+text (C5 AC-10.2; CR-C5-001 asks for
  the same method). (c) C5 cannot tell a text-only "Biological Ref Range" (Mentzer "<13.0 - Thalassemia trait /
  >13.0 - Iron deficiency") from a numeric one, nor know ordinal normal codes (urine "Negative") → PRD AC-05.5/05.6.
  (d) Age bands at an exact birthday need calendar age (AC-05.2). (e) C4 needs the VAT rate and extra-tax rate/HS
  code as data (04 L14/L25/L10; 07-BLOCKERS B7 "tax rules are data"). (f) C6 needs the "Specimen:" label (00 §4).
Proposed change (exact): the TypeScript in 02-TRD §6.1 (all new fields optional; three new methods; fakes gain the
  same seeded data: one merged doctor, one credit party with allowsCredit=false, comment codes in two scopes).
Backward compatible? yes — optional fields + new methods; CATALOG_PORT_VERSION stays 1.
Tenant/security impact: contact fields are P2 personal data of doctors/parties; returned only for
  purpose 'notification' (REQ-SEC-081); calls counted (REQ-SEC-045). No patient PHI.
Alternatives considered: consumers calling C3 HTTP from server code (breaks in-transaction port rule 02-CV §8.1);
  a v_pub view for doctors (views are for reporting reads only, 01-CM §5).
Tests that will prove it: contract cases 14–23 in 02-TRD §14.
```

### CR-C3-002 — Shared formula parser/evaluator (`@lims/shared-ts/formula`) — same need as CR-C5-002
```
Title: CR-C3-002: @lims/shared-ts/formula implementing the C3 grammar (02-TRD §7.1) + golden vectors
From chunk: C3 (co-requested by C5 as CR-C5-002)   To owner: C0-0A
Type: shared-lib
Blocking? yes — C3 task T-11 (formula validation) and C5 formula evaluation
Problem: formulas are stored in the catalog (01 §2.2) and validated by C3 but evaluated by C5; one grammar must be
  implemented once (02-CV: no copy-paste across chunks; packages/* are C0's).
Proposed change: package export `parseFormula(text) → {ast, refs, contextVars, errors}`,
  `evaluateFormula(ast, inputs: Record<Code, DecimalString|undefined>, ctx:{ageDays, ageYears, sex}) →
  {value: DecimalString} | {notComputable: reason}`, `formulaRefs(ast)`; decimal library pinned by C0;
  vectors G1–G10 as packages/fakes/contract-tests/formula.vectors.json (C3 and C5 both run them).
Backward compatible? yes (new module).
Tenant/security impact: pure function; no IO; DoS guarded by length/depth limits in the grammar.
Alternatives considered: each chunk implements its own parser (divergence risk; banned).
Tests: vectors G1–G10 + fuzz (random token strings never throw outside {errors}).
```

### CR-C3-003 — Registry additions: permissions, error codes, event entity types
```
Title: CR-C3-003: catalog permissions (3), error codes (3), catalog.changed.v1 entity_type values (4)
From chunk: C3            To owner: C0-0C (permissions.yaml, errors.yaml, events schema)
Type: api + event
Blocking? no (interim behaviour described below)
Proposed change:
  permissions.yaml:
    - { code: catalog.referrer.read,          privileged: false, roles: [tenant_admin, lab_manager, front_desk, finance, centre_staff] }
    - { code: catalog.reference_range.publish, privileged: true, roles: [pathologist, lab_manager] }   # clinical sign-off
    - { code: catalog.referrer.export,        privileged: true,  roles: [tenant_admin, lab_manager] }  # doctors' contacts (04 A4 data export)
  errors.yaml:
    - { code: catalog.tax_config_missing,     http: 422, owner: C3, title: "Tax configuration missing", meaning: "No tenant-default tax rule (04 L15/L25, B7)" }
    - { code: catalog.import_not_committable, http: 409, owner: C3, title: "Import cannot be committed", meaning: "Not in validated state, expired, or already committed" }
    - { code: catalog.import_stale_base,      http: 409, owner: C3, title: "Price list changed since export", meaning: "Base version superseded; resend with accept_stale_base" }
  catalog.changed.v1 payload entity_type enum: add "method", "unit", "value_set", "tax_rule".
Backward compatible? permissions/errors: additive. Event enum: adding values is a payload change consumers
  validate leniently (02-CV §7.2) — C0 decides whether this needs .v2; interim mapping in 02-TRD §9.1 is used until merged.
Interim (before merge): referrer reads use catalog.referrer.manage; range/critical publish and retire use
  catalog.test.manage only (known gap G-1, 07-SECURITY §7); referrer export uses catalog.price_list.manage
  (privileged); new error situations return common.validation_failed (422) / common.version_conflict (409)
  with a safeDetail naming the situation.
Tests: permission matrix tests per role; error-code tests per x-error-codes.
```

### CR-C3-004 — Published view column addition
```
Title: CR-C3-004: add canonical_referrer_id to catalog.v_pub_referrer_directory
From chunk: C3            To owner: C0-0B (C8 acknowledges)
Type: schema
Blocking? no
Problem: merged duplicate doctors (quick-add duplicates, 06-GLOSSARY Referring doctor) must roll up in C8's
  "which doctor sends the most patients" (00 F3); orders keep the original referrer id.
Proposed change: column canonical_referrer_id uuid (= id when not merged) appended (05-SCHEMA §6).
Backward compatible? yes (additive column).
Tenant/security impact: none (ids only).
Tests: view returns survivor id for merged rows; RLS via security_invoker.
```

### CR-C3-005 — Core upload handling for `.xlsx` and optional malware-scan hook
```
Title: CR-C3-005: core multipart support + xlsx content type for catalog imports + ctx.files.scan hook
From chunk: C3            To owner: C0-0D (runtime core) — security-relevant (04-CR §3.6)
Type: shared-lib/core
Blocking? partly — T-20 (createImport) needs multipart parsing in the API core
Problem: 02-CV §10.2 upload allowlist covers pdf/jpeg/png only; 00 E4 requires uploading Excel.
Proposed change: (1) core multipart parser with per-route size cap (catalog: 15 MB) exposing the file as a Buffer
  to the handler, never written to disk; (2) per-route content-type allowlist; catalog import route allows
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (+ application/octet-stream sent by some
  browsers, accepted only with .xlsx extension and ZIP magic bytes — C3 checks both); (3) optional
  ctx.files.scan(buffer) → {clean|infected|unavailable} backed by the ClamAV-class scanner of REQ-SEC-084 if C1
  deploys one; (4) streaming file response helper with Content-Disposition: attachment, nosniff, no-store.
Backward compatible? yes.
Tenant/security impact: new upload surface (REQ-SEC-083/084/085/087); original upload never re-served (D-C3-05);
  parsing only in worker with limits (02-TRD §8.4).
Tests: EICAR-in-zip fixture → quarantined when scanner present; 16 MB → 413; .xlsm → rejected; polyglot → rejected.
```

### CR-C3-006 — UI-kit components
```
Title: CR-C3-006: @lims/ui components needed by catalog screens
From chunk: C3            To owner: C0-0D
Type: ui-kit
Blocking? yes for T-30+ (screens); no for API tasks
Problem: no component inventory of @lims/ui is published yet; 02-CV §14 forbids local look-alikes.
Proposed change: the component list in 04-UI-UX §2 (names proposed; C0 may rename — C3 adapts).
Backward compatible? yes.
Tests: C0 storybook/a11y tests; C3 screen tests use them.
```

**Note on CR-C3-003 interim:** borrowing another privileged permission (e.g. `catalog.price_list.manage`) to force aal2 on range publication was rejected because it would let finance users publish clinical ranges. The interim is `catalog.test.manage` only, recorded as gap G-1 in 07-SECURITY §7.


# C4-frontdesk-billing  (own CRs: 13)

## Change requests raised

All filed with labels `cr`, `from:C4`. Designed as if accepted; the fake/default used meanwhile is stated.

```
Title: CR-C4-001: Add C4-internal BillingCommandPort to contracts/ports
From chunk: C4            To owner: C0-0C
Type: port
Blocking? yes — FD-T05 (registration) needs the interface + fake; BL-T07 implements it
Problem: frontdesk and billing are separate modules (01 §8 risk 4) and may not import each other (02-CV §1.3 lint);
  registration must write both schemas in one transaction (PRD US-FD-03 AC1).
Proposed change: contracts/ports/BillingCommandPort.ts exactly as 02-TRD §6.3; PortRegistry gains
  `BillingCommandPort`; fake in packages/fakes with the 11 contract cases; consumer allowlist = frontdesk only.
Backward compatible? yes (new port)
Tenant/security impact: none new; runs in caller's tx under RLS
IRD/regulatory impact: implements 04 L5, L7, L26 paths
Alternatives considered: one merged module (blocks parallel build); HTTP between modules (loses atomicity).
Tests: contract suite §6.3.
```
```
Title: CR-C4-002: CatalogPort.getReferrer and CatalogPort.getCreditParty
From chunk: C4            To owner: C0-0C (implementing chunk C3 must agree)
Type: port   Blocking? no (fake returns seeded ids)
Problem: registration must validate referrer/credit-party ids server-side (REQ-SEC-046 spirit) and snapshot the
  display name/PAN for receipts and periodic invoices; no CatalogPort method exists; v_pub views are for reporting only (01 §5).
Proposed: getReferrer(ctx,{referrerId}) → {id, code, displayName, isActive};
          getCreditParty(ctx,{creditPartyId}) → {id, code, displayName, pan?, addressText?, isActive}; @throws common.not_found
Backward compatible? yes (additive)   Security: P0 master data
```
```
Title: CR-C4-003: Item-level processing status for order-item removal guard
From chunk: C4            To owner: C0-0C (C5 must agree)
Type: port   Blocking? no — default: conservative guard (no removal once any specimen of the order is received)
Problem: 03-IC §3.2 allows removing an item while its own specimens are not received and results not resulted;
  OrderResults (LabPort) has no item→specimen link and needs lab.result.read, which front_desk lacks.
Proposed: LabPort.getOrderItemProcessingState(ctx,{orderId}) → [{orderItemId, removable: boolean, reasonCode?}]
  callable by actors holding frontdesk.order.edit. Backward compatible: yes.
```
```
Title: CR-C4-004: RenderPort for non-report PDFs + path ownership services/renderer/templates/billing/
From chunk: C4            To owner: C0-0C + C6 + doc owner (01 §3 path table)
Type: port   Blocking? no — exports ship XML (and XLSX after BL-T19); PDF via fake until accepted
Problem: 04 L26 cl.6(ठ) requires PDF export; the only PDF engine is C6's renderer (04 S14); no port exposes it.
Proposed: RenderPort.renderPdf(ctx,{templateKey: 'billing.invoice'|'billing.credit_note'|'billing.register',
  data: Record<string, unknown>}) → {bucket, objectPath, sha256}; C4 owns templates under
  services/renderer/templates/billing/ (precedent: C14 owns templates/smart/). Backward compatible: yes.
Security: renderer rules REQ-SEC-086 unchanged (bundled assets only).
```
```
Title: CR-C4-005: Shared upload pipeline + storage helper for module code; buckets `trf`, `billing-exports`
From chunk: C4            To owner: C0-0D (core) + C0-0B (storage policies) + C1 (scanner service)
Type: shared-lib/schema   Blocking? FD-T10 partially — default: in-module fake scanner/storage
Problem: 02-CV §10.2 mandates magic-byte checks, 15 MB cap, ClamAV-class scan + quarantine, sanitise, signed URLs,
  `{tenant_id}/…` paths, but no core API exists; C4 (TRF) and C6 (outsourced PDFs) would otherwise each build one.
  Storage RLS with self-hosted claims is UNVERIFIED (04 D3) — probes required before PHI.
Proposed: ctx.uploads.accept(stream,{allowlist,maxBytes}) → {sha256,mime,size}; ctx.storage.put/move/signedUrl(bucket,path,ttl);
  scanner adapter interface; private buckets `trf` and `billing-exports` with first-segment tenant policies.
```
```
Title: CR-C4-006: Optional partnerId on BookingOrderInput
From chunk: C4            To owner: C0-0C (C13 must agree)
Type: port   Blocking? no — v_pub_order_status.partner_id is NULL until accepted
Problem: frontdesk.v_pub_order_status has column partner_id (03-IC §6.1) but createOrderFromBooking carries no partner.
Proposed: BookingOrderInput.partnerId?: Uuidv7 (required when source = 'partner_manifest'). Additive.
```
```
Title: CR-C4-007: New error codes
From chunk: C4            To owner: C0-0C
Type: api   Blocking? no (tests use the codes; C0 adds to errors.yaml)
Proposed entries:
- { code: billing.tax_config_missing, http: 422, owner: C4, title: "Tax rate not configured", meaning: "Orderable has a tax code without an active tenant rate (B7)" }
- { code: billing.credit_period_already_billed, http: 409, owner: C4, title: "Credit period already billed", meaning: "No uninvoiced charges for the credit party and month" }
- { code: frontdesk.discount_self_approval_forbidden, http: 403, owner: C4, title: "Requester cannot approve own discount", meaning: "Segregation of duties (00 A8)" }
- { code: frontdesk.retention_not_elapsed, http: 409, owner: C4, title: "Retention period not elapsed", meaning: "Anonymisation before tenant retentionYears (B15)" }
```
```
Title: CR-C4-008: New permission codes
From chunk: C4            To owner: C0-0C (contracts/permissions.yaml)
Type: api   Blocking? no
Proposed:
- { code: frontdesk.settings.manage, privileged: true, roles: [tenant_admin] }
- { code: billing.settings.manage,   privileged: true, roles: [tenant_admin, finance] }   # tax codes, series scope, CBMS retry
- { code: frontdesk.patient.anonymise, privileged: true, roles: [tenant_admin] }       # 02-CV §5.6, REQ-SEC-139
```
```
Title: CR-C4-009: TenantSettings.letterhead block in IdentityPort
From chunk: C4            To owner: C0-0C (C2 must agree)
Type: port (additive)   Blocking? no — fake letterhead
Problem: 00 A12 bill receipt with letterhead; C2 owns letterhead settings (01 §2) but TenantSettings exposes only letterheadDefault.
Proposed: letterhead: { legalName: string; addressLines: readonly string[]; phones: readonly string[]; logoAssetRef?: string;
  footerNote?: string } — logo served as a bundled/allowlisted asset (REQ-SEC-086).
```
```
Title: CR-C4-010: C5 HTTP operation to print labels for an order
From chunk: C4            To owner: C5 (+ C0-0C)
Type: api   Blocking? no — MSW mock
Problem: 00 B1 "print barcode sticker automatically"; labels are C5's (01 §2); C4's registration page must trigger it.
Proposed: C5 defines the operation (suggested POST /v1/lab/orders/{order_id}/label-prints, x-permission
  lab.specimen.label_print, idempotency required, 202 with per-specimen outcome; 409 when specimens not yet created so
  the caller retries). C4 calls it only after `frontdesk.order.created.v1` has committed.
```
```
Title: CR-C4-011: NotificationPort templates for C4 purposes
From chunk: C4            To owner: C6
Type: api/data   Blocking? no — fake template registry
Proposed templates (non-PHI params only, 04 R6, REQ-SEC-070):
- frontdesk.registration_confirmation (purpose registration_confirmation; params: lab_name, registered_time_hhmm)
- frontdesk.recollection_request (purpose recollection_request; params: lab_name, centre_phone)
```
```
Title: CR-C4-012: Clarify 02-CV §4.7 "amount_paisa (for payments)" for manual ledger entries
From chunk: C4            To owner: doc owner (02-CONVENTIONS)
Type: docs   Blocking? no
Problem: 04 P1 says ledger entries are recorded by the operator (amount received is a fact the cashier enters);
  02-CV §4.7 bans client amount_paisa "for payments". C4 reads the ban as applying to amounts the server is the
  authority for (gateway intents, prices, dues) and accepts `amount_received_paisa` on manual entries, validated ≤ due.
Proposed: add that sentence to 02-CV §4.7.
```
```
Title: CR-C4-013: UI kit components needed by C4
From chunk: C4            To owner: C0-0D
Type: ui-kit   Blocking? FD-T12/BL-T15 UI tasks use placeholders from @lims/ui if absent
Proposed (confirm existing names or add): MoneyInput, MoneyText, DualDate (B.S. + A.D.), AsyncCombobox,
  DataTable (cursor pagination, keyboard row nav), FileDropzone (scan-state aware), StatusBadge, ShortcutHint,
  ConfirmDialog with reason select, PrintFrame (print-only iframe with @media print). Full list in 04-UI-UX §2.
```


# C5-lab-workflow  (own CRs: 9)

## 15. Change requests raised

Template per `program/04-CHANGE-REQUESTS.md` §2. All designed as if accepted.

### CR-C5-001: `CatalogPort.resolveCommentCodes`
- From C5 → C0-0C (port) + C3 (implements). Type: port. Blocking: no (fake) — task T-18.
- Problem: US-10 (AC-10.1/10.2) — C5 must expand short codes server-side and store the library text; `CatalogPort` has no comment-code method; `catalog.changed.v1` already lists `comment_code`.
- Proposed: `resolveCommentCodes(ctx, input: { codes: readonly Code[]; asOf?: IsoUtc }): Promise<readonly { code: Code; text: string; version: number; isActive: boolean }[]>` — unknown codes omitted; plus `searchCommentCodes(ctx, { prefix: string; limit?: number })` for the UI picker. Fake: seeded codes incl. `HYPO`, `ANISO`. Contract tests: unknown omitted; inactive returned with `isActive false`; asOf returns older text.
- Backward compatible: yes (additive). Security: P0 (no PHI).

### CR-C5-002: Shared formula grammar + rational decimal in `@lims/shared-ts`
- From C5 → C0-0A (shared-lib); C3 must validate with the same parser. Type: shared-lib. Blocking: no (C5 keeps a local copy in `domain/formula/` until merged).
- Problem: US-09 — `AnalyteDefinition.formula.expression` has no defined grammar; C3 validates (`catalog.formula_invalid`) and C5 evaluates; two grammars would diverge.
- Proposed: `@lims/shared-ts/formula` (`parse`, `validate(expr, inputCodes)`, `evaluate(ast, inputs: Record<Code, DecimalString>) → { ok, value: Rational, inexact } | { ok: false, reason }`) with the grammar in §4.4 and `@lims/shared-ts/decimal` (BigInt rational, half-up rounding). Golden tests shared.
- Backward compatible: yes.

### CR-C5-003: FrontdeskPort purposes and batch read
- From C5 → C0-0C + C4. Type: port. Blocking: no.
- Problem: C5 needs sex/age for range and critical evaluation (US-12/13) and names on worklists/status board (US-07/18); existing purposes do not describe these uses (`instrument_host_query` has the right fields but the wrong purpose; REQ-SEC-081 purpose binding).
- Proposed: add `DemographicsPurpose` values `result_evaluation` (sex, ageAtOrder, birthOn) and `lab_display` (fullName, sex, ageAtOrder, patientCode); add `getPatientDemographicsBatch(ctx, { patientIds: readonly Uuidv7[] /* ≤200 */; purpose }): Promise<readonly PatientDemographics[]>` (missing/invisible ids omitted). Fake + contract tests: field allowlist per purpose; cross-tenant ids omitted.
- Backward compatible: yes (enum extension + new method). Security: PHI P2 returned only for authorised purposes.

### CR-C5-004: Permission codes
- From C5 → C0-0C (`contracts/permissions.yaml`). Type: api. Blocking: no (fake IdentityPort accepts configured codes).
- Proposed entries:
  - `{ code: lab.worksheet.manage, privileged: false, roles: [lab_technologist, lab_manager] }` — create worksheets (US-07).
  - `{ code: lab.config.manage, privileged: true, roles: [lab_manager, pathologist] }` — lab settings, delta rules, coded sets (US-12, IS-27).
  - `{ code: lab.qc_hold.release, privileged: true, roles: [lab_manager, pathologist] }` — release QC holds (IS-23).
- Security: privileged entries require aal2 (04 A4).

### CR-C5-005: Error codes
- From C5 → C0-0C (`contracts/errors.yaml`). Type: api.
- `{ code: lab.barcode_pattern_invalid, http: 500, owner: C5, title: "Barcode numbering configuration invalid", meaning: "Rendered barcode violates [A-Z0-9]{1,20} or counter overflow" }`
- `{ code: lab.specimen_inactive, http: 409, owner: C5, title: "Specimen inactive", meaning: "Order cancelled or test removed; specimen not usable" }`
- `{ code: lab.flag_ack_required, http: 409, owner: C5, title: "Flag acknowledgement required", meaning: "Delta/critical/unit/instrument flag must be acknowledged before verification" }`

### CR-C5-006: `reporting.report.released.v1` optional `order_item_ids`
- From C5 → C0-0C + C6 (producer agrees). Type: event (additive optional field).
- Problem: S10 (03-IC §10.1) needs to know which order items a **partial** release covers; the payload has no item list (AC-18.3).
- Proposed: `"order_item_ids": { "type": "array", "maxItems": 200, "items": Uuidv7 }` optional. Until merged: partial releases do not move specimens to `reported`.

### CR-C5-007: Routes
- From C5 → C0-0C (`contracts/routes.yaml`). Type: api.
- `- { id: staff.lab.order_labels, origin: staff_web, path: /lab/orders/{order_id}/labels, owner: C5, permission: lab.specimen.label_print }` — C4's registration page opens it after save (US-02; C4 owns that page, so the label screen must be C5's).
- `- { id: staff.lab.ingest_exception, origin: staff_web, path: /lab/ingest-exceptions/{exception_id}, owner: C5, permission: lab.result.read }` — C7 message screen links to the matching exception.

### CR-C5-008: Documentation clarifications (lead / C0-0C)
- 02-CV §4.1 example `GET /v1/lab/specimens?barcode=…` puts a lab-linked identifier in a URL, conflicting with REQ-SEC-098 and 02-CV §9.2; C5 uses `POST /v1/lab/specimens/lookup`. Ask the lead to change the example.
- `LabPort.ingestInstrumentResult` JSDoc says it throws `lab.result_locked`; contract test (8) expects outcome `rejected_state`. C5 implements the contract test; ask C0 to align the JSDoc.

### CR-C5-009: Barcode prefix value
- From C5 → C0-0C + C2. Type: port (TenantSettings).
- Problem: the default barcode pattern `{prefix}{yy}{seq:7}` (03-IC §9.3) uses `{prefix}`, but `TenantSettings.numbering` carries patterns only, not prefix values.
- Proposed: `numbering.barcodePrefix?: string` (`[A-Z0-9]{0,4}`); until merged, `{prefix}` in a barcode pattern is rejected and tenants put the literal in the pattern.


# C6-reporting-delivery  (own CRs: 15)

## 16. Change requests raised

Each CR follows the template of `program/04-CHANGE-REQUESTS.md` §2. C6 builds against the fakes and designs as if every CR is accepted.

```
Title: CR-C6-001: Core support for portal credentials, reporting public endpoints and raw-body callbacks
From chunk: C6            To owner: C0-0D (API core)
Type: api   Blocking? yes — C6-T20 (portal), C6-T22 (QR verify), C6-T29 (callbacks)
Problem: US-10, US-11, US-09 AC-09.3. (a) The portalSession AuthResolver (C0-TRD §6.3) receives one credential,
  but the portal needs two stages (link token before OTP, session token after). (b) A failed portal resolution must
  return the module's 404 reporting.link_invalid, identical for every invalid case (REQ-SEC-094), not 401.
  (c) x-public operations get no DB transaction except health (C0-TRD §6.2 step 7); QR verify and provider
  callbacks need ctx.db.anonymousTx() to call their inventoried DEFINER functions. (d) Provider callback bodies are
  provider-defined and UNVERIFIED, so they cannot be schema'd with additionalProperties:false.
Proposed change (exact):
  - securitySchemes.portalSession = apiKey in header "X-Lims-Portal-Credential"; resolver gets the full value
    ("link.<b64url>" | "session.<b64url>"); AuthResolver result may carry extraClaims
    {portal_stage, portal_report_id, portal_session_id}; core copies them into DbClaims.
  - AuthResolver may return { error: 'reporting.link_invalid' } → core responds with that code (404) and no other
    information; allowed only for module 'reporting'.
  - ctx.db.anonymousTx() allowed for operations flagged x-public AND x-anonymous-tx: true, only in modules
    listed in core config (reporting).
  - x-raw-body: true operations receive req.rawBody (Buffer ≤ 256 KB) and skip body schema validation;
    spec lint waiver for these two operations (receiveProviderCallback, verifyProviderCallback) only.
Backward compatible? yes (additive).
Tenant/security impact: new public surfaces (REQ-SEC-099 inventory): verifyReportQr, receiveProviderCallback,
  verifyProviderCallback; portal credential path. No PHI added.
Alternatives considered: separate "portalLink" scheme (more surface, same logic); putting tokens in URL query (banned, REQ-SEC-098).
Tests that will prove it: probes — invalid/expired/revoked link credentials produce byte-identical 404;
  anonymousTx refused for non-flagged ops; raw body size cap.
```

```
Title: CR-C6-002: DEFINER lookup functions, lookup role and global token-hash indexes for reporting
From chunk: C6            To owner: C0-0B
Type: schema   Blocking? yes — C6-T20, C6-T22, C6-T29
Problem: QR verify, portal credential resolution and provider callbacks must find a row by token hash before any
  tenant context exists (C0 05-SCHEMA §4.3 last row reserves this for C6).
Proposed change (exact): role lims_reporting_lookup (NOLOGIN, no BYPASSRLS); functions
  app.reporting_verify_qr(text), app.reporting_resolve_portal_credential(text,text),
  app.reporting_ingest_provider_callback(text,text,jsonb) — DDL and policies in 05-SCHEMA §6;
  global unique indexes on token_sha256 of reporting.qr_tokens, portal_links, portal_sessions and on
  reporting.channel_accounts.callback_token_sha256 (exception to tenant-leading rule, like CR-C2-017).
Backward compatible? yes.
Tenant/security impact: three new DEFINER functions (REQ-SEC-019/020); predicates bound to the presented token hash
  via set_config('app.lookup_token_sha256', …, true); no USING (true); no caller-supplied tenant.
Alternatives considered: tenant id in the QR/link URL (leaks tenant; still needs a lookup); HMAC tokens (rejected, 04 A11).
Tests that will prove it: lookup role sees only the row matching the configured hash; other rows invisible;
  revoked → empty; function set equals inventory.
```

```
Title: CR-C6-003: Reporting permissions and default role 'radiologist'
From chunk: C6            To owner: C0-0C (permissions.yaml), C2 (role defaults)
Type: api   Blocking? no — fakes allow
Problem: US-05, US-12, US-13, US-15 need permissions not in 03-IC §11.
Proposed change (exact):
  - { code: reporting.report.render,          privileged: false, roles: [pathologist, lab_manager] }
  - { code: reporting.report.regenerate,      privileged: true,  roles: [pathologist, lab_manager] }
  - { code: reporting.report.bulk_download,   privileged: true,  roles: [lab_manager, tenant_admin] }   # REQ-SEC-100
  - { code: reporting.token.revoke,           privileged: true,  roles: [tenant_admin] }
  - { code: reporting.narrative.write,        privileged: false, roles: [pathologist, radiologist, lab_technologist] }
  - { code: reporting.narrative.sign,         privileged: true,  roles: [pathologist, radiologist] }
  - { code: reporting.message_template.manage, privileged: true, roles: [tenant_admin] }
  - { code: reporting.channel.manage,         privileged: true,  roles: [tenant_admin] }
  - { code: reporting.settings.manage,        privileged: true,  roles: [tenant_admin, lab_manager] }
  - { code: reporting.portal.challenge,       privileged: false, roles: [] }    # added to fixed_actor_permissions.portal
  - roles: { code: radiologist, mfa_required: true, description: "Writes and signs imaging/endoscopy narrative reports" }
  - add reporting.report.read to lab_manager and tenant_admin default grants (they manage templates/settings and need to see reports)
Backward compatible? yes. Tenant/security impact: privileged codes require aal2 (04 A4).
Tests: IdentityPort fake/real contract — portal actor holds reporting.portal.challenge; radiologist cannot approve lab results.
```

```
Title: CR-C6-004: Reporting error codes
From chunk: C6            To owner: C0-0C (errors.yaml)
Type: api   Blocking? no
Proposed change (exact):
- { code: reporting.version_not_latest,    http: 409, owner: C6, title: "A newer report version exists", meaning: "Only the latest non-discarded version can be released/printed as current" }
- { code: reporting.report_cancelled,      http: 409, owner: C6, title: "Report cancelled", meaning: "Order cancelled; no new versions or releases" }
- { code: reporting.narrative_locked,      http: 409, owner: C6, title: "Narrative report is signed", meaning: "Start an amendment instead" }
- { code: reporting.narrative_incomplete,  http: 422, owner: C6, title: "Required sections are empty", meaning: "Fill required sections before signing" }
- { code: reporting.input_file_not_ready,  http: 409, owner: C6, title: "File not ready", meaning: "Scan/sanitise still running or file rejected" }
- { code: reporting.print_not_ready,       http: 409, owner: C6, title: "Print file not ready", meaning: "Plain/bulk print still rendering" }
- { code: reporting.channel_not_configured, http: 422, owner: C6, title: "Channel not configured", meaning: "No active channel account for this channel" }
- { code: reporting.callback_rejected,     http: 400, owner: C6, title: "Callback rejected", meaning: "Unknown callback token or bad signature; identical response" }
Backward compatible? yes.
```

```
Title: CR-C6-005: Report-version state 'discarded' (03-IC §10.3)
From chunk: C6            To owner: C0-0C + doc owner (03-IC)
Type: api   Blocking? no
Problem: A rendered version that was never released can be overtaken by a newer version (amendment while held for
  payment, order cancelled). 03-IC §10.3 has no transition for it; leaving it 'rendered' lets it be released by mistake.
Proposed change (exact): add transitions 'rendering' → 'discarded', 'rendered' → 'discarded', 'render_failed' → 'discarded'
  (trigger: newer version assembled, order cancelled); no event. QR of a discarded version → verify_not_found.
Backward compatible? yes (new state, no consumer reads report_versions.status; StatusChip kind report_version
  needs the label "Discarded" — C0-0D message key ui.status.report_version.discarded).
Tests: version state-machine unit tests; release of discarded → reporting.release_not_ready.
```

```
Title: CR-C6-006: LabPort ResultView.moduleRef and OrderResults.specimens[].barcode
From chunk: C6            To owner: C5 (implements) + C0-0C (contracts/ports/LabPort.ts)
Type: port   Blocking? no (Phase 1: barcode only; moduleRef needed in Phase 2)
Problem: (a) The report header prints "Barcode No" (00 §4); OrderResults.specimens has no barcode.
  (b) C6 must render micro/anatomic sections "from the approved payloadRef" (03-IC §4.5 A1 semantics) but ResultView
  does not expose payloadRef.
Proposed change (exact, additive optional fields; LAB_PORT_VERSION stays 1):
  OrderResults.specimens[]: readonly barcode?: string;                // P2; returned only for scope 'approved'
  ResultView: readonly moduleRef?: { readonly module: 'micro' | 'anatomic'; readonly entityId: Uuidv7; readonly versionNo: number }; // origin 'module' only
Tenant/security impact: barcode is P2; port callers are server-side only.
Tests: LabPort contract additions — approved scope returns barcode; module-origin result returns moduleRef equal to the A1 submission.
```

```
Title: CR-C6-007: IdentityPort.getSignatories and IdentityPort.readBrandingAsset
From chunk: C6            To owner: C2 (implements) + C0-0C
Type: port   Blocking? no (fake returns synthetic signatories/images)
Problem: The footer needs name, title, NMC no. and signature image of the APPROVING memberships (00 §4; glossary
  "Signatory"); getActor only covers the current actor. Branding images (CR-C2-008 refs) and signature images are in
  C2's private bucket 'tenant-assets'; C6 must not read another module's storage paths directly.
Proposed change (exact):
  getSignatories(ctx, input: { membershipIds: readonly Uuidv7[] /* ≤ 20 */ }): Promise<readonly {
    membershipId: Uuidv7; displayName: string; displayTitle?: string; registrationNo?: string;
    signatureAssetId?: Uuidv7; signatureSha256?: string; isActive: boolean }[]>;     // inactive still returned (old reports re-render)
  readBrandingAsset(ctx, input: { assetId: Uuidv7 }): Promise<{ assetId: Uuidv7; kind: 'logo' | 'letterhead_header' |
    'letterhead_footer' | 'signature'; mimeType: 'image/png' | 'image/jpeg'; sha256: string; base64: string }>;   // ≤ 2 MB
  Assets referenced by a released report must stay readable (C2 keeps superseded asset objects; deactivate, never delete).
Tenant/security impact: signature images are P2 (02-CV §9.2); system actor of reporting only (manifest permission
  identity.signatory.read — new, privileged false, roles []), never exposed by C6 HTTP except embedded in PDFs.
Tests: contract — unknown id omitted; other tenant → not in result; deactivated membership still returned.
```

```
Title: CR-C6-008: Access-log action codes for reporting
From chunk: C6            To owner: C0-0B (audit.g_cs_access_actions seed)
Type: schema   Blocking? no
Proposed change (exact): add codes report.release, report.portal_view, report.portal_download, report.outsourced_view,
  report.narrative_sign, report.token_revoke, portal.session_start, portal.link_reissue. Existing codes used:
  report.view, report.print, report.download, report.bulk_download, auth.otp_sent, auth.otp_failure.
Backward compatible? yes.
```

```
Title: CR-C6-009: Storage buckets for reporting + acknowledgement of the shared upload/storage adapter
From chunk: C6            To owner: C0-0A (ctx.storage / ctx.uploads, = CR-C2-011 / C4 CR) + C0-0B (buckets, policies)
Type: shared-lib + schema   Blocking? yes for C6-T10/T11 (uploads), no for render (fake storage)
Proposed change (exact): private buckets
  'reports'        path {tenant_id}/{yyyy}/{mm}/{report_id}-v{n}.pdf (04 D15) — write-once by worker (server credentials), read by API only
  'report-inputs'  {tenant_id}/quarantine/{yyyy}/{mm}/{file_id}.bin, {tenant_id}/outsourced/{yyyy}/{mm}/{file_id}.pdf,
                   {tenant_id}/narrative-images/{yyyy}/{mm}/{file_id}.{png|jpg}
  'report-prints'  {tenant_id}/prints/{yyyy}/{mm}/{print_id}.pdf (24 h TTL, deleted by purge)
  storage.objects SELECT policy per bucket on first path segment (C0 05-SCHEMA §8 template) only if SP-4 succeeds;
  C6 uses no client-side Storage access in any case (all reads/writes via ctx.storage in the API/worker).
  ctx.storage must support put-if-absent (write-once) for bucket 'reports' and return sha256 + byte size.
Tenant/security impact: REQ-SEC-034/035; first segment = tenant_id.
Tests: write-once refusal on existing path; cross-tenant path read refused by the adapter.
```

```
Title: CR-C6-010: UI-kit components for reporting and portal
From chunk: C6            To owner: C0-0D
Type: ui-kit   Blocking? no — screens use TextArea/placeholder until merged
Proposed change: RichTextEditor (allowlisted marks: bold, italic, underline, bulleted/numbered lists, simple tables,
  h3/h4; paste sanitised client-side AND server-side; maxLength in characters of text content; outputs HTML string),
  OtpInput (6 numeric cells, paste support, autocomplete="one-time-code", inputMode numeric, accessible label),
  ImageThumbnailGrid (thumbnails with caption field, reorder, remove; images loaded through BFF URLs),
  PdfFileCard (filename, pages, size, scan state chip, download action). Props in 04-UI-UX §5.
Tests: axe scan stories; RichTextEditor XSS paste corpus.
```

```
Title: CR-C6-011: Routes for reporting screens
From chunk: C6            To owner: C0-0C (routes.yaml)
Type: api   Blocking? no
Proposed change (exact):
  - { id: staff.reporting.worklist,  origin: staff_web, path: /reporting,                              owner: C6, permission: reporting.report.read }
  - { id: staff.reporting.narrative, origin: staff_web, path: /reporting/narratives/{narrative_id},    owner: C6, permission: reporting.narrative.write }
  - { id: staff.reporting.outsourced, origin: staff_web, path: /reporting/outsourced,                  owner: C6, permission: reporting.outsourced.attach }
  - { id: staff.reporting.template,  origin: staff_web, path: /reporting/templates/{template_id},       owner: C6, permission: reporting.template.manage }
  - { id: staff.reporting.settings,  origin: staff_web, path: /reporting/settings,                     owner: C6, permission: reporting.settings.manage }
  - { id: staff.reporting.messages,  origin: staff_web, path: /reporting/messages,                     owner: C6, permission: reporting.message_template.manage }
```

```
Title: CR-C6-012: Add C6 as consumer of published views
From chunk: C6            To owner: C0-0C + doc owner (03-IC §6.1/§6.6/§6.8)
Type: schema (doc)   Blocking? no
Proposed change: consumers += C6 for catalog.v_pub_department (department names on reports),
  frontdesk.v_pub_order_status (partner_id snapshot for ReportingPort partner filter). micro/anatomic
  v_pub_report_content already list C6.
Tenant/security impact: none new (security_invoker views, system actor).
```

```
Title: CR-C6-013: Infrastructure rules for renderer, sandbox, portal and callbacks
From chunk: C6            To owner: C1
Type: infra   Blocking? no for dev; yes before production
Proposed change: (1) renderer and pdf-sandbox containers: no egress (deny all outbound), inbound only from worker on the
  private network, non-root, read-only rootfs, tmpfs work dir, memory 1.5 GB (renderer) / 512 MB (sandbox), CPU caps;
  (2) nginx: exclude request paths of /r/*, /v/* (portal origin) and /v1/reporting/provider-callbacks/* from access
  logs; limit_req 10 r/m per IP on /v/* and on POST /v1/reporting/verifications (04 §4); per-IP limit on callbacks
  (60 r/m [CONV]); (3) portal origin separate host name (LIMS_ORIGIN_PORTAL), HSTS per 04 I6; (4) secret-store
  entries for channel accounts by secret_ref, renderer/sandbox tokens, OTP HMAC key; (5) scanner service in prod;
  (6) alerts listed in C6 02-TRD §12.
```

```
Title: CR-C6-014: Accept CR-C5-006 (optional order_item_ids on reporting.report.released.v1)
From chunk: C6 (producer)  To owner: C0-0C
Type: event   Blocking? no
Proposed change: C6 agrees to CR-C5-006 exactly as proposed (optional array, maxItems 200, Uuidv7) and will populate
  it with report_versions.order_item_ids for every release.
```

```
Title: CR-C6-015: FrontdeskPort 'notification' purpose for non-system callers (contact presence)
From chunk: C6            To owner: C4 (implements) + C0-0C
Type: port   Blocking? no (fake)
Problem: NotificationPort runs in the caller's context (02-CV §8.1). C4 restricts purpose 'notification' to system
  actors (C4 02-TRD §6.1), so a NotificationPort call from C4's registration handler (user actor) could not check
  consent synchronously, which 03-IC §4.8 contract case (1) requires.
Proposed change (exact, additive): PatientDemographics gains
  readonly contactPresence?: { readonly phone: boolean; readonly email: boolean };
  For purpose 'notification' and a non-system actor: return consents + contactPresence only (no phoneE164/email).
  System actors keep the full field set.
Tenant/security impact: reduces data exposure (REQ-SEC-081).
Tests: FrontdeskPort contract — user actor gets presence flags without contact values; system actor gets contacts.
```

Acknowledged CRs of other chunks that C6 relies on: CR-C2-008 (branding, featureFlags), CR-C2-011 (upload/storage adapter), CR-C3-001 (`getReferrer`, `specimenReportLabel`, `printName`), CR-C4-011 (templates `frontdesk.registration_confirmation`, `frontdesk.recollection_request` — **accepted** and seeded in `reporting.g_message_templates`), CR-C5-006 (via CR-C6-014).


# C7-instrument-integration  (own CRs: 12)

## 16. Change requests raised

Template per `program/04-CHANGE-REQUESTS.md` §2. All designed as if accepted.

### CR-C7-001: Permission codes
- From C7 → C0-0C (`contracts/permissions.yaml`). Type: api. Blocking: no (fake IdentityPort accepts configured codes) — tasks API-T05, WEB-T02.
- Problem: US-03/US-04 need a registry permission separate from device-credential management (`instruments.agent.manage` = token issue/revoke, 03-IC §11); technologists need to read instrument names without agent powers; enrolment needs a device permission (US-01).
- Proposed:
  - `{ code: instruments.instrument.read, privileged: false, roles: [lab_manager, lab_technologist] }`
  - `{ code: instruments.instrument.manage, privileged: true, roles: [lab_manager] }` — instrument configuration, commissioning, go-live, module settings
  - `fixed_actor_permissions.device` += `instruments.ingest.enrol`; `{ code: instruments.ingest.enrol, privileged: false, roles: [] }`
- Backward compatible: yes. Security: `instrument.manage` privileged (aal2, 04 A4) because go-live changes what enters clinical results.

### CR-C7-002: Error codes
- From C7 → C0-0C (`contracts/errors.yaml`). Type: api.
- `{ code: instruments.agent_not_active, http: 409, owner: C7, title: "Agent not active", meaning: "Agent retired (or revoked where the action needs an active agent)" }`
- `{ code: instruments.agent_has_active_instruments, http: 409, owner: C7, title: "Agent still has instruments", meaning: "Retire or move instruments first" }`
- `{ code: instruments.invalid_transition, http: 409, owner: C7, title: "State change not allowed", meaning: "Agent/instrument/command state machine (03-APP-FLOW §2)" }`
- `{ code: instruments.go_live_checklist_incomplete, http: 422, owner: C7, title: "Go-live checklist incomplete", meaning: "All checklist items and an evidence note are required" }`
- `{ code: instruments.capability_not_supported, http: 422, owner: C7, title: "Capability not supported", meaning: "Driver/instrument does not support host query, worklist or file drop" }`
- `{ code: instruments.message_too_large, http: 413, owner: C7, title: "Message too large", meaning: "Single message above the per-message limit" }`
- `{ code: instruments.reprocess_not_allowed, http: 409, owner: C7, title: "Message cannot be reprocessed", meaning: "Host query, retired instrument, or record not eligible" }`
- `{ code: instruments.code_duplicate, http: 409, owner: C7, title: "Code already used", meaning: "agent_code or instrument_code exists in the tenant" }`

### CR-C7-003: Routes
- From C7 → C0-0C (`contracts/routes.yaml`). Type: api. Needed for nav entries (C0 04-UI-UX §3: routes with path params are not nav entries).
- `- { id: staff.instruments.agents, origin: staff_web, path: /instruments/agents, owner: C7, permission: instruments.agent.read }`
- `- { id: staff.instruments.instruments, origin: staff_web, path: /instruments/instruments, owner: C7, permission: instruments.instrument.read }`
- `- { id: staff.instruments.instrument, origin: staff_web, path: /instruments/instruments/{instrument_id}, owner: C7, permission: instruments.instrument.read }`
- `- { id: staff.instruments.instrument_mappings, origin: staff_web, path: /instruments/instruments/{instrument_id}/mappings, owner: C7, permission: instruments.instrument.read }`
- `- { id: staff.instruments.messages, origin: staff_web, path: /instruments/messages, owner: C7, permission: instruments.message.read }`
- `- { id: staff.instruments.settings, origin: staff_web, path: /instruments/settings, owner: C7, permission: instruments.instrument.read }`
- Existing `staff.instruments.agent` and `staff.instruments.message` are used unchanged.

### CR-C7-004: Event triggers and optional fields for `instruments.result.received.v1` / `instruments.qc.received.v1`
- From C7 → C0-0C (producer = C7; consumers C5, C9, C10, C12 informed). Type: event (additive).
- Problem: (1) the attachment event can only be emitted after the malware scan, in a worker transaction (US-12; REQ-SEC-084); (2) records parsed for the first time on reprocess (quarantine fixed) or re-matched with a corrected barcode (US-19) would otherwise never reach C9/C10/C12, because the port path (X2) reaches only C5; (3) after an outage `received_at` (server) can be hours after capture, so consumers cannot tell capture time (04 N12).
- Proposed: trigger text of §3.14/§3.15 extended with "or commit of the `scan_attachment` transaction that marks an attachment clean, or of a reprocess/re-match transaction, that produces a record whose key was not published before (re-publication is suppressed by `core.event_log` uniqueness)". New optional payload fields: `captured_at` (IsoUtc — agent capture time corrected by measured offset), `processing_kind` (`enum: [live, reprocess, rematch]`, absent = live), `source_record_id` (Uuidv7 — the C7 record a re-match derives from). Same three fields on `instruments.qc.received.v1` (except `source_record_id`).
- Backward compatible: yes (optional fields; consumers ignore unknown fields — 02-CV §7.2). Security: no new PHI.

### CR-C7-005: `LabPort.listPendingForInstrument` (worklist download)
- From C7 → C0-0C (port) + C5 (implements). Type: port. Blocking: no — US-23 stays BLOCKED (also B2).
- Problem: 01 §3.1 style 2 (LIS pushes pending orders) needs pending tests for an instrument, not for one barcode; `LabPort` has only `getPendingTestsForBarcode`.
- Proposed: `listPendingForInstrument(ctx, input: { instrumentId: Uuidv7; receivedSince?: IsoUtc; limit?: number /* ≤ 200 */; cursor?: string }): Promise<Page<{ specimenId; barcode: string; priority: Priority; patient: { sex: Sex; ageDays?: number }; tests: readonly { orderItemId; testId; analyteIds: readonly Uuidv7[] }[] }>>` — only received specimens in the device's centre with ≥ 1 pending result whose analyte has an outbound map for `instrumentId`. Contract tests mirror `getPendingTestsForBarcode` tests 3, 4, 12.
- Backward compatible: yes (new method). PHI: P2 (barcode) to a device actor of the same centre.

### CR-C7-006: DEFINER functions, owner-only policies, column grant
- From C7 → C0-0B. Type: schema. Blocking: API-T03 (device auth) — default meanwhile: a test-only resolver in the C7 module guarded by `NODE_ENV=test`.
- Proposed (full SQL in 05-SCHEMA §5): `app.instruments_resolve_device_credential(bytea)`, `app.instruments_agent_state_snapshot()`, `app.purge_instruments_archive()`; owner-only policies on `instruments.agent_credentials` / `instruments.agents` whose predicates read transaction-local GUCs set inside the function (no cross-tenant read outside the presented credential); no `SELECT` grant to `lims_app` on `agent_credentials.secret_sha256` (column-level grants). Inventory rows for `db/meta/definer-inventory.yaml`.
- Security: REQ-SEC-019/020/021; 04 D7.

### CR-C7-007: Storage bucket `instrument-attachments` and upload helper use
- From C7 → C0-0B (storage policies) + C0-0D (helper) — depends on CR-C4-005. Type: schema/shared-lib. Blocking: AT-T01 partially (C7 uses in-module fake adapters until merged).
- Proposed: private bucket `instrument-attachments`; paths `{tenant_id}/q/{yyyy}/{mm}/{id}.{ext}` (quarantine) and `{tenant_id}/{yyyy}/{mm}/{id}.{ext}` (clean); `storage.objects` SELECT policy on first path segment = tenant (same template as `reports`, C0 05-SCHEMA §8), no INSERT/UPDATE/DELETE policies for end users (writes by the service path of CR-C4-005). 04 D3 probe required before production PHI.

### CR-C7-008: Access-log action codes
- From C7 → C0-0B (`audit.g_cs_access_actions` seed). Type: schema.
- Codes: `instrument_message.raw_view`, `instrument_message.attachment_view`, `instrument_message.reprocess`, `instrument_message.rematch`, `device_credential.issue`, `device_credential.revoke`.

### CR-C7-009: `deviceToken` scheme details and route limits
- From C7 → C0-0C (`_common.yaml`) + C0-0D (core). Type: api.
- Proposed: `deviceToken: { type: http, scheme: bearer, bearerFormat: "lims-device-credential" }`; `AuthResolver` result `extraClaims.credential_kind` and `credential_id` copied into `request.jwt.claims` (they carry no PHI); route-level JSON body limit 4 MiB for `submitMessageBatch` and `submitAgentLogBundle`; multipart 16 MB for `submitAttachment` (15 MB file + metadata); binary response (`application/octet-stream`, streamed) for `downloadAgentRelease`; operations `enrolAgent` and `issueEnrolmentCode` declared `x-idempotency: none` with the justification text of §7.2/§7.3.

### CR-C7-010: UI kit components
- From C7 → C0-0D. Type: ui-kit.
- `CodeBlock` — `{ label: string; text: string; renderControlChars?: boolean /* shows <STX>, <CR> … as badges */; maxHeight?: number; wrap?: boolean; allowCopy?: boolean /* default false for PHI */ }` (raw message viewer, AC-18.3).
- `SecretRevealOnce` — `{ label: string; secret: string; expiresAt?: IsoUtc; onAcknowledged: () => void }`: monospace secret with copy button, warning text, and a required checkbox "I have copied this code" before the dialog can close; secret never re-rendered after close (AC-01.3/01.4).
- `KeyValueListEditor` — editable list of `{key, value}` pairs with per-field `maxLength` and max rows (code-map `flag_map`, ≤ 20 entries).

### CR-C7-011: Clarification of `LabPort.ingestInstrumentResult` replay semantics (to C5)
- From C7 → C5 (and C0-0C JSDoc). Type: bug/clarification.
- C7 relies on: (a) a key already `applied` → `duplicate`; (b) a key whose stored outcome was `unmatched`/`rejected_state` with an **open** C5 exception → re-evaluated now and the exception closed on success (C5 AC-14.6); (c) approved target → `rejected_state` + `reasonCode: 'result_locked'`, never a throw (C5 CR-C5-008). C5's 02-TRD §4.5 step 1 says "conflict → read stored outcome", which reads as (b) never re-evaluating. Please confirm (b) in C5's TRD and add a port contract case "replay of an unmatched key after the exception's cause is fixed → applied".

### CR-C7-012: Infrastructure requests (to C1)
- From C7 → C1. Type: infra. Not a contract change; tracked as a CR for visibility.
- nginx: per-IP `limit_req` for `/v1/instruments/agent/` of 120 r/m burst 60 [CONV] (protects the unauthenticated resolver path; the per-device 60/min tier is in the app — 04 §4); body size 4 MiB for the batch/log routes, 16 MB for attachments.
- Secret store entries: config signing key (Ed25519, rotation runbook), release signing key (kept **offline** from the API host; used only by the release pipeline).
- Read-only mount `LIMS_INSTRUMENTS_RELEASES_DIR` on API hosts; release pipeline that copies signed zips and applies the `g_agent_releases` seed SQL as `lims_migrator` → `lims_owner`.
- Prometheus scrape of the worker for `lims_instruments_*` and the alert rules of §13.
- Founder action (not C1): procure a LIMS-provider Authenticode code-signing certificate (06 §7 R3).


# C8-analytics-mis  (own CRs: 14)

## 16. Change requests raised

Designed as if accepted; each is non-blocking unless stated, with the default built meanwhile.

```
Title: CR-C8-001: Permission codes analytics.collections.read and analytics.schedule.manage
From chunk: C8            To owner: C0-0C (contracts/permissions.yaml)
Type: api                  Blocking? no — default: both checks fall back to analytics.dashboard.read in the fake registry
Problem: Collections by staff/method (PRD US-08) must not be visible to every analytics.dashboard.read holder (lab_manager);
  schedules send to other staff (US-18) and need their own grant. IC §11 has neither.
Proposed: - { code: analytics.collections.read, privileged: false, roles: [owner_viewer, tenant_admin, finance] }
          - { code: analytics.schedule.manage,  privileged: false, roles: [owner_viewer, tenant_admin] }
Backward compatible? yes (additive). Tenant/security impact: narrows access. Tests: role matrix tests in probes.
```
```
Title: CR-C8-002: Error codes for analytics exports and schedules
From chunk: C8            To owner: C0-0C (contracts/errors.yaml)
Type: api                  Blocking? no
Proposed entries:
- { code: analytics.export_not_ready,   http: 409, owner: C8, title: "Export not ready", meaning: "Queued or building" }
- { code: analytics.export_unavailable, http: 410, owner: C8, title: "Export no longer available", meaning: "Expired, failed or download limit reached" }
- { code: analytics.export_too_large,   http: 422, owner: C8, title: "Export too large", meaning: "Row or size cap exceeded; narrow the period" }
- { code: analytics.recipient_ineligible, http: 422, owner: C8, title: "Recipient not eligible", meaning: "Membership inactive or lacks the report permission" }
Backward compatible? yes. Tests: one per code (CV §11.4).
```
```
Title: CR-C8-003: Table class R (derived rollup) in 02-CONVENTIONS §5.2
From chunk: C8            To owner: doc owner + C0-0B
Type: schema               Blocking? no — DDL in C8 05-SCHEMA already follows the proposed class
Problem: analytics.daily_* and tat_facts are rebuildable aggregates replaced by delete+insert. Class E requires id + expires_at;
  class M requires version/updated_*; neither fits, and a per-row UUID on ~2 M rows/lab/year is pure overhead.
Proposed: Class R — derived, rebuildable from v_pub_* views; natural composite PK with tenant_id leading; mandatory columns
  tenant_id, refresh_run_id, refreshed_at; INSERT/DELETE only by the owning module's system actor (RLS on actor_type = 'system');
  no UPDATE; no audit trigger (source tables are audited); excluded from audit_log.
Backward compatible? yes. Security: RLS still tenant + centre on SELECT.
```
```
Title: CR-C8-004: lab published views — centre and test-level columns, aliquot parent
From chunk: C8            To owner: C0-0B (C5 must agree)
Type: schema               Blocking? no — default: results and critical-value sections tenant-wide only; aliquots counted
Problem: 00 F1 "tests done" per centre and for centre-restricted users needs centre_id; counts are analyte-level (results),
  not tests; TAT/received counts need to exclude aliquots (IC §10.1 S5 aliquots start at received).
Proposed (additive columns, IC §6.3):
  lab.v_pub_result_daily: + centre_id (order's collection centre; grouping key), + tests_approved bigint
      (order tests whose status became 'approved' on business_date)
  lab.v_pub_critical_value_daily: + centre_id (grouping key)
  lab.v_pub_specimen_timeline: + parent_specimen_id
Backward compatible? yes (new grouping key splits rows; C9/C12 consumers that sum are unaffected; C5/C9/C12 to confirm).
Tenant/security impact: none (ids only). Tests: view returns per-centre rows; sums unchanged.
```
```
Title: CR-C8-005: reporting.v_pub_delivery_daily centre_id + anchor definitions for C6 views
From chunk: C8            To owner: C0-0B (C6 must agree; C6 docs not yet written)
Type: schema               Blocking? no — default: delivery stats tenant-wide only
Proposed: v_pub_delivery_daily + centre_id (report's order centre; NULL for non-report deliveries); C6 05-SCHEMA states that
  business_date = Asia/Kathmandu date of the transition into each status column; v_pub_order_report_tat has one row per
  registered order once C6 has created its report shell (else C8 relies on analytics.order_index — no change needed).
Backward compatible? yes.
```
```
Title: CR-C8-006: access-log action code analytics.referral_report.view
From chunk: C8            To owner: C0-0B (audit.g_cs_access_actions seed)
Type: schema               Blocking? no — default: data.export with detail.phase='view' until merged
Problem: viewing the referral business report is a sensitive read (04 L19; REQ-SEC-096) distinct from export.
Proposed: seed row ('analytics.referral_report.view', 'Referral business report viewed').
```
```
Title: CR-C8-007: C8 as NotificationPort consumer; purpose scheduled_report_ready; template analytics_report_ready
From chunk: C8            To owner: C0-0C (C6 must agree)
Type: port                 Blocking? no — default: fake NotificationPort records sends; dispatcher runs against it
Problem: Scheduled MIS (PRD US-18) must go through the only messaging gateway (CM §5.1); C8 is not a listed consumer and
  NotificationPurpose has no value for it.
Proposed: CM §5.1 / IC §4.8 consumers + C8; NotificationPurpose += 'scheduled_report_ready'; SendBase.related.entityType
  += 'report_run' (optional); C6 template registry: analytics_report_ready (channel email; params lab_name ≤ 100, schedule_name ≤ 80;
  body "Your scheduled report <schedule_name> from <lab_name> is ready. Sign in to view: <link>"); recipient kind staff only.
Backward compatible? yes (union/enum extension). Security: link-only (04 R5, S20); params non-PHI; staff recipients only.
```
```
Title: CR-C8-008: routes.yaml entries for analytics pages
From chunk: C8            To owner: C0-0C
Type: api                  Blocking? no — default: only staff.analytics.dashboard exists; other pages reachable from the dashboard
Proposed (origin staff_web, owner C8):
  - { id: staff.analytics.reports,            path: /analytics/reports,                       permission: analytics.dashboard.read }
  - { id: staff.analytics.referral_incentive, path: /analytics/referral-incentive,            permission: analytics.referral_report.read }
  - { id: staff.analytics.exports,            path: /analytics/exports,                       permission: analytics.export }
  - { id: staff.analytics.schedules,          path: /analytics/schedules,                     permission: analytics.schedule.manage }
  - { id: staff.analytics.report_run,         path: /analytics/report-runs/{report_run_id},   permission: analytics.dashboard.read }
Backward compatible? yes. Security: params are UUIDs only (IC §7 rule).
```
```
Title: CR-C8-009: RenderPort template key analytics.report + path services/renderer/templates/analytics/
From chunk: C8            To owner: C0-0C + C6 + doc owner (extends CR-C4-004)
Type: port                 Blocking? no — default: format=pdf → common.feature_disabled
Proposed: RenderPort.renderPdf templateKey union += 'analytics.report'; C8 owns services/renderer/templates/analytics/**
  (bundled assets only, REQ-SEC-086); data = {header block, columns, rows ≤ 5,000 for PDF [CONV]}.
```
```
Title: CR-C8-010: billing.v_pub_payment_collection column name
From chunk: C8            To owner: C0-0B (C4 to align its 05-SCHEMA §6)
Type: schema / bug         Blocking? no
Problem: IC §6.2 names the column payment_method_code; C4 05-SCHEMA §6 view SQL selects method_code without alias.
  IC has precedence (00-README); C8 reads payment_method_code.
Proposed: C0 DDL uses `method_code AS payment_method_code`; C4 updates its document.
```
```
Title: CR-C8-011: Expression indexes so date-bounded reads of v_pub views use indexes
From chunk: C8            To owner: C0-0B (C4, C5, C6, C7 agree)
Type: schema (performance) Blocking? no — default: 1-day chunks; sweep interval configurable
Problem: views group by (ts AT TIME ZONE 'Asia/Kathmandu')::date; C8's predicate on business_date can only use an index on that
  expression; otherwise each refresh scans the tenant's whole fact table (lab.results ≈ 9 M rows/lab/year at 25k/day, 04 §14).
Proposed: CREATE INDEX CONCURRENTLY … ON billing.invoices (tenant_id, ((issued_at AT TIME ZONE 'Asia/Kathmandu')::date));
  likewise billing.invoices(cancelled_at), billing.credit_notes(issued_at), billing.invoice_lines via invoices, billing.ledger_entries
  (business_date — plain column), billing.credit_charges(charged_at), frontdesk.orders(registered_at), lab.results(first_resulted_at),
  lab.verifications(occurred_at), lab.approvals(occurred_at), lab.critical_value_log(detected_at), lab.specimens(collected_at,
  received_at, rejected_at — plain timestamptz indexes suffice for C8's range predicates on the timeline view), reporting/instruments
  equivalents. Immutability of timezone(text, timestamptz) for index expressions: UNVERIFIED here — C0 confirms on PG 17 in the migration
  PR (if not immutable, owners expose a stored business_date column like billing.ledger_entries already has).
Tests: EXPLAIN of each C8 refresh query shows an index scan on the seeded 10× dataset.
```
```
Title: CR-C8-012: Per-task statement timeout override in WorkerManifest
From chunk: C8            To owner: C0-0D
Type: shared-lib           Blocking? no — default: 1-day chunks within 5 s
Proposed: WorkerManifest.taskOptions?: { [task]: { statementTimeoutMs?: number (≤ 300000) } } applied via set_config in the task tx.
```
```
Title: CR-C8-013: UI kit additions PeriodPicker, DurationText, FreshnessBadge
From chunk: C8            To owner: C0-0D
Type: ui-kit               Blocking? no — default: composed locally from Select + DateRangePicker + Badge + Tooltip (04-UI-UX §2)
Proposed: PeriodPicker {value: PeriodValue; presets: ('today'|'yesterday'|'this_bs_month'|'last_bs_month'|'this_fy'|'last_fy'|
  'this_ad_month'|'last_ad_month'|'custom')[]; calendar}; DurationText {seconds; style: 'short'|'long'};
  FreshnessBadge {refreshedAt?: IsoUtc; isStale: boolean; reason?}. C4 (daily cash by B.S. date) can reuse PeriodPicker.
```
```
Title: CR-C8-014: One repo-wide pin of write-excel-file 4.1.1
From chunk: C8            To owner: C0-0A (dependency review)
Type: shared-lib           Blocking? no
Proposed: C3 and C8 (and C4 BL-T19) use the same exact version; C0 records it in its dependency review (CV §15.1).
```


# C9-quality-engine  (own CRs: 7)

## 16. Change requests raised

Template per `program/04-CHANGE-REQUESTS.md` §2. All designed as if accepted.

### CR-C9-001: Permission codes
```
Title: CR-C9-001: quality permission codes for run review, auto-verify read, TAT alerts, settings
From chunk: C9            To owner: C0-0C (contracts/permissions.yaml)
Type: api                 Blocking? no — IdentityPort fake accepts configured codes (T-02)
Problem: US-07 (corrective action/close/acknowledge by technologists), US-11/13 (technologists must see why a result was
  not auto-verified without being able to edit rules), US-14 (TAT alerts), §12.1 settings. 03-IC §11 has only
  quality.qc_run.read, quality.qc.manage (lab_manager only), quality.autoverify.manage (privileged).
Proposed (03-IC §11, phase: 2):
  - { code: quality.qc_run.review,   privileged: false, roles: [lab_technologist, lab_manager, pathologist], phase: 2 }
  - { code: quality.autoverify.read, privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }
  - { code: quality.tat_alert.read,  privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }
  - { code: quality.tat_alert.ack,   privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }
  - { code: quality.config.manage,   privileged: false, roles: [lab_manager], phase: 2 }
Backward compatible? yes (additive)
Tenant/security impact: none beyond new grants; autoverify.read exposes decision inputs (P3) to lab roles that already
  hold lab.result.read.
Alternatives considered: reuse quality.qc.manage for review (rejected: technologists must not edit targets).
Tests: permission registry equality; probes per endpoint with each role.
```

### CR-C9-002: Error codes
```
Title: CR-C9-002: quality error codes
From chunk: C9            To owner: C0-0C (contracts/errors.yaml)
Type: api                 Blocking? no
Proposed:
- { code: quality.code_duplicate,          http: 409, owner: C9, title: "Already exists", meaning: "Material/level/lot code, control-ID map or QC plan for the pair already exists" }
- { code: quality.rerun_required,          http: 409, owner: C9, title: "Accepted QC rerun required", meaning: "Rejected run can be closed only after a later accepted run (01 §2.5)" }
- { code: quality.rule_set_invalid,        http: 422, owner: C9, title: "Auto-verification rules invalid", meaning: "DSL validation errors in errors[]" }
- { code: quality.rule_set_invalid_transition, http: 409, owner: C9, title: "Rule set version cannot change state", meaning: "03-APP-FLOW §2.3" }
- { code: quality.simulation_incomplete,   http: 409, owner: C9, title: "Simulation not long enough", meaning: "sim_min_days / sim_min_decisions not met" }
- { code: quality.self_activation_forbidden, http: 403, owner: C9, title: "Another person must activate", meaning: "Four-eyes activation of auto-verification rules" }
- { code: quality.insufficient_qc_data,    http: 422, owner: C9, title: "Not enough QC data", meaning: "Fewer observations than target_min_points" }
Backward compatible? yes. Tests: one HTTP test per code.
```

### CR-C9-003: `QualityPort` reason `qc_warning` + documented semantics
```
Title: CR-C9-003: AutoVerifyReason += 'qc_warning'; qcStatusFor semantics and extra contract cases
From chunk: C9            To owner: C0-0C (contracts/ports/QualityPort.ts, fake, contract suite)
Type: port                Blocking? no — pre-merge C9 emits qc_out_of_control for warning denials
Problem: A rule may refuse auto-verification when the governing QC run only had a 1-2s warning (or was incomplete);
  no reason code expresses that, and reporting it as qc_out_of_control is false (glossary: a warning is not out of control).
Proposed: type AutoVerifyReason = … | 'qc_warning'. Document in JSDoc: qcStatusFor returns out_of_control while a rejected
  run is not closed even if a newer run is accepted; returns no_qc_data when the last in-control run is older than the
  plan's validity; violatedRules may contain 'incomplete_run'. Add contract cases 8–12 (02-TRD §11.1). Fake: programmable.
Backward compatible? yes (union extended; C5 treats every reason as deny and stores reasons as text).
Tests: contract cases; C5 stores the new code without validation errors.
```

### CR-C9-004: C5 calls `canAutoVerify` independent of the tenant switch (shadow simulation)
```
Title: CR-C9-004: C5 asks QualityPort for every instrument-origin save when the hook flag is on
From chunk: C9            To owner: C5 (behaviour) + C0-0C (QualityPort JSDoc)
Type: port (semantics of the caller)   Blocking? no — degraded simulation until merged (§8.3)
Problem: US-11 needs shadow decisions before a tenant enables auto-verification; C5 only calls canAutoVerify when
  autoVerificationEnabled is true (C5 02-TRD §6.2).
Proposed: when LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true, C5 calls canAutoVerify on every R2/R3 with origin=instrument,
  on_hold=false, unit_mismatch=false, in the save transaction; performs R4 mode auto only on decision=allow. C9 keeps the
  invariant "allow never when tenant disabled" (03-IC §4.11).
Backward compatible? yes for C9's fake/stub (always deny). C5 adds ≤ 10 ms per instrument save (03-IC §4.11 budget);
  C5 confirms this fits its ingestInstrumentResult ≤ 50 ms budget (03-IC §4.5).
Tenant/security impact: none (same tenant transaction).
Tests: C5 integration — disabled tenant: port called, result not auto-verified; enabled + allow: R4 auto.
```

### CR-C9-005: `lab.v_pub_qc_result.created_at` + index
```
Title: CR-C9-005: add created_at to lab.v_pub_qc_result and index lab.qc_results (tenant_id, created_at, id)
From chunk: C9            To owner: C0-0B (C5 must agree)
Type: schema              Blocking? no — fallback scan by received_at with 24 h overlap (§6.2)
Problem: C9 imports QC incrementally (§6.2). received_at is not insert order (C5's consumer can commit minutes after
  received_at during backlog/retries), so a received_at cursor can skip rows unless the overlap is large; no index
  supports a per-tenant time-ordered scan (only (tenant_id, instrument_id, analyte_id, instrument_result_time)).
Proposed DDL:
  CREATE OR REPLACE VIEW lab.v_pub_qc_result WITH (security_invoker = true) AS
  SELECT <existing columns>, q.created_at FROM lab.qc_results q;   -- column appended at the end
  CREATE INDEX CONCURRENTLY qc_results__tenant_id_created_at__idx ON lab.qc_results (tenant_id, created_at, id);
Backward compatible? yes (column appended; C8 unaffected). PHI: P0.
Tests: view column contract; EXPLAIN uses the index for the sync query.
```

### CR-C9-006: `instruments.v_pub_instrument_directory`
```
Title: CR-C9-006: published instrument directory view for labels
From chunk: C9            To owner: C0-0B (C7 must agree)
Type: schema              Blocking? no — labels fall back to the C7 HTTP API in the BFF (users with
                          instruments.instrument.read) or to a short instrument id
Problem: QC plans, runs, status board and LJ charts must name the instrument for pathologists who lack
  instruments.instrument.read; C9 may not read instruments tables (01 §5 R1).
Proposed: CREATE VIEW instruments.v_pub_instrument_directory WITH (security_invoker = true) AS
  SELECT tenant_id, id AS instrument_id, centre_id, instrument_code, display_name, vendor, model, state FROM instruments.instruments;
  GRANT SELECT … TO lims_app. Consumers: C9 (C12 may also use it). PHI: P0.
Backward compatible? yes (new view).
Tests: column contract; cross-tenant probe.
```

### CR-C9-007: UI kit `ControlChart` (Levey-Jennings)
```
Title: CR-C9-007: @lims/ui ControlChart component
From chunk: C9            To owner: C0-0D
Type: ui-kit              Blocking? task T-21 only (C9 renders a DataTable of points until merged)
Problem: US-08 needs mean/±1/2/3SD reference lines that step when targets change, per-point status markers with
  text/shape (not colour only), multiple series (z view), rule labels and a hidden data table. TimeSeriesChart
  supports only one referenceBand.
Proposed props:
  interface ControlChartProps { title: string; unit?: string; mode: 'value' | 'z';
    series: readonly { id: string; label: string; points: readonly { id: string; at: IsoUtc; value: DecimalString;
      status: 'accepted' | 'warning' | 'rejected' | 'excluded' | 'unevaluated' | 'collecting'; annotations?: readonly string[] }[] }[];
    limits: readonly { from: IsoUtc; to?: IsoUtc; mean: DecimalString; sd: DecimalString }[];   // ignored in 'z' mode (0, ±1, ±2, ±3)
    onPointSelect?: (pointId: string) => void; height?: number }
  Marker shapes: accepted ●, warning ▲, rejected ✕ (+ rule text), excluded ○, unevaluated ◇, collecting ◌; keyboard:
  arrow keys move between points, Enter selects; visually hidden data table (02-CV §14).
Backward compatible? yes (new component).
```

Other foreseen CRs (not raised now) are listed in `06-IMPLEMENTATION-PLAN.md` §6.


# C10-microbiology  (own CRs: 10)

## 15. Change requests raised

Template per `program/04-CHANGE-REQUESTS.md` §2. All designed as if accepted.

### CR-C10-001: `SubmitModuleResultInput.amendment` + amendment reason seed
- From C10 → C0-0C (port) + C5 (implements) + C0-0B (seed). Type: port. Blocking: no (US-11 works without the reason reaching C5).
- Problem: 03-IC §4.5 says a submission on an approved result is an amendment (R7), and `lab.result.amended.v1` requires `amendment_reason_code` (03-IC §3.11), but `SubmitModuleResultInput` has no reason field (AC-11.2). Also a micro **final after an approved preliminary** is, by A1, an R7 amendment; C10 needs a distinct reason so C6 does not label a normal final "Amended" (see CR-C10-002).
- Proposed: `readonly amendment?: { readonly reasonCode: Code; readonly reasonText?: string /* ≤500 */ }` on `SubmitModuleResultInput`; required by C5 when the target result is `approved` (else C5 throws `lab.amendment_reason_required`, existing code); `reasonCode` from `lab.amendment_reasons`. Seed into `lab.g_cs_amendment_reasons`: `module_phase_progression` "Final after preliminary report".
- Backward compatible: yes (optional field). Security: reason text is P3, stays in C5/C10.
- Tests: LabPort contract additions — approved + amendment → event carries the code; approved without amendment → `lab.amendment_reason_required`.

### CR-C10-002: C6 report-kind rule for module phase progression
- From C10 → C6. Type: bug/behaviour (C6 02-TRD report-kind rule). Blocking: no.
- Problem: C6 classifies a report `amended` when any result has `versionNo > 1` and an earlier version was released. A micro final that follows an approved+released preliminary is version 2 of the result line, so it would print "Amended" instead of "Final".
- Proposed: in C6's first-match rule, a micro section whose `ResultView.amendment.reasonCode = 'module_phase_progression'` does not by itself make the report `amended`; the report kind then follows the remaining rules (`preliminary` if any micro section is preliminary, else `final`/`partial`). Later true amendments keep `amended`.
- Backward compatible: yes. Tests: C6 report-kind unit cases.

### CR-C10-003: `LabPort.lookupSpecimens`
- From C10 → C0-0C (port) + C5 (implements). Type: port. Blocking: no — default = manual matching (AC-08.4) and BFF display lookups.
- Problem: instrument records identify the sample only by `sample_barcode` (03-IC §3.14); C10 cannot read `lab.specimens` (R1); `getPendingTestsForBarcode` is a host query with side effects (S6 pick-up). C10 also wants `barcode`/`processing_centre_id` snapshots for worklists and RLS parity.
- Proposed:
  ```ts
  lookupSpecimens(ctx: RequestContext, input: { barcode: string } | { specimenIds: readonly Uuidv7[] /* 1..200 */ }):
    Promise<readonly { specimenId: Uuidv7; barcode: string; orderId: Uuidv7; patientId: Uuidv7; centreId: Uuidv7;
                       processingCentreId?: Uuidv7; specimenTypeCode: Code; status: SpecimenStatus; isActive: boolean }[]>;
  ```
  No side effects; RLS of the caller; user actors need `lab.specimen.read` (system actors: tenant-wide). Unknown/invisible → omitted. Contract tests: other tenant omitted; centre scope; old barcode of a recollected specimen resolves only to the old specimen (01 §2.1).
- Security: returns P2 (barcode) to an authorised caller only.

### CR-C10-004: Permission codes (`contracts/permissions.yaml`)
- From C10 → C0-0C. Type: api.
  - `{ code: micro.config.manage, privileged: false, roles: [lab_manager], phase: 2 }`
  - `{ code: micro.breakpoint.manage, privileged: true, roles: [lab_manager, pathologist], phase: 2 }` (changes interpretations → aal2, 04 A4 spirit)
  - change `micro.culture.work` roles to `[lab_technologist, pathologist]` (pathologists submit finals/amendments in C10).
- Security: privileged entry requires aal2.

### CR-C10-005: Error codes (`contracts/errors.yaml`)
- From C10 → C0-0C. Type: api.
```yaml
- { code: micro.culture_invalid_transition,     http: 409, owner: C10, title: "Culture cannot move to the requested state", meaning: "03-APP-FLOW §2.1" }
- { code: micro.isolate_invalid_transition,     http: 409, owner: C10, title: "Isolate cannot move to the requested state", meaning: "03-APP-FLOW §2.2" }
- { code: micro.ast_value_invalid,              http: 422, owner: C10, title: "AST value invalid", meaning: "MIC/zone syntax or range" }
- { code: micro.ast_category_not_allowed,       http: 422, owner: C10, title: "Interpretive category not allowed", meaning: "Not a code of the standard, or restricted for this antibiotic (04 D14)" }
- { code: micro.report_incomplete,              http: 422, owner: C10, title: "Report is incomplete", meaning: "Preliminary/final completeness guards" }
- { code: micro.amendment_reason_required,      http: 422, owner: C10, title: "Amendment reason required", meaning: "Reopen/amend needs a coded reason" }
- { code: micro.instrument_record_conflict,     http: 409, owner: C10, title: "Instrument record conflicts with existing data", meaning: "Choose use_instrument or keep_existing" }
- { code: micro.breakpoint_import_invalid,      http: 422, owner: C10, title: "Breakpoint file rejected", meaning: "Not UTF-8 text, NUL bytes, or duplicate file" }
- { code: micro.breakpoint_set_invalid_transition, http: 409, owner: C10, title: "Breakpoint set cannot change state", meaning: "03-APP-FLOW §2.5" }
- { code: micro.breakpoint_four_eyes_required,  http: 403, owner: C10, title: "Another user must activate this set", meaning: "Importer cannot activate own import" }
- { code: micro.code_duplicate,                 http: 409, owner: C10, title: "Code already used", meaning: "Protocol/panel code or active vocabulary map key exists" }
```

### CR-C10-006: Routes (`contracts/routes.yaml`)
- From C10 → C0-0C. Type: api. Needed for nav entries (routes with params are not nav entries — C0 04-UI-UX §3).
  - `{ id: staff.micro.worklist, origin: staff_web, path: /micro/worklist, owner: C10, permission: micro.culture.read }`
  - `{ id: staff.micro.instrument_records, origin: staff_web, path: /micro/instrument-records, owner: C10, permission: micro.culture.read }`
  - `{ id: staff.micro.settings, origin: staff_web, path: /micro/settings, owner: C10, permission: micro.config.manage }`
  - `{ id: staff.micro.breakpoint_sets, origin: staff_web, path: /micro/breakpoint-sets, owner: C10, permission: micro.breakpoint.manage }`
  - `{ id: staff.micro.breakpoint_set, origin: staff_web, path: /micro/breakpoint-sets/{breakpoint_set_id}, owner: C10, permission: micro.breakpoint.manage }`
  - existing `staff.micro.culture` unchanged.

### CR-C10-007: ID/AST driver mapping requirements (C7)
- From C10 → C7 (+ C0-0C note in 03-IC §3.14). Type: event semantics (no schema change). Blocking: only the ID/AST driver, itself BLOCKED B2.
- Problem: the result-level idempotency key `<instrument_id>:<sample_barcode>:<instrument_analyte_code>:<instrument_result_time>` (04 N10) does not contain the isolate. If a driver puts only the antibiotic code into `instrument_analyte_code`, the AST of isolate 2 collides with isolate 1 and is dropped by `core.event_log` uniqueness.
- Proposed rule for every driver emitting `organism_id`/`ast`: `instrument_analyte_code` = `ORG:<isolate_seq|1>` for organism records and `AST:<isolate_seq|1>:<antibiotic_code_raw>:<method>` for AST records (truncated to 64 → driver must reject longer and log a warning); `organism.isolate_seq`/`ast.isolate_seq` always set when the instrument provides an isolate number; `standard`/`standard_version` only when the instrument actually sends them (never defaulted in the driver — C10 applies instrument defaults). Simulator fixtures in C7 must include two isolates with the same antibiotic.
- Security: none (no new PHI).

### CR-C10-008: CSV upload support (UI kit + upload helper + bucket)
- From C10 → C0-0D (`FileUpload.accept` add `'text/csv'`) and C0-0A/C0-0B (CR-C4-005 helper allowlist entry `text/csv` with "text" sniffing = valid UTF-8 without NUL; private bucket `micro-imports`, first path segment `{tenant_id}`, `storage.objects` policies per 02-CV §5.8). Type: ui-kit + shared-lib + schema. Blocking: T-14 (import) — default meanwhile: local fake storage, `FileUpload` accept list extended in tests via MSW only.
- Security: CSV is never rendered as HTML; served back only as `attachment` (REQ-SEC-085); no malware scan (text-only, parsed by an in-house parser) — 07-SECURITY threat T-B4.

### CR-C10-009: Documentation alignment (lead / C0)
- (a) 02-CV §3 and §5.2 examples name `catalog.g_ast_interpretations` / `catalog.g_cs_ast_interpretations`, but C3 lists AST data out of its scope ("AST breakpoint tables and organism lists [C10]", C3 01-PRD) and defines no such table. C10 specifies `micro.g_cs_ast_interpretations`. Ask the lead to update the examples (build follows the C10 spec unless the lead rules otherwise; then C0 moves the table and C10 reads it via a CatalogPort method).
- (b) X4 makes **analyte** code maps catalog data. Organism/antibiotic vocabulary maps are not analytes; C10 keeps them in `micro.instrument_vocab_maps`. Ask the lead to confirm X4 does not cover them.
- (c) 03-IC §3.14 should note the CR-C10-007 driver rule.

### CR-C10-010: Access-log action codes
- From C10 → C0-0B (`audit.g_cs_access_actions` seed). Type: schema (seed).
- Codes: `micro.culture.view`, `micro.breakpoint_set.import`, `micro.breakpoint_set.activate`, `micro.breakpoint_set.retire`, `micro.instrument_record.assign`.


# C11-specialty-pathology  (own CRs: 11)

## 16. Change requests raised

Template per `program/04-CHANGE-REQUESTS.md` §2. All designed as if accepted.

### CR-C11-001: Additive columns on `anatomic.v_pub_report_content`
```
From chunk: C11   To owner: C0-0B (DDL) + doc owner (03-IC §6.8); consumers C6, C14 notified
Type: schema   Blocking? no (C6 renders 03-IC columns first; extra columns are optional sections)
Problem: US-09/US-10/US-11 — the 03-IC column list cannot carry molecular results, IHC/special-stain results,
  cytology slide assessments, addenda, specimen parts, clinical history, diagnosis codes or the version kind, so C6
  could not render them and an addendum would be indistinguishable from an amendment.
Proposed change (exact): append columns (after signed_at), types per C11 05-SCHEMA §5:
  version_kind text (original|revision|amendment|addendum), scope text (full|addendum_only),
  change_reason_code text, clinical_history_text text, comment_text text,
  specimen_parts jsonb, slides jsonb, ancillary jsonb, molecular jsonb, addenda jsonb, diagnosis_codes jsonb.
Backward compatible? yes (columns appended to a view; existing columns unchanged).
Tenant/security impact: same RLS (security_invoker); P3 content already present in the view; no new consumer.
Tests: view column-list test; JSON Schema validation per jsonb column; C6 fixture view updated.
```

### CR-C11-002: Permission codes
```
From: C11  To: C0-0C (contracts/permissions.yaml)  Type: api  Blocking? no (fake IdentityPort accepts configured codes)
Proposed:
  - { code: anatomic.case.work,     privileged: false, roles: [lab_technologist, pathologist], phase: 2 }
  - { code: anatomic.config.manage, privileged: true,  roles: [pathologist, lab_manager], phase: 2 }
  - change: anatomic.case.read roles += lab_manager   (tracking/config reads)
Security: config.manage privileged → aal2 (04 A4). Worker manifest declares anatomic.case.work, frontdesk.order.read, catalog.test.read.
```

### CR-C11-003: Error codes
```
From: C11  To: C0-0C (contracts/errors.yaml)  Type: api
- { code: anatomic.case_invalid_transition, http: 409, owner: C11, title: "Case cannot move to the requested state", meaning: "C11 TRD §7" }
- { code: anatomic.accession_pattern_invalid, http: 500, owner: C11, title: "Accession numbering configuration invalid", meaning: "Pattern tokens/charset invalid or counter overflow" }
- { code: anatomic.report_incomplete, http: 422, owner: C11, title: "Report incomplete", meaning: "Required report content missing at sign-out; details in errors[]" }
- { code: anatomic.template_invalid, http: 422, owner: C11, title: "Template definition invalid", meaning: "Synoptic definition violates schema; details in errors[]" }
- { code: anatomic.template_not_published, http: 409, owner: C11, title: "Template not published", meaning: "Draft or retired template used/retired" }
- { code: anatomic.block_not_available, http: 409, owner: C11, title: "Block not available", meaning: "Block sent out or discarded" }
- { code: anatomic.image_limit_reached, http: 422, owner: C11, title: "Image limit reached", meaning: "Per-case or per-report image limit" }
- { code: anatomic.image_not_ready, http: 409, owner: C11, title: "Image not ready", meaning: "Still processing or quarantined" }
- { code: anatomic.order_item_inactive, http: 409, owner: C11, title: "Order item no longer active", meaning: "Item removed/cancelled at front desk" }
- { code: anatomic.batch_closed, http: 409, owner: C11, title: "Batch closed", meaning: "" }
- { code: anatomic.batch_position_taken, http: 409, owner: C11, title: "Batch position already used", meaning: "" }
```

### CR-C11-004: Amendment reason on `LabPort.submitModuleResult`
```
From: C11  To: C0-0C (contracts/ports/LabPort.ts) + C5 (implements)  Type: port  Blocking? no (fake accepts)
Problem: US-10 — 03-IC §10.2 R7 requires a reason for every amendment and lab.result.amended.v1 requires
  amendment_reason_code, but SubmitModuleResultInput (A1) has no reason field, so a module amendment cannot carry one.
Proposed change (exact):
  SubmitModuleResultInput += readonly amendment?: { readonly reasonCode: Code; readonly reasonText?: string /* ≤500 */ };
  Semantics: required when the target result is approved (else C5 throws lab.amendment_reason_required);
  ignored otherwise. reasonCode must be in C5's amendment reason set.
  C5 seed lab.g_cs_amendment_reasons += { supplementary_report: "Supplementary report (addendum)" }.
Backward compatible? yes (optional field; C10 unaffected).
Default until merged: C11 sends `other` + reasonText for addenda and the chosen code for amendments; C11's
  change_reasons seed uses the C5 codes (transcription_error, instrument_error, wrong_patient_sample,
  calculation_error, clinical_review, other).
Tests: LabPort contract additions — amendment without reason → lab.amendment_reason_required; with reason →
  lab.result.amended.v1 carries it.
```

### CR-C11-005: Accession number patterns in `TenantSettings.numbering`
```
From: C11  To: C0-0C (IdentityPort TenantSettings) + C2 (settings UI/validation)  Type: port
Problem: 03-IC §9.3 says patterns live in TenantSettings.numbering, but numbering has no accession entry.
Proposed: numbering += { accessionNoPattern?: string /* default '{prefix}{yy}-{seq:4}' */;
  accessionPrefixes?: { histology?: string; cytology?: string; ihc?: string; molecular?: string } /* [A-Z0-9]{0,4} */ }
  C2 validates with C11's grammar (02-TRD §4.2; shared via @lims/shared-ts numbering helper if C0 provides one).
Default until merged: built-in pattern + prefixes S/C/I/M (§4.2). Backward compatible: yes.
```

### CR-C11-006: Routes
```
From: C11  To: C0-0C (contracts/routes.yaml)  Type: api
- { id: staff.anatomic.worklist,  origin: staff_web, path: /anatomic,                         owner: C11, permission: anatomic.case.read }
- { id: staff.anatomic.labels,    origin: staff_web, path: /anatomic/cases/{case_id}/labels,  owner: C11, permission: anatomic.case.work }
- { id: staff.anatomic.tracking,  origin: staff_web, path: /anatomic/tracking,                owner: C11, permission: anatomic.case.read }
- { id: staff.anatomic.batches,   origin: staff_web, path: /anatomic/batches,                 owner: C11, permission: anatomic.case.read }
- { id: staff.anatomic.batch,     origin: staff_web, path: /anatomic/batches/{batch_id},      owner: C11, permission: anatomic.case.read }
- { id: staff.anatomic.config,    origin: staff_web, path: /anatomic/config,                  owner: C11, permission: anatomic.config.manage }
- { id: staff.anatomic.template,  origin: staff_web, path: /anatomic/config/templates/{template_id}, owner: C11, permission: anatomic.config.manage }
(staff.anatomic.case already exists — 03-IC §7.)
```

### CR-C11-007: UI-kit `BarcodeSymbol` (Code 128 SVG)
```
From: C11  To: C0-0D (packages/ui)  Type: ui-kit  Blocking? no (labels print text only until merged)
Problem: US-13 AC-13.3 — block/slide labels need a scannable symbol; C5's encoder lives in C5's feature folder and
  may not be imported or copied (01-CM §4).
Proposed: move C5's in-house Code 128 encoder into @lims/ui as
  interface BarcodeSymbolProps { value: string /* ^[A-Z0-9-]{1,32}$ */; heightMm?: number /* default 8 */;
    moduleWidthMm?: number /* default 0.25 */; showText?: boolean /* default true */; ariaLabel: string }
  (renders inline SVG; never logs the value). C5 then imports it too (C5 agrees via its own PR).
Tests: golden SVGs for sample values incl. hyphen; decode check with a reference decoder in tests only.
```

### CR-C11-008: Storage bucket `anatomic-images` and pipeline guarantees
```
From: C11  To: C0-0B (bucket + storage.objects policies) + C0-0A (ctx.uploads/ctx.storage, = CR-C2-011)
Type: schema + shared-lib   Blocking? yes for C11-T10 (real uploads); no otherwise (fake pipeline)
Proposed: private bucket 'anatomic-images', object path {tenant_id}/{yyyy}/{mm}/{image_id}.{png|jpg};
  write by API/worker server credentials only; read by API (C11) and C6 render path (server-side ctx.storage);
  storage.objects SELECT policy on first path segment only if SP-4 succeeds (C0 05-SCHEMA §8 template);
  no client-side Storage access.
  ctx.uploads guarantees relied on: magic-byte allowlist (png/jpeg), ≤ maxBytes, re-encode that strips metadata
  (EXIF/GPS), maxMegapixels guard, ClamAV-class scan with quarantine, sha256 + byte size + mime + dimensions returned.
Tests: cross-tenant path read refused by adapter; EXIF stripped (synthetic JPEG with GPS tag); 60 MP image rejected.
```

### CR-C11-009: Add-on tests that use existing material (C3 + C5)
```
From: C11  To: C3 (catalog attribute) + C5 (specimen creation) + C0-0C (CatalogPort TestDefinition)  Type: port
Blocking? no
Problem: US-05 — an IHC/special-stain add-on billed as an order item needs a pending C5 result (so C11 can submit it)
  but no new specimen; today C5 would create an 'ordered' specimen requirement that is never collected.
Proposed: TestDefinition += readonly usesExistingMaterial?: boolean; C5: for such items create order_tests/results
  (status pending) without a specimen requirement; C4 shows no collection need.
Default until merged: labs configure add-on tests with the parent specimen type; C11 links the item manually
  (linkAnatomicAddonItem); a stray 'ordered' specimen may appear in C5's status board (documented risk, 06 plan R4).
```

### CR-C11-010: Documentation — "sign-out" vs the A1 chain (doc owner)
```
From: C11  To: doc owner (06-GLOSSARY "Sign-out")  Type: doc
Problem: the glossary says sign-out is "equivalent to approval for C11 reports", but 03-IC §4.5 A1 (higher precedence)
  puts module results at 'resulted' and requires C5 verify (R4) and approve (R6, approver ≠ verifier).
Proposed: glossary text → "Sign-out = the pathologist signs the anatomic report in C11; the result then passes C5
  verification and pathologist approval (A1) before release." C11 builds to 03-IC. A future C5 option to accept
  module results signed by a holder of lab.result.approve as verified is a separate, client-approved CR (Q4).
```

### CR-C11-011: C11 as consumer of `lab.result.approved.v1` and `lab.result.amended.v1`
```
From: C11  To: C0-0C + doc owner (03-IC §3.10, §3.11, §3.25 consumer lists); producer C5 agrees  Type: event (new consumer)
Blocking? no
Problem: US-13 — the "Awaiting lab approval" worklist needs to know which signed-out cases C5 has approved without
  calling LabPort per row (performance, 02-TRD §11).
Proposed: add C11 to the consumers of lab.result.approved.v1 and lab.result.amended.v1 (payloads unchanged, P3
  pseudonymous). C11 updates case_items.lab_approved_version_no / lab_approved_at (05-SCHEMA).
Default until merged: queue awaiting_lab returns 403 common.feature_disabled and the tab is hidden.
Backward compatible? yes. Tests: duplicate/out-of-order delivery; non-anatomic result id → no-op.
```

### Acknowledged CRs of other chunks relied on
CR-C5-003 (`lab_display` purpose + `getPatientDemographicsBatch`), CR-C6-006 (`ResultView.moduleRef`, used by C6 to find C11's view rows), CR-C6-010 (`ImageThumbnailGrid`), CR-C2-011 (upload pipeline + storage adapter), CR-C6-012 (C6 listed as consumer of published views).


# C12-inventory  (own CRs: 9)

## 17. Change requests raised

Every CR below is designed as if accepted and is non-blocking unless stated. The default built meanwhile is named in each.

```
Title: CR-C12-001: inventory permission codes and role grants
From chunk: C12            To owner: C0-0C (contracts/permissions.yaml)
Type: api                   Blocking? no — default: fake IdentityPort registry seeded with these codes in C12 tests
Problem: IC §11 has only inventory.item.read and inventory.stock.manage. PRD §2 needs separation of master data,
  privileged adjustments (can hide loss — REQ-SEC-055 analogue), PO approval (money commitment), cost visibility
  (REQ-SEC-081) and data export (privileged per 04 A4 "data-export roles").
Proposed (all phase: 2):
  - { code: inventory.master.manage,  privileged: false, roles: [lab_manager] }
  - { code: inventory.stock.adjust,   privileged: true,  roles: [lab_manager] }
  - { code: inventory.po.manage,      privileged: false, roles: [lab_manager, finance] }
  - { code: inventory.po.approve,     privileged: true,  roles: [lab_manager, finance] }
  - { code: inventory.cost.read,      privileged: false, roles: [lab_manager, finance, owner_viewer] }
  - { code: inventory.report.export,  privileged: true,  roles: [lab_manager, finance, owner_viewer] }
  - { code: inventory.bench.record,   privileged: false, roles: [lab_technologist, lab_manager] }
  - change: inventory.item.read roles [lab_manager, lab_technologist] → [lab_manager, lab_technologist, finance, owner_viewer]
Backward compatible? yes (additive; the role-list change only widens read access).
Tenant/security impact: privileged codes force aal2 (04 A4). Tests: role matrix in probes.
```
```
Title: CR-C12-002: staff routes for inventory screens
From chunk: C12            To owner: C0-0C (contracts/routes.yaml)
Type: api                   Blocking? no — default: nav built from these ids in C12's local test manifest
Problem: IC §7 has only staff.inventory.item (a detail route; not a nav entry — C0 04-UI-UX §3).
Proposed (origin staff_web, owner C12):
  staff.inventory.home         /inventory                                  inventory.item.read
  staff.inventory.items        /inventory/items                            inventory.item.read
  staff.inventory.stock        /inventory/stock                            inventory.item.read
  staff.inventory.purchase_orders /inventory/purchase-orders               inventory.item.read
  staff.inventory.purchase_order  /inventory/purchase-orders/{po_id}       inventory.item.read
  staff.inventory.receipts     /inventory/receipts                         inventory.item.read
  staff.inventory.receipt      /inventory/receipts/{grn_id}                inventory.item.read
  staff.inventory.transfers    /inventory/transfers                        inventory.item.read
  staff.inventory.transfer     /inventory/transfers/{transfer_id}          inventory.item.read
  staff.inventory.counts       /inventory/counts                           inventory.item.read
  staff.inventory.count        /inventory/counts/{count_id}                inventory.item.read
  staff.inventory.bench        /inventory/bench                            inventory.bench.record
  staff.inventory.rules        /inventory/rules                            inventory.item.read
  staff.inventory.unresolved   /inventory/unresolved                       inventory.item.read
  staff.inventory.alerts       /inventory/alerts                           inventory.item.read
  staff.inventory.reports      /inventory/reports                          inventory.item.read
  staff.inventory.suppliers    /inventory/suppliers                        inventory.item.read
  staff.inventory.stores       /inventory/stores                           inventory.item.read
  staff.inventory.settings     /inventory/settings                         inventory.master.manage
Params are UUIDs only (REQ-SEC-098). Backward compatible: yes.
```
```
Title: CR-C12-003: inventory error codes
From chunk: C12            To owner: C0-0C (contracts/errors.yaml)
Type: api                   Blocking? no
Proposed (owner C12):
- { code: inventory.code_duplicate,            http: 409, title: "Code already used", meaning: "item/pack/store/supplier/barcode code exists in the tenant" }
- { code: inventory.item_inactive,             http: 409, title: "Item inactive", meaning: "" }
- { code: inventory.item_in_use,               http: 409, title: "Item in use", meaning: "Deactivation blocked: stock or open PO lines" }
- { code: inventory.store_not_empty,           http: 409, title: "Store not empty", meaning: "Deactivation blocked: non-zero balance" }
- { code: inventory.po_self_approval_forbidden,http: 403, title: "Approver must differ from creator", meaning: "Tenant setting" }
- { code: inventory.over_receipt,              http: 422, title: "Received quantity exceeds order", meaning: "Beyond tolerance" }
- { code: inventory.document_invalid_transition,http: 409, title: "Document state change not allowed", meaning: "GRN/transfer/count/container/fact/alert" }
- { code: inventory.lot_unavailable,           http: 409, title: "Lot not available", meaning: "Quarantined or blocked" }
- { code: inventory.reason_required,           http: 422, title: "Reason required", meaning: "" }
- { code: inventory.fact_not_reversible,       http: 409, title: "Consumption cannot be reversed", meaning: "Only manual facts are reversible" }
- { code: inventory.store_locked_for_count,    http: 409, title: "Store is being counted", meaning: "Tenant setting count_locks_store" }
- { code: inventory.count_already_open,        http: 409, title: "A count is already open for this store", meaning: "" }
- { code: inventory.rule_conflict,             http: 409, title: "A current rule exists", meaning: "Supersede the existing rule instead" }
- { code: inventory.export_too_large,          http: 422, title: "Export too large", meaning: "Row cap exceeded; narrow the range" }
- { code: inventory.range_too_large,           http: 422, title: "Date range too large", meaning: "" }
Backward compatible: yes.
```
```
Title: CR-C12-004: optional processing_branch_id on lab.result.verified.v1
From chunk: C12            To owner: C0-0C (producer C5 must agree; consumers C8, C9 informed)
Type: event (additive)       Blocking? no — default: store resolution skips step 3 (02-TRD §8.2); multi-branch tenants with
  manual (non-instrument) results fall back to the tenant default store or to the unresolved queue.
Problem: verified events carry no branch, so C12 cannot pick the consuming branch's store for results without an instrument.
  C5 already holds results.processing_branch_id (C5 05-SCHEMA; lab.v_pub_result_daily exposes it).
Proposed: Payload property "processing_branch_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } (optional).
Backward compatible? yes (CV §7.2). PHI: none added (P1 id of a branch).
```
```
Title: CR-C12-005: published view instruments.v_pub_instrument_directory
From chunk: C12            To owner: C0-0B (C7 must agree)
Type: schema (view)          Blocking? no — default: UI shows instrument ids and uses C7's HTTP list (user token) for pickers;
  store resolution skips step 4.
Problem: C12 stores instrument ids (bindings, rules, movements) and must label them in server-built reports and CSV exports
  (no user-facing HTTP call inside a report query). CM §5 R1 forbids reading instruments tables.
Proposed: CREATE VIEW instruments.v_pub_instrument_directory WITH (security_invoker = true) AS
  SELECT tenant_id, id AS instrument_id, instrument_code, display_name, centre_id, state, is_active FROM instruments.instruments;
  GRANT SELECT … TO lims_app; consumers C12 (and C8 if wanted).
Security: P0 (no PHI). Backward compatible: yes.
```
```
Title: CR-C12-006: new event instruments.calibration.received.v1
From chunk: C12            To owner: C0-0C + C7 (producer)
Type: event (new)            Blocking? no — default: manual calibration log (PRD US-15). Also depends on B2 (manuals), since a
  driver must classify calibrator records (C7 06-IMPLEMENTATION-PLAN §6 already foresees this CR).
Problem: per-calibration consumption (00 §3 item 7 "per cal"; 01 research §2.6 "inferred from calibrator-flagged interface
  records") has no LIS fact. C5 discards calibrator samples as ingest exceptions (C5 05-SCHEMA exception_discard_reasons
  qc_or_calibrator_sample).
Proposed payload (P0): instrument_message_id, instrument_id, centre_id, instrument_analyte_code, mapping_status,
  analyte_id?, test_id?, calibrator_id_raw? (≤64), calibrator_lot_raw? (≤64), instrument_result_time?, received_at.
  Idempotency key: <instrument_id>:cal:<instrument_analyte_code>:<instrument_result_time or sha256(raw)>.
  Consumer: C12 → fact_kind 'calibration', basis key 'cal:<sha256(idempotency_key)>', same rules as manual.
Backward compatible: yes (new event).
```
```
Title: CR-C12-007: numbering registry entries (IC §9.3)
From chunk: C12            To owner: doc owner (IC §9.3) — no code change in C0
Type: api (documentation)    Blocking? no
Proposed rows: po_no (C12, PO{yy}{seq:6}, tenant + period, gaps allowed), grn_no (GR{yy}{seq:6}), transfer_no (TR{yy}{seq:6}),
  count_no (SC{yy}{seq:5}), doc_no (SD{yy}{seq:6}). Patterns are tenant settings in inventory.settings (not TenantSettings.numbering:
  these are module-internal, non-fiscal). Never in URLs or logs except as display (IC §9.3 rule).
```
```
Title: CR-C12-008: inventory system actor and alert purge function
From chunk: C12            To owner: C0-0B (db/meta/system-actors.yaml, purge inventory)
Type: schema                 Blocking? no — default: worker tests use the fake system actor
Proposed: system actor 'inventory' with permissions [inventory.item.read, inventory.stock.manage] (consumer writes are
  service-level and do not call assertRole, but the declaration is required by IC §11 "system: declared per worker manifest");
  function app.purge_inventory_alerts() RETURNS integer — LANGUAGE sql, SECURITY INVOKER, owned by lims_owner, deletes
  inventory.alerts rows with expires_at < now() in batches of 10,000 (CV §5.11 purge pattern). Called by inventory.purge_alerts.
```
```
Title: CR-C12-009: DecimalField suffix (unit) prop in @lims/ui
From chunk: C12            To owner: C0-0D
Type: ui-kit                 Blocking? no — default: unit shown as a separate text element after the field
Problem: every quantity input needs its unit visible inside the field ("400 test", "0.1 mL") for accessibility of the label.
Proposed: DecimalFieldProps.suffix?: string (same behaviour as TextFieldProps.suffix).
```


# C13-b2b-partner-portal  (own CRs: 13)

## 15. Change requests raised

Each follows `program/04-CHANGE-REQUESTS.md`; C13 builds as if accepted, against fakes.

```
Title: CR-C13-001: CODEOWNERS for C13 staff-web segment, worker jobs and manual
From chunk: C13            To owner: C0-0A
Type: shared-lib (path allocation)   Blocking? yes — T16–T20 (staff screens)
Problem: 01 §2 lists C13 deployables as "api partners, apps/partner"; the staff intake screens (US-01, US-06, US-10,
  US-13) need apps/web/src/app/(staff)/partners/** and apps/web/src/features/partners/**, which the 01 §3 module→owner
  rule already assigns to the `partners` module owner.
Proposed change: CODEOWNERS entries for those two paths, services/worker/src/jobs/partners/**, docs/manual/partners/** → C13.
Backward compatible? yes   Security impact: none (staff shell rules apply)
Alternatives: put staff screens in apps/partner (rejected: staff must not authenticate on the partner origin).
```

```
Title: CR-C13-002: Permission codes and partner roles in contracts/permissions.yaml
From chunk: C13            To owner: C0-0C (C2 must agree)
Type: api   Blocking? yes — T03 (authz), T07
Problem: 03 §11 gives one fixed partner set; PRD US-02/US-10/US-13 need an admin/member split, pickup and referrer
  permissions, and staff intake permissions.
Proposed change:
  permissions:
  - { code: partners.partner.read,        privileged: false, roles: [tenant_admin, front_desk, centre_staff, finance, lab_manager], phase: 2 }
  - { code: partners.manifest.receive,    privileged: false, roles: [front_desk, centre_staff, lab_technologist], phase: 2 }
  - { code: partners.pickup.manage,       privileged: false, roles: [front_desk, centre_staff], phase: 2 }
  - { code: partners.referrer.map,        privileged: false, roles: [tenant_admin, lab_manager], phase: 2 }
  - { code: partners.pickup.request,      privileged: false, roles: [], phase: 2 }   # partner actors
  - { code: partners.referrer.read,       privileged: false, roles: [], phase: 2 }   # partner actors
  - { code: partners.referrer.manage,     privileged: false, roles: [], phase: 2 }   # partner_admin only
  - { code: partners.partner_user.manage, privileged: true,  roles: [], phase: 2 }   # partner_admin only
  partner_roles:          # new block; fixed, not tenant-editable
  - { code: partner_member, mfa_required: false }
  - { code: partner_admin,  mfa_required: true }
  fixed_actor_permissions.partner becomes a map by partner role:
    partner_member: [partners.order.read, partners.manifest.submit, partners.report.read, partners.statement.read,
                     partners.price_list.read, partners.pickup.request, partners.referrer.read]
    partner_admin:  [<partner_member set>, partners.referrer.manage, partners.partner_user.manage]
  CI rule: a partner-only code (roles: []) may never be granted to a tenant role; staff codes never to partner roles.
Backward compatible? yes (the existing five codes stay in both sets)
Tenant/security impact: partner_user.manage privileged → aal2 + membership re-validation (03 §11); partner admin MFA (04 A4 extended).
Tests: IdentityPort contract cases added: partner_member lacks partner_user.manage; partner_admin at aal1 → mfa_required;
  staff role cannot be granted partners.order.read.
```

```
Title: CR-C13-003: Partner sessions, partner login and partner membership provisioning (identity)
From chunk: C13            To owner: C2 (+ C0-0C for IdentityPort and identity.yaml; C0-0B for identity DDL)
Type: port + api + schema   Blocking? yes — T05, T06, T11
Problem: US-02/US-03 need partner users to sign in on the partner origin with MFA for partner admins; C2's sessions
  support kinds tenant_staff|platform only (C2 05-SCHEMA identity.sessions kind CHECK), the claims resolver emits
  actor_type 'user' only, and no port creates partner memberships. C13 may not write core.* or call GoTrue.
Proposed change:
 (a) identity.sessions.kind CHECK adds 'partner'; kind_shape: tenant_id + membership_id NOT NULL for 'partner'.
 (b) identity.yaml: new operation loginPartner POST /v1/identity/auth/partner/login (same request/response/errors/tier
     as loginStaff; x-public "pre-authentication; reachable only from the partner BFF network"); it accepts only
     memberships with actor_type 'partner' and creates kind 'partner'. loginStaff rejects partner memberships with the
     generic auth.login_failed. All other /auth/* operations (mfa verify/enrol, resolve, logout, password recover,
     token confirm, password set) accept a session of either kind; resolveSession requires header X-Lims-Origin
     (staff_web | partner) to equal the session's kind binding, else 401 auth.session_expired.
 (c) app.identity_resolve_session + claims builder: for kind 'partner' emit
     { sub, tenant_id, membership_id, actor_type: 'partner', aal, lims_session_id, session_state }.
 (d) Invitations/recovery for partner memberships use redirect origin LIMS_ORIGIN_PARTNER + '/auth/confirm'
     (GoTrue redirect allow-list must include the partner origin — UNVERIFIED for the pinned GoTrue; C2 T1 mapping).
 (e) IdentityPort V1 additive methods (run in caller tx; caller must hold partners.partner.manage (staff) or
     partners.partner_user.manage (partner admin of the same partner — C2 trusts the C13 assertion only for the
     partner id argument it receives from C13's service, never from HTTP input)):
     provisionPartnerMembership(ctx, input: { email: string; displayName: string;
        partnerRole: 'partner_admin' | 'partner_member' }): Promise<{ membershipId: Uuidv7; userId: Uuid;
        invitationId: Uuidv7; status: 'invited' }>
        @throws identity.user_exists (email has a staff or partner membership in any tenant), identity.tenant_suspended
     updatePartnerMembership(ctx, input: { membershipId: Uuidv7; action: 'deactivate' | 'reactivate' | 'set_role' |
        'resend_invitation'; partnerRole?: 'partner_admin' | 'partner_member'; reasonCode?: Code; expectedVersion: number }):
        Promise<{ membershipId: Uuidv7; status: 'invited' | 'active' | 'deactivated'; version: number }>
        @throws common.version_conflict, identity.membership_inactive; revokes sessions on deactivate/role change
        (job identity.gotrue_signout) — live on next request (C2 02-TRD §4.5).
     Both refuse memberships whose actor_type is not 'partner' (common.not_found).
 (f) getActor for actor_type 'partner': permissions = fixed_actor_permissions.partner[<partner role>] (CR-C13-002),
     centreScope { all: false, centreIds: [] }, mfa from claims; roles = [<partner role>].
Backward compatible? yes (additive)
Security: new pre-auth surface on the partner network only (nginx per-IP login limit — C1); MFA for partner_admin;
  origin binding prevents cross-portal session use; REQ-SEC-062/064/065/067/068/073/076.
Alternatives: separate identity store for partners (rejected: duplicates C2 controls); partner_id claim (rejected:
  CR-C13-004 derives it in SQL, no stale-claim risk).
Tests: C2 contract cases: partner login on staff op → login_failed; staff session resolved with X-Lims-Origin partner →
  session_expired; partner_admin without TOTP → mfa_enrolment_required; deactivate → next request 403/401.
```

```
Title: CR-C13-004: RLS helper app.current_partner_id()
From chunk: C13            To owner: C0-0B
Type: schema   Blocking? yes — T02 (DDL)
Proposed change:
  CREATE FUNCTION app.current_partner_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT CASE WHEN app.current_actor_type() = 'partner' THEN (
      SELECT pu.partner_id FROM partners.partner_users pu
      JOIN partners.partners p ON p.tenant_id = pu.tenant_id AND p.id = pu.partner_id
      WHERE pu.tenant_id = app.current_tenant_id()
        AND pu.membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
        AND pu.status IN ('invited','active') AND p.status = 'active') END
  $$;
  Owned by lims_owner; EXECUTE to lims_app; inventoried per 04 D7 (search_path '', schema-qualified, no caller-supplied
  arguments). 'invited' is accepted because C2's resolver already refuses any membership that is not active
  (C2 02-TRD §6.2); C13 flips its mirror invited → active on the user's first partner request (03-APP-FLOW §6.2).
  'deactivated' always yields NULL.
Backward compatible? yes   Security: DEFINER needed because partner_users RLS itself uses this helper (42P17 recursion,
  REQ-SEC-021). Fail-closed NULL for every non-partner actor.
Tests: helper returns NULL for user/system/portal/patient/device claims; NULL for suspended partner; NULL for
  deactivated partner user; correct id otherwise; cross-tenant membership id → NULL.
```

```
Title: CR-C13-005: ReportingPort.openReleasedReportFile + partner-actor RLS on reporting tables
From chunk: C13            To owner: C0-0C (port), C0-0B (policies), C6 must agree (implements)
Type: port + schema   Blocking? yes — T13 (download); fake until merged
Problem: US-08 requires partners to download released PDFs. ReportingPort has only getReleasedReports and
  issuePortalLink; the portal link path needs an OTP to a patient destination, which is wrong for an authenticated B2B
  user. C6 02-TRD §7.1 expects C13 to define partner claim shapes for partner RLS.
Proposed change (additive, ReportingPortV1):
  export interface ReleasedReportFile { readonly reportVersionId: Uuidv7; readonly reportId: Uuidv7; readonly versionNo: number;
    readonly status: 'valid' | 'superseded'; readonly contentType: 'application/pdf'; readonly byteSize: number;
    readonly sha256: string; readonly signedUrl: string; readonly expiresAt: IsoUtc }
  /** Released or superseded versions only. Partner actors: reports.partner_id = app.current_partner_id(); patient actors
   *  (C16, later) their own patient ids. signedUrl is internal (Storage), TTL ≤ 300 s, never logged or returned to browsers.
   *  @throws common.not_found (unknown, unreleased, other tenant/partner — indistinguishable) */
  openReleasedReportFile(ctx: RequestContext, input: { reportId: Uuidv7; versionNo: number }): Promise<ReleasedReportFile>;
  Partner policies (C6 tables read by this method and by getReleasedReports): SELECT ... TO lims_app USING
    (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
     AND partner_id = (SELECT app.current_partner_id()) [AND status IN ('released','superseded') on report_versions
     via the parent report]). Storage read for the object path is performed by the C6 implementation with its own
     credentials (C0 storage adapter, CR-C4-005), not by the partner's claims (04 D3 UNVERIFIED for claims in Storage).
Backward compatible? yes   Security: new partner read path to PHI (REQ-SEC-034/035/096); access logged by caller (C13).
Fake: returns a synthetic PDF from packages/test-fixtures and a fake URL; contract cases: (1) unreleased → not_found;
  (2) other partner → not_found; (3) superseded returns status superseded; (4) sha256 matches bytes; (5) other tenant → not_found.
```

```
Title: CR-C13-006: C13 consumes frontdesk.order.cancelled.v1 and catalog.changed.v1
From chunk: C13            To owner: C0-0C (C4, C3 as producers agree)
Type: event (consumer list only)   Blocking? no — reconcile and nightly jobs cover the gap
Problem: US-07.7 (lab-side cancellation) and US-11.3 (new price list version) would otherwise wait for polling.
Proposed: add C13 to the consumer lists in 03 §3.3 and §3.19 / §3.25 and 01 §5.1. No payload change. P1/P0 events.
```

```
Title: CR-C13-007: C13 as CatalogPort consumer
From chunk: C13            To owner: C0-0C (C3 agrees)
Type: port (consumer list)   Blocking? no — fake
Problem: panel names for price-list items (catalog.v_pub_test_directory covers tests only) and server-side validation of
  doctor/credit-party ids (SR2, SA2) need CatalogPort; 03 §4.2 does not list C13.
Proposed: add C13 to CatalogPort consumers for getTest, getPanel, getReferrer and getCreditParty (the last two per CR-C3-001).
```

```
Title: CR-C13-008: routes.yaml entries for C13 staff screens
From chunk: C13            To owner: C0-0C
Type: api (routes)   Blocking? yes — T16 (nav manifest build check)
Proposed:
  - { id: staff.partners.list,      origin: staff_web, path: /partners,                          owner: C13, permission: partners.partner.read }
  - { id: staff.partners.partner,   origin: staff_web, path: /partners/{partner_id},             owner: C13, permission: partners.partner.read }
  - { id: staff.partners.inbox,     origin: staff_web, path: /partners/manifests,                owner: C13, permission: partners.manifest.receive }
  - { id: staff.partners.manifest,  origin: staff_web, path: /partners/manifests/{manifest_id},  owner: C13, permission: partners.manifest.receive }
  - { id: staff.partners.pickups,   origin: staff_web, path: /partners/pickups,                  owner: C13, permission: partners.pickup.manage }
  - { id: staff.partners.referrers, origin: staff_web, path: /partners/referrers,                owner: C13, permission: partners.referrer.map }
  - { id: staff.partners.settings,  origin: staff_web, path: /partners/settings,                 owner: C13, permission: partners.partner.manage }
  The four partner-origin routes in 03 §7 stay unchanged.
```

```
Title: CR-C13-009: partners error codes
From chunk: C13            To owner: C0-0C
Type: api   Blocking? no
Proposed (owner C13):
- { code: partners.manifest_not_editable,          http: 409, title: "Manifest can no longer be edited", meaning: "Lines are read-only after submit" }
- { code: partners.manifest_invalid_transition,    http: 409, title: "Manifest cannot move to the requested state", meaning: "03-APP-FLOW §2.1" }
- { code: partners.manifest_line_invalid_transition, http: 409, title: "Manifest line cannot move to the requested state", meaning: "03-APP-FLOW §2.2" }
- { code: partners.orderable_not_offered,          http: 422, title: "Test not offered to this partner", meaning: "Not in the partner price-list projection" }
- { code: partners.pickup_invalid,                 http: 422, title: "Pickup request invalid", meaning: "Window or manifest rules" }
- { code: partners.pickup_invalid_transition,      http: 409, title: "Pickup cannot move to the requested state", meaning: "03-APP-FLOW §2.3" }
- { code: partners.partner_invalid_transition,     http: 409, title: "Partner cannot move to the requested state", meaning: "" }
- { code: partners.partner_user_invalid_transition, http: 409, title: "Partner user cannot move to the requested state", meaning: "" }
- { code: partners.last_partner_admin,             http: 409, title: "Cannot remove the last partner admin", meaning: "" }
- { code: partners.self_action_forbidden,          http: 409, title: "You cannot change your own access", meaning: "" }
- { code: partners.code_duplicate,                 http: 409, title: "Partner code already used", meaning: "" }
- { code: partners.credit_party_in_use,            http: 409, title: "Credit party already linked to a partner", meaning: "" }
- { code: partners.credit_party_inactive,          http: 422, title: "Credit party inactive", meaning: "" }
- { code: partners.referrer_duplicate,             http: 409, title: "Referrer already exists", meaning: "" }
- { code: partners.referrer_not_mapped,            http: 422, title: "Referrer not yet linked by the lab", meaning: "require_mapped_referrer" }
- { code: partners.referrer_doctor_inactive,       http: 422, title: "Doctor record inactive", meaning: "" }
- { code: partners.referrer_invalid_transition,    http: 409, title: "Referrer mapping cannot change", meaning: "" }
- { code: partners.setting_out_of_range,           http: 422, title: "Setting out of allowed range", meaning: "02-TRD §10.2" }
Existing (03 §8): partners.manifest_invalid (422), partners.partner_inactive (403).
```

```
Title: CR-C13-010: Agreement on CR-C4-006 and collection_mode for partner manifests
From chunk: C13            To owner: C0-0C (C4)
Type: port   Blocking? no (C4's fake)
C13 agrees to CR-C4-006 (BookingOrderInput.partnerId?, required when source = 'partner_manifest') and asks C4 to
  (a) set orders.collection_mode = 'partner' for source 'partner_manifest'; (b) validate that creditPartyId is the
  credit party the partner was created with is NOT C4's job — C13 guarantees it; (c) keep partner_id immutable on the order.
```

```
Title: CR-C13-011: Actor-type guard on tenant-only RLS policies (defence in depth)
From chunk: C13            To owner: C0-0B (security sign-off)
Type: schema   Blocking? no
Problem: tenant-only policies (__tenant variant, e.g. catalog tables) admit every actor type with the tenant claim,
  including partner/portal/patient actors. Today only IdentityPort authz stops a partner token from reading, e.g.,
  other partners' credit-party contacts through a catalog endpoint.
Proposed: helper app.is_staff_or_system() := app.current_actor_type() IN ('user','system','device'); C0 adds it to every
  __tenant policy of tables not intentionally readable by partner/portal/patient actors (default: all). Tables that
  need such access get an explicit actor-specific policy (as partners.* and CR-C13-005 do).
Backward compatible? yes for staff/system; tests: probes with partner claims on every tenant-only table → 0 rows.
```

```
Title: CR-C13-012: access-log action codes
From chunk: C13            To owner: C0-0B (audit.g_cs_access_actions seed)
Proposed codes: manifest.print, report.access_slip, statement.view. (report.download, report.view, patient.view exist.)
```

```
Title: CR-C13-013: @lims/ui QrCode component
From chunk: C13            To owner: C0-0D
Type: ui-kit   Blocking? no (US-09 is off by default)
Props: { value: string; sizePx: 96–256; label: string /* accessible name */; level?: 'M' | 'Q' }. Renders inline SVG
  locally (no network, 04 §11); value never logged; story with a synthetic value. Library choice and licence by C0.
```


# C14-smart-report  (own CRs: 8)

## 15. Change requests raised

### CR-C14-001 — SmartSummary additive display fields
```
Title: CR-C14-001: SmartSummary optional display fields for renderer and app
From chunk: C14            To owner: C0-0C (C14 implements; consumers C6, C16 acknowledge)
Type: port
Blocking? yes for C14-T22 (renderer fragment) and C16 display; C14 builds the fields behind the flag
  `// CR-C14-001` meanwhile
Problem: the renderer receives only the SmartSummary payload (C6-TRD §5.3) and calls no port. The 03-IC shape
  carries ids only (panelCode, analyteId, templateBlockId, disclaimerBlockId, pointResultIds), so tile names,
  analyte names, test names, trend values and the disclaimer text cannot be printed (PRD US-09.5, US-13.1, US-16).
Proposed change (exact; all new fields optional, SMART_REPORT_PORT_VERSION stays 1):
  export interface SmartSummary {
    /* existing fields unchanged */
    readonly language?: 'en' | 'ne';
    readonly builtAt?: IsoUtc;
    readonly healthScore?: { /* existing */ readonly explanationText?: string };
    readonly panels: readonly { /* existing */ readonly displayName?: string }[];
    readonly deranged: readonly { /* existing */ readonly analyteName?: string }[];
    readonly followUps: readonly { /* existing */ readonly suggestedTestName?: string }[];
    readonly trends: readonly { /* existing */ readonly analyteName?: string; readonly unitCode?: Code;
      readonly points?: readonly { readonly resultId: Uuidv7; readonly approvedAt: IsoUtc; readonly valueNumeric: DecimalString }[] }[];
    readonly disclaimerText?: string;
  }
Backward compatible? yes (optional fields only).
Tenant/security impact: no new PHI class (summary is already P3); values in trends.points are approved results of
  the same patient (REQ-SEC-081: the port is called only by C6 system actor and the patient's own C16 session).
Alternatives considered: renderer calling C14 (renderer has no ports by design, C6-TRD §4.3); C6 enriching the
  payload (would duplicate C14 logic in C6).
Tests that will prove it: renderer snapshot tests; port contract case asserting every display field is present
  when the corresponding id is present.
```

### CR-C14-002 — `LabPort.getAnalyteHistory`
```
Title: CR-C14-002: LabPort.getAnalyteHistory for smart-report trends
From chunk: C14            To owner: C0-0C (port) + C5 (implements)
Type: port
Blocking? no (trends = [] until merged; PRD AC-13.5)
Problem: PRD US-13 (trends across visits, 00 C7 / wishlist 3 "graphs"). LabPort has only per-order reads; C5's
  history is HTTP-only (C5 02-TRD #25/#26), and modules must use ports in-process (02-CV §8.1).
Proposed change (exact):
  getAnalyteHistory(ctx: RequestContext, input: {
    patientId: Uuidv7; analyteIds: readonly Uuidv7[] /* 1..100 */; before: IsoUtc; since?: IsoUtc;
    limitPerAnalyte: number /* 1..10 */; excludeOrderId?: Uuidv7 }): Promise<{
    series: readonly { analyteId: Uuidv7; points: readonly { resultId: Uuidv7; orderId: Uuidv7; versionNo: number;
      approvedAt: IsoUtc; valueNumeric?: DecimalString; unitCode?: Code; flag?: 'N'|'L'|'H'|'LL'|'HH'|'A' }[] }[] }>;
  Semantics: approved results only, latest version per result, approvedAt in [since, before), newest first,
  RLS-scoped; unknown/invisible patient → empty series (no existence oracle). Performance ≤ 40 ms for 50 analytes
  (C5 index results__tenant_id_history__p_idx). Fake: seeded history for one synthetic patient incl. a unit change.
Backward compatible? yes (new method).
Tenant/security impact: P3 read; no new public surface; callers C14 only (system/user actors).
Alternatives considered: storing history in C14 from events (events carry no values — 03-IC §3.10; would copy
  clinical data into a second schema).
Tests that will prove it: C5 contract cases (other patient's results never returned; other tenant → empty;
  amended result returns only latest version; limit honoured).
```

### CR-C14-003 — Permissions
```
Title: CR-C14-003: smartreport permission codes
From chunk: C14            To owner: C0-0C (contracts/permissions.yaml)
Type: api
Blocking? no (fake IdentityPort accepts configured codes)
Proposed entries:
  - { code: smartreport.template.manage, privileged: false, roles: [pathologist, lab_manager], phase: 2 }
  - { code: smartreport.summary.approve, privileged: true,  roles: [pathologist], phase: 2 }   # per-summary approval (03-IC §4.10 invariant)
Also: ctx.audit.access entity types `smart_summary`, `smart_summary_preview`, `smart_library_version` if C0 keeps a
  closed entity-type list.
Tenant/security impact: privileged → aal2 (04 A4).
```

### CR-C14-004 — Error codes
```
Title: CR-C14-004: smartreport error codes
From chunk: C14            To owner: C0-0C (contracts/errors.yaml)
Type: api
- { code: smartreport.library_invalid,            http: 422, owner: C14, title: "Template library invalid", meaning: "Validation rules V1–V14 failed; details in errors[]" }
- { code: smartreport.library_invalid_transition, http: 409, owner: C14, title: "Template library cannot change state", meaning: "Edit outside draft, second open draft, or illegal transition" }
- { code: smartreport.summary_invalid_transition, http: 409, owner: C14, title: "Summary cannot change state", meaning: "Approve/reject outside draft" }
- { code: smartreport.summary_superseded,         http: 409, owner: C14, title: "Summary built on superseded results", meaning: "Approved results changed after the summary was built" }
- { code: smartreport.summary_not_ready,          http: 409, owner: C14, title: "Smart summary not available yet", meaning: "No approved summary for the current results (patient/portal/partner callers)" }
Backward compatible? yes.
```

### CR-C14-005 — Feature flag `smart_report`
```
Title: CR-C14-005: register tenant feature flag smart_report
From chunk: C14            To owner: C2 (registry content) + C0-0B (seed migration)
Type: schema (seed row)
Blocking? no (fake IdentityPort returns configurable featureFlags)
Problem: C6-TRD §10.3 and C14 read featureFlags.smart_report, but identity.g_feature_flags seeds only
  smart_report_llm (C2 05-SCHEMA §4.8/§10.1).
Proposed: INSERT INTO identity.g_feature_flags (code, description, scope, settable_by, requires_founder_approval,
  default_enabled, blocker_ref) VALUES ('smart_report','Rules-based smart report summaries (pathologist-approved)',
  'tenant','tenant',false,false,'B14');
Backward compatible? yes.
Security: no foreign touchpoint; enabling does not bypass library/summary approval.
```

### CR-C14-006 — SmartReportPort semantics clarifications
```
Title: CR-C14-006: SmartReportPort actor rules, status mapping, new @throws
From chunk: C14            To owner: C0-0C (JSDoc + contract suite + fake/stub); consumers C6, C16 acknowledge
Type: port (semantics, additive)
Problem: 03-IC §4.10 does not say what happens when C16 (patient actor) calls buildSummary before approval, or how
  an internally rejected summary maps to status 'draft'|'approved'.
Proposed: (a) actor.type ∈ {patient, portal, partner} → read-only: returns the approved summary for the current
  approved set or throws smartreport.summary_not_ready (CR-C14-004); never writes. (b) Internal 'rejected' →
  status 'draft'. (c) @throws adds smartreport.summary_not_ready. (d) contract cases 7–14 (02-TRD §7.1).
  (e) Fake gains the same behaviours.
Backward compatible? yes (narrows behaviour for actor types that have no caller yet).
```

### CR-C14-007 — `smart-*` classes in the shared print stylesheet
```
Title: CR-C14-007: print stylesheet classes for the smart section
From chunk: C14            To owner: C6 (services/renderer shared print stylesheet)
Type: bug/feature request to another chunk (path owned by C6)
Blocking? no for logic; yes for final visual sign-off of C14-T22
Problem: C6-TRD §5.3 allows only classes from the shared print stylesheet in the smart fragment.
Proposed: C6 adds rules for: smart-section, smart-title, smart-notice, smart-score, smart-score-value,
  smart-score-band, smart-tiles, smart-tile, smart-tile-name, smart-tile-status, smart-status-in_range,
  smart-status-borderline, smart-status-out_of_range, smart-status-critical, smart-subtitle, smart-list,
  smart-trends, smart-disclaimer, smart-meta (layout in 04-UI-UX §4.2). Status must not rely on colour alone
  (text word always printed — 02-CV §14).
```

### CR-C14-008 — UI kit `TextDiff` (Phase 3)
```
Title: CR-C14-008: @lims/ui TextDiff component
From chunk: C14            To owner: C0-0D
Type: ui-kit
Blocking? no (Phase 3 only; until then the review screen shows the two texts one above the other)
Proposed props: interface TextDiffProps { before: string; after: string; beforeLabel: string; afterLabel: string;
  granularity?: 'word' /* default */ | 'char'; lang?: 'en' | 'ne' }  — word-level diff, insertions/deletions marked
  by text + underline/strike (not colour alone), Devanagari-safe (grapheme-aware splitting), accessible summary
  "n words changed".
```



# C15-payment-gateways  (own CRs: 13)

## Change requests raised

**CR-C15-001: PaymentProviderPort additive methods and contract refinement**
From chunk: C15 · To owner: C0-0C (consumers C4, C16 informed) · Type: port · Blocking? no (C15 builds the impl; fakes updated by C0)
Problem: (a) consumers cannot read an intent's status without triggering a gateway call (US-PG-11 AC2); (b) an unpaid open intent blocks a new one until expiry, and there is no way to abandon it safely (US-PG-13); (c) eSewa is a form POST, which cannot be shown as a QR or opened from a mobile app without a hosted page (US-PG-01 AC1, US-PG-11); (d) contract case 5 ("each hold status → held_for_review") would hold every Khalti `Initiated` intent at the first "Check now" before the patient has paid.
Proposed change (exact): in `contracts/ports/PaymentProviderPort.ts` add `launchUrl?: string` to the `form_post` member of `IntentAction`; add methods `getIntent` and `cancelIntent` exactly as in `02-TRD.md` §5.3. Contract case 5 reworded: "each hold status (eSewa `AMBIGUOUS`/`AMBIGIOUS`/`FULL_REFUND`/`PARTIAL_REFUND`/unknown; Khalti `Pending`/`Refunded`/`Partially Refunded`/unknown) → `held_for_review`; eSewa `PENDING`/`NOT_FOUND` and Khalti `Initiated` before `expires_at + grace` → unchanged non-terminal; after it → `held_for_review` (`PENDING`, `Initiated`) or `expired` (`NOT_FOUND`)". Add cases 12–18 (§5.3). Fake: implement the two methods and the deadline rule.
Backward compatible? yes (new optional field, new methods; no consumer breaks).
Tenant/security impact: none new; `getIntent` returns P1 data only.
Alternatives considered: C15 HTTP endpoints for C16 (rejected: C16 talks to C15 by port, CM §5); hold on every `Initiated` (rejected: floods finance, contradicts Khalti's own guidance that only `Pending` needs contact).
Tests: contract cases 5 (refined), 12–18 on fake and real.

**CR-C15-002: BillingPort.recordGatewayRefund and allowExceedsDue**
From: C15 · To: C0-0C + C4 (implementer) · Type: port · Blocking? yes for PG-T15 (refund completion) and PG-T11 AC4; work continues against the fake.
Problem: gateway refunds must appear in the ledger as refund rows (C4 06-PLAN lists this CR as expected; C4 03-APP-FLOW §2.12 routes gateway refunds to C15). A verified gateway payment that exceeds the current due (cash part payment recorded meanwhile) cannot be recorded today (`billing.payment_exceeds_due`), although the money has moved (US-PG-06 AC3, US-PG-07 AC4).
Proposed change (exact, additive to `BillingPortV1`):
```ts
export interface GatewayPaymentInput { /* existing fields */ readonly allowExceedsDue?: boolean }   // when true: record the full amount and open a
                                                                                                     // finance_review_items row kind 'gateway_payment_exceeds_due'
export interface GatewayRefundInput {
  readonly refundId: Uuidv7; readonly intentId: Uuidv7; readonly orderId: Uuidv7;
  readonly gateway: 'esewa' | 'khalti' | 'fonepay'; readonly gatewayTxnRef: string;
  readonly amount: Money;             // positive; C4 stores it negative (entry_kind 'refund', capture_kind 'gateway')
  readonly reasonCode: Code; readonly approvedByMembershipId: Uuidv7; readonly refundedAt: IsoUtc;
}
/** Idempotent on refundId. @throws billing.ledger_reversal_invalid (amount > refundable) */
recordGatewayRefund(ctx: RequestContext, input: GatewayRefundInput): Promise<{ ledgerEntryId: Uuidv7; duplicate: boolean; balance: OrderBalance }>;
```
C4 DDL: `finance_review_items.kind` adds `'gateway_payment_exceeds_due'`; ledger unique partial index `(tenant_id, idempotency_key)` already exists — C4 uses `idempotency_key = 'gw_refund:' || refundId`. `billing.balance.changed.v1` cause for refunds = `payment_reversed` (existing mapping, C4-TRD §8.1).
Alignment notes for C4: (1) C4 07-SECURITY says only C15's *system* context calls `recordGatewayPayment`; 03-IC §4.4 also allows the patient/portal request context, and `PaymentProviderPort.verify` called from C4's B13 runs under the staff user — C4 should set `collected_by_membership_id` for `capture_kind = gateway` to the intent creator's membership when the actor has none (patient/portal/system) or define a system membership; (2) `getOrderBalance`/`recordGatewayPayment` must work under `patient`/`portal` actors (03-IC §4.4 "Tenant context").
Backward compatible? yes. Security: refunds stay privileged in C15 (two-person); IRD impact: refund rows are ledger rows (not invoices), no fiscal document change (04 P1).
Tests: BillingPort contract adds (11) refund idempotent on refundId, (12) refund > refundable → `billing.ledger_reversal_invalid`, (13) `allowExceedsDue` records + opens review item.

**CR-C15-003: Payment-intent state machine clarifications (03-IC §10.6)**
From: C15 · To: C0-0C / doc owner · Type: event/port semantics · Blocking? no
Problem: §10.6 lists the chain but not (a) that any open state may move to a terminal state, (b) money found late on a `failed`/`expired` intent (cancelled Khalti link still payable until expiry; eSewa has no documented expiry), (c) repeated partial refunds.
Proposed change: replace §10.6 text with the transition table in `02-TRD.md` §4.1 (I1–I14), including `failed|expired → held_for_review` (`late_payment_found`) and `partially_refunded → partially_refunded|refunded`. Only `→ settled` emits the event (unchanged).
Backward compatible? yes (no consumer reads intent states except via the port). Tests: unit state-table tests; integration late-payment test.

**CR-C15-004: Public payment-callback authentication in the API core**
From: C15 · To: C0-0D (core) + C0-0B (DEFINER) · Type: api/schema · Blocking? yes for PG-T09 (callbacks); dev uses a test-only resolver.
Problem: gateway redirects reach C15 without any credential, and 02-CV §6 forbids taking the tenant from a path segment. `ModuleManifest.authResolvers` allows only `deviceToken` (instruments) and `portalSession` (reporting) (C0 TRD §6.3).
Proposed change: (1) `authResolvers.paymentCallback?: AuthResolver` allowed only for module `payments`; resolver result `actor: { type: 'system', id: <payments system actor> }`, `extraClaims: { payment_intent_id }`. (2) OpenAPI security scheme `paymentCallbackToken` (path parameter `callback_token`, base64url 43 chars) usable only in `payments.yaml`. (3) DEFINER `app.payments_resolve_callback_token(p_token_sha256 bytea) RETURNS TABLE (tenant_id uuid, intent_id uuid)`, owner `lims_owner`, `EXECUTE` to `lims_api`, `SET search_path = ''`, body `SELECT i.tenant_id, i.id FROM payments.intents i WHERE i.callback_token_sha256 = p_token_sha256 AND i.created_at > now() - interval '30 days'`, relying on policy `intents__select__owner_only` (`TO lims_owner USING (callback_token_sha256 = nullif(current_setting('app.payments_lookup_token', true), '')::bytea)`, the function sets that GUC with `set_config(…, true)` first). Added to `db/meta/definer-inventory.yaml`. (4) Index exception: `intents__callback_token_sha256__uq` is unique on the hash alone (not tenant-leading) because the lookup happens before any tenant context — list it in the C0 index-lint exception file with this justification (same need as C7 device tokens). (5) Public operations of `payments` may respond `303` and `text/html` (P30, P34) — spec lint allows `text/html` responses only for operations with `x-public` or `paymentCallbackToken`.
Backward compatible? yes. Security: new public surface (REQ-SEC-052, 099) → security sign-off (05-DoD §4). Tokens ≥256-bit CSPRNG, stored as SHA-256 (04 A13 pattern); invalid tokens indistinguishable.
Tests: probes — tenant-B token never yields tenant-A data; expired token → `unknown`; DEFINER inventory test.

**CR-C15-005: Permissions**
From: C15 · To: C0-0C (`contracts/permissions.yaml`) · Type: api · Blocking? no
Add (phase 1.5): `payments.intent.resolve` (privileged, roles [finance]); `payments.refund.request` (privileged, [finance]); `payments.refund.approve` (privileged, [finance]); `payments.merchant_config.read` (not privileged, [tenant_admin, finance]); `payments.merchant_config.manage` (privileged, [tenant_admin]). `payments.intent.create` also granted to `finance` (cancel from the review screen). Worker `systemPermissions` for `payments`: none beyond its own service calls (no `payments.*` HTTP permissions). Rationale: `billing.refund.approve` governs C4's manual refunds; gateway refunds are a separate privileged path (REQ-SEC-055; 04 A4 "finance/refund" roles need MFA).

**CR-C15-006: Error codes** (to C0-0C `contracts/errors.yaml`, owner C15)
```yaml
- { code: payments.amount_not_supported,        http: 422, owner: C15, title: "Amount not supported by this payment method", meaning: "Khalti < 1000 paisa (04 P4); eSewa fractional rupees while unverified" }
- { code: payments.return_url_not_allowed,      http: 422, owner: C15, title: "Return address not allowed", meaning: "returnUrl/cancelUrl outside the allowlist" }
- { code: payments.intent_invalid_transition,   http: 409, owner: C15, title: "Payment cannot move to the requested state", meaning: "02-TRD §4.1" }
- { code: payments.intent_not_verifiable,       http: 409, owner: C15, title: "Payment not confirmed by the provider", meaning: "Resolve requires gateway success + exact amount" }
- { code: payments.refund_not_allowed,          http: 409, owner: C15, title: "Refund not allowed", meaning: "Intent not settled, refund in progress, or wrong refund state" }
- { code: payments.refund_self_approval_forbidden, http: 403, owner: C15, title: "Refund needs a second approver", meaning: "REQ-SEC-055 two-person rule" }
- { code: payments.credential_invalid,          http: 422, owner: C15, title: "Merchant credentials rejected", meaning: "Gateway rejected the key during test" }
- { code: payments.reconciliation_in_progress,  http: 409, owner: C15, title: "Reconciliation already running", meaning: "" }
- { code: payments.callback_mismatch,           http: 400, owner: C15, title: "Callback does not match payment", meaning: "Recorded outcome only; callbacks never change state" }
- { code: payments.static_qr_already_reconciled, http: 409, owner: C15, title: "Already reconciled", meaning: "One worksheet per date and centre" }
```

**CR-C15-007: Web deployable and routes for C15**
From: C15 · To: doc owner (CM §2/§3) + C0-0C (`contracts/routes.yaml`) · Type: api/docs · Blocking? no (API first)
Problem: CM §2 lists C15 deployables "api payments, worker payments" only, but finance/tenant-admin screens (held queue, refunds, reconciliation, static QR, merchant settings) are needed (US-PG-07…12).
Proposed: C15 owns `apps/web/src/app/(staff)/payments/**` and `apps/web/src/features/payments/**`. Routes: `staff.payments.review` `/payments/review` (`payments.reconciliation.read`); `staff.payments.intent` `/payments/intents/{intent_id}` (`payments.reconciliation.read`); `staff.payments.refunds` `/payments/refunds` (`payments.reconciliation.read`); `staff.payments.reconciliation` `/payments/reconciliation` (`payments.reconciliation.read`); `staff.payments.static_qr` `/payments/static-qr` (`payments.reconciliation.read`); `staff.payments.settings` `/payments/settings` (`payments.merchant_config.read`). Nav group `billing`.

**CR-C15-008: Infrastructure for public payment routes and secrets**
From: C15 · To: C1 · Type: infra · Blocking? yes for production enablement (PG-T23), not for development.
Requests: (1) Publish the API origin `LIMS_PAYMENTS_PUBLIC_BASE_URL` over TLS per 04 I5 on Nepal infra (03 §9.3; REQ-ARCH-087), no foreign CDN (04 I7). (2) nginx locations `= /v1/payments/result`, `^~ /v1/payments/launch/`, `^~ /v1/payments/callbacks/`: methods `GET`/`HEAD` only (others 405), request body 0, `limit_req` zone keyed by client IP **10 r/s burst 20** (04 §4 "General API" values, applied per IP because these routes have no user), `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, HSTS per 04 I6. (3) Access-log path masking for `/v1/payments/launch/*` and `/v1/payments/callbacks/*` (token segment replaced by `:token`) and never log query strings for `/v1/payments/callbacks/*` (Khalti adds `mobile`) — same mechanism as the `/r/`, `/v/` token routes (03-IC §7). (4) Egress allowlist from API and worker containers: production `epay.esewa.com.np:443`, `khalti.com:443`; staging `uat.esewa.com.np:443`, `dev.khalti.com:443` (+ the eSewa UAT form host once known). No other gateway egress. (5) SOPS-managed file for `LIMS_PAYMENTS_KEK_FILE` (per environment, distinct keys), mounted read-only into API and worker; rotation runbook (add new key id → set active → wait for `payments.rewrap_credentials` → remove old). (6) Alert rules from 02-TRD §11 routed to finance on-call where marked.

**CR-C15-009: C15 as consumer of `billing.v_pub_payment_collection`**
From: C15 · To: C0-0C (03-IC §6.2 consumer list) + C4 (owner) · Type: api · Blocking? no
Problem: static-QR reconciliation (04 P5 interim) needs the daily sum of `fonepay_qr` ledger entries per date/centre. Proposed: add C15 to the view's consumers; no column change. Reads are tenant/centre-scoped (security_invoker).

**CR-C15-010: C6 portal as PaymentProviderPort consumer**
From: C15 · To: C0-0C (03-IC §4.9 consumer list, CM §5.1) + C6 (must agree) · Type: port · Blocking? no
Problem: the portal (C6) shows dues and is the web fallback for the patient app; paying a due there needs the port. Proposed: consumers C4, C6, C16. C6 authorises the portal actor against the link's order before calling; return URLs on `LIMS_ORIGIN_PORTAL` are already allowlisted. If C6 declines, portal checkout is out of scope and only C16 uses the hosted flow.

**CR-C15-011: UI kit `SecretField`**
From: C15 · To: C0-0D · Type: ui-kit · Blocking? no (TextField with a "replace secret" toggle as interim is **not** used; the settings screen ships after the component)
Proposed: `SecretFieldProps extends FieldBase { onChange(v: string | undefined): void; maxLength: number; isSet: boolean; fingerprint?: string; setAt?: IsoUtc }` — renders a masked input (`type=password`, `autocomplete=off`, no reveal toggle, value never pre-filled), and "Set on <date> · fingerprint <8 hex>" when `isSet`.

**CR-C15-012: 02-CV §4.7 clarification for finance-entered amounts**
From: C15 · To: doc owner · Type: docs · Blocking? no
Problem: 02-CV §4.7 forbids `amount_paisa (for payments)` in client bodies. C15 accepts `amount_paisa` on refund **requests** (a finance decision, bounded server-side by captured and refundable amounts and approved by a second person) and `statement_total_paisa` on the static-QR worksheet (a bank-statement figure that never touches the ledger). Proposed wording: "…never accept amounts that the server can compute (prices, dues, gateway amounts); finance-entered amounts are allowed only where the server bounds them and the operation is privileged." Same interpretation as C4's CR-C4-012.

**CR-C15-013: Audit-trigger column exclusion for merchant secrets**
From: C15 · To: C0-0B · Type: schema · Blocking? no
Problem: the generic JSONB old/new audit trigger (04 D11) would copy `payments.merchant_accounts.secret_ciphertext/secret_nonce/secret_auth_tag` into `audit.audit_log`, spreading encrypted credentials into a store with different retention and readers.
Proposed: `app.tg_row_audit()` accepts a per-table excluded-column list (trigger argument); for `payments.merchant_accounts` exclude those three columns and record only `secret_fingerprint`/`secret_set_at` changes. Tests: audit row after a secret replacement contains no `secret_ciphertext` key.


# C16-patient-engagement  (own CRs: 21)

## 15. Change requests raised

Each follows `program/04-CHANGE-REQUESTS.md`; C16 builds as if accepted, against fakes.

```
Title: CR-C16-001: Path ownership for C16 (staff segment, worker, display route group, manual)
From chunk: C16            To owner: C0-0A (CODEOWNERS) + C0-0D (route group)
Type: shared-lib (path allocation)   Blocking? yes — queue display task (T-Q5)
Problem: 01 §3 assigns apps/web/src/{app/(staff),features}/engagement and jobs/engagement by the module rule;
  the queue display must render without a staff session or staff shell (US-EN-22) — a staff session on a public
  TV is a security risk (07-SECURITY T-D1).
Proposed change: CODEOWNERS: apps/patient_app/**, services/api/src/modules/engagement/**,
  services/worker/src/jobs/engagement/**, apps/web/src/app/(staff)/engagement/**, apps/web/src/features/engagement/**,
  apps/web/src/app/(display)/queue-display/** , docs/manual/engagement/** → C16. C0 web core: the (display) group is
  excluded from the staff session middleware and shell; CSP as shell; no nav entries.
Backward compatible? yes   Security: new unauthenticated page (no data without the display cookie).
Alternatives: display inside apps/portal (rejected: C6 owns it; different origin cookies); staff session in display
  mode (rejected: idle timeouts 15–30 min, 04 A8, and the shared screen could navigate to staff screens).
```

```
Title: CR-C16-002: Permission codes for engagement (contracts/permissions.yaml)
From chunk: C16            To owner: C0-0C (C2 must agree)
Type: api   Blocking? yes — T-01 (authz)
Proposed change:
  permissions (new):
  - { code: engagement.auth.challenge,        privileged: false, roles: [], phase: 3 }   # patient pre_auth stage only
  - { code: engagement.self.manage,           privileged: false, roles: [], phase: 3 }   # patient
  - { code: engagement.link.redeem,           privileged: false, roles: [], phase: 3 }   # patient
  - { code: engagement.payment.create,        privileged: false, roles: [], phase: 3 }   # patient
  - { code: engagement.enquiry.create,        privileged: false, roles: [], phase: 3 }   # patient
  - { code: engagement.queue.board_read,      privileged: false, roles: [], phase: 2 }   # device kind queue_display
  - { code: engagement.slot.manage,           privileged: false, roles: [tenant_admin, lab_manager], phase: 3 }
  - { code: engagement.bookable_item.manage,  privileged: false, roles: [tenant_admin, lab_manager], phase: 3 }
  - { code: engagement.queue.operate,         privileged: false, roles: [front_desk, centre_staff], phase: 2 }
  - { code: engagement.queue.manage,          privileged: false, roles: [tenant_admin, lab_manager], phase: 2 }
  - { code: engagement.link.issue,            privileged: false, roles: [front_desk, centre_staff], phase: 3 }
  - { code: engagement.link.read,             privileged: false, roles: [front_desk, centre_staff, tenant_admin], phase: 3 }
  - { code: engagement.link.revoke,           privileged: false, roles: [front_desk, tenant_admin], phase: 3 }
  - { code: engagement.reminder.read,         privileged: false, roles: [front_desk, tenant_admin], phase: 2 }
  - { code: engagement.reminder.manage,       privileged: false, roles: [front_desk], phase: 2 }
  - { code: engagement.membership.read,       privileged: false, roles: [front_desk, finance, tenant_admin], phase: 3 }
  - { code: engagement.membership.enrol,      privileged: false, roles: [front_desk], phase: 3 }
  - { code: engagement.membership_plan.manage, privileged: true, roles: [tenant_admin, finance], phase: 3 }
  - { code: engagement.enquiry.read,          privileged: false, roles: [front_desk], phase: 3 }
  - { code: engagement.enquiry.respond,       privileged: false, roles: [front_desk], phase: 3 }
  - { code: engagement.settings.manage,       privileged: true,  roles: [tenant_admin], phase: 2 }
  roles changed: engagement.booking.read += [centre_staff, tenant_admin, lab_manager]; engagement.booking.manage += [centre_staff]
  fixed_actor_permissions.patient += [engagement.self.manage, engagement.link.redeem, engagement.payment.create,
                                      engagement.enquiry.create]
  fixed_actor_permissions.patient_pre_auth (new key) = [engagement.auth.challenge]
  fixed_actor_permissions.device becomes a map by device_kind:
     bridge_agent (default when the claim is absent): the existing four instruments.ingest.* codes
     queue_display: [engagement.queue.board_read]
Backward compatible? yes (device without device_kind keeps today's set)
Security: patient-only codes never grantable to tenant roles (CI rule as CR-C13-002).
```

```
Title: CR-C16-003: Error codes for engagement + co-emission of OTP codes
From chunk: C16            To owner: C0-0C (C6 agrees for auth.otp_*)
Type: api   Blocking? no
Proposed change (owner C16):
- { code: engagement.link_code_invalid,   http: 422, title: "Code not valid", meaning: "Unknown, expired, used, wrong phone, or report link not valid — identical response" }
- { code: engagement.link_limit_reached,  http: 409, title: "Profile limit reached", meaning: "Per-account or per-patient link limit; self profile exists; address limit" }
- { code: engagement.booking_invalid_transition, http: 409, title: "Booking cannot move to the requested state", meaning: "03-APP-FLOW §4.1" }
- { code: engagement.slot_outside_window, http: 422, title: "Slot not bookable", meaning: "Past, inside lead time, beyond horizon, or not a generated slot" }
- { code: engagement.orderable_not_bookable, http: 422, title: "Test not available for booking", meaning: "Not in the bookable catalogue for this kind, or sex restriction" }
- { code: engagement.address_required,    http: 422, title: "Address required", meaning: "Home collection needs an address" }
- { code: engagement.queue_closed,        http: 409, title: "Queue not open", meaning: "Queue inactive or queue feature off" }
- { code: engagement.queue_token_invalid_transition, http: 409, title: "Token cannot move to the requested state", meaning: "03-APP-FLOW §4.3" }
- { code: engagement.membership_overlap,  http: 409, title: "Membership already active", meaning: "One active membership per patient" }
- { code: engagement.plan_inactive,       http: 409, title: "Membership plan inactive", meaning: "" }
- { code: engagement.reminder_invalid_transition, http: 409, title: "Reminder cannot change", meaning: "Already sent/cancelled" }
- { code: engagement.enquiry_invalid_transition,  http: 409, title: "Enquiry cannot change", meaning: "Closed, or open-enquiry limit" }
- { code: engagement.setting_out_of_range, http: 422, title: "Setting out of allowed range", meaning: "05-SCHEMA §2.1" }
Existing kept: engagement.slot_unavailable, engagement.booking_limit_reached, engagement.booking_not_cancellable,
  engagement.app_version_unsupported.
Co-emission: allow module engagement to emit auth.otp_invalid and auth.otp_attempts_exhausted (owner C6, 03-IC §8)
  with identical meaning (04 A9). CI owner-grep rule gets an allowlist entry. Alternative rejected: duplicate
  engagement.otp_* codes with the same meaning (two codes for one fact).
```

```
Title: CR-C16-004: Patient sessions, patient memberships and device-kind actors (identity)
From chunk: C16            To owner: C2 (+ C0-0C IdentityPort/identity.yaml, C0-0B identity DDL)
Type: port + api + schema   Blocking? yes — T-A3 (sign-in), T-Q5 (display authz)
Problem: US-EN-01/02 need GoTrue-backed patient sessions (02-CV §6) with no BFF; C2 sessions support
  tenant_staff|platform (and partner by CR-C13-003); the resolver emits actor_type user only; GoTrue is reachable only
  from the API network (CR-C2-012) and identity /auth/* only from BFF networks; C16 may not write core.* or call GoTrue.
Proposed change:
 (a) identity.sessions.kind adds 'patient' (tenant_id + membership_id NOT NULL); bound to header origin
     X-Lims-Origin: patient_app (resolve rejects other origins → 401 auth.session_expired).
 (b) Lifetimes for kind patient: idle 14 days, absolute 30 days (C2 config keys
     LIMS_IDENTITY_PATIENT_IDLE_DAYS=14 / _ABSOLUTE_DAYS=30; ranges 1–30 / 1–90).
 (c) Claims for kind patient: { sub, tenant_id, membership_id, actor_type: 'patient', aal: 'aal1', lims_session_id,
     session_state: 'active' }. No patient_id/account_id claim (derived in SQL by CR-C16-006 helpers).
 (d) IdentityPort V1 additive methods (run in caller tx):
     provisionPatientMembership(ctx, { accountId }) → { membershipId, userId }
        creates the GoTrue user + core.users (display_name 'Patient app user') + core.memberships(actor_type 'patient',
        all_centres false, no centres). Requirement: no phone number or real e-mail stored in GoTrue, and GoTrue never
        sends SMS/e-mail for these users. Mechanism (e.g. a server-held random credential used with the existing
        signInWithPassword gateway method) is C2's choice in its T1 GoTrue mapping (UNVERIFIED for the pinned version).
        Allowed only when ctx claims are patient + patient_stage pre_auth; idempotent per accountId.
     openPatientSession(ctx, { membershipId, appInstanceId, appPlatform }) → { sessionToken, accessToken,
        accessExpiresAt, sessionExpiresAt }   (same caller restriction; membership must be actor_type patient, active)
     revokePatientSessions(ctx, { membershipId, reason, deactivateMembership }) → { revokedSessions }
        caller: patient whose claims membership_id = membershipId, or system actor of module engagement.
 (e) identity.yaml public operations: resolvePatientSession, logoutPatientSession (02-TRD §5.5), reachable from the
     public network (C1 CR-C16-018), rate limits per §11.
 (f) getActor: actor_type 'patient' → permissions = fixed_actor_permissions.patient (CR-C16-002), centreScope
     { all:false, centreIds:[] }; claims patient_stage 'pre_auth' → [engagement.auth.challenge];
     actor_type 'device' with claims device_kind 'queue_display' → [engagement.queue.board_read], centreScope
     { all:false, centreIds:[claims.centre_id] }.
Backward compatible? yes (additive)
Security: new public endpoints authenticated by 256-bit session tokens (SHA-256 stored, C2 §4.2); REQ-SEC-065/066/067/102.
Tests: C2 contract cases: patient session resolve with staff origin → 401; revoked → 401; pre_auth claims cannot call
  openPatientSession for a membership of another account (C16 passes only the verified account's membership);
  device kind queue_display cannot get instruments.ingest.submit.
```

```
Title: CR-C16-005: Auth resolvers patientPreAuth and queueDisplayToken from module engagement
From chunk: C16            To owner: C0-0D (+ C0-0B DEFINER functions, C0-0C securitySchemes)
Type: api + schema   Blocking? yes — T-A2, T-Q5
Proposed change:
 (a) ModuleManifest.authResolvers accepts patientPreAuth and queueDisplayToken from module 'engagement' only
     (today: deviceToken→instruments, portalSession→reporting). AuthResolver result actor type union adds 'patient';
     extraClaims allowed keys: patient_stage, otp_token_sha256, device_kind.
 (b) _common.yaml securitySchemes: patientPreAuth (apiKey, header X-Lims-Patient-PreAuth),
     queueDisplayToken (apiKey, header X-Lims-Display-Token).
 (c) DEFINER (inventoried, SET search_path = '', schema-qualified):
     app.engagement_resolve_tenant_code(p_code text) RETURNS uuid           -- active tenant only
     app.engagement_resolve_preauth(p_code text, p_token_sha256 text) RETURNS TABLE(tenant_id uuid, challenge_id uuid)
     app.engagement_resolve_display(p_token_sha256 text) RETURNS TABLE(tenant_id uuid, centre_id uuid, display_id uuid)
     (SQL in 05-SCHEMA §6).
Security: pre-auth context has no membership → all patient/staff predicates false; probes in 07-SECURITY §6.
```

```
Title: CR-C16-006: engagement DDL, RLS and helper functions
From chunk: C16            To owner: C0-0B
Type: schema   Blocking? yes — every DB task
Proposed change: 05-SCHEMA.md in full (tables, policies, triggers, views, seeds) incl. helpers
  app.engagement_account_id(), app.engagement_patient_ids(), app.engagement_patient_visible(uuid, timestamptz),
  app.engagement_redeem_link_code(text), app.engagement_code_redeemed_by_me(uuid, uuid), app.engagement_preauth_stage(); exception to the tenant-leading index rule
  (as CR-C2-017) for queue_displays(token_sha256), used only by the pre-tenant display resolver.
```

```
Title: CR-C16-007: FrontdeskPort additions for the patient app
From chunk: C16            To owner: C4 (+ C0-0C)
Type: port   Blocking? yes — T-L1 (link codes), T-L4 (self-registration); fakes until merged
Proposed change (additive, FrontdeskPortV1):
 (a) DemographicsPurpose += 'patient_app_link' → fields fullName, sex, birthOn?, phoneE164?, status. Allowed for staff
     holding engagement.link.issue and for the engagement system actor.
 (b) PatientDemographics += status: 'active' | 'merged' | 'anonymised' (all purposes).
 (c) createSelfRegisteredPatient(ctx, { fullName, sex, birthOn?, ageYears?, phoneE164, consents, idempotencyKey })
     → { patientId, patientCode, duplicateSuspected, replayed }
     Always creates a NEW patient (never returns an existing id), source 'self_service', consents recorded with
     consentTextVersion as given (prefix 'app-'; no comparison with the desk consent version), dedupe candidates
     flagged for front-desk merge review (C4's own work item). Caller: engagement system actor only.
     @throws frontdesk.consent_required (processing false)
Backward compatible? yes   Security: no existing record is ever exposed through self-registration (D-LINK).
Tests: replay same key → same patientId; a record matching name/phone/birth year still yields a new id with
  duplicateSuspected true; purpose patient_app_link refused for a role without engagement.link.issue (auth.forbidden).
```

```
Title: CR-C16-008: ReportingPort for patient actors + report-link redemption
From chunk: C16            To owner: C6 (+ C0-0C port, C0-0B policies)
Type: port + schema   Blocking? yes — T-R2 (download), T-L3 (report-link linking)
Problem: C6-TRD §7.1 states patient actors need actor-specific policies requested by C16; CR-C13-005 adds
  openReleasedReportFile and already names "patient actors (C16, later) their own patient ids".
Proposed change:
 (a) openReleasedReportFile supports actor_type 'patient': C6 SELECT policies on reports/report_versions add
     (tenant_id = T AND actor_type = 'patient' AND patient_id = ANY ((SELECT app.engagement_patient_ids())));
     C16 additionally checks visible_from before calling. Storage read stays C6's server credential.
 (b) New method (additive):
     redeemPortalLinkForApp(ctx, { linkToken: string; phoneE164: string })
       → { patientId: Uuidv7; reportId: Uuidv7; versionNo: number; releasedAt: IsoUtc }
     Succeeds only if the link is valid (unexpired, unrevoked), recipient_kind 'patient', channel sms|whatsapp, and the
     link's destination (destination_sha256 or the delivery's destination) equals phoneE164. Does not consume, extend or
     reveal the link. Caller: patient actor. @throws reporting.link_invalid (identical for every failure).
     Rate limit inside C6: otp_verify-style 5 failures per token.
Backward compatible? yes   Security: REQ-SEC-094 (links remain OTP-gated at the portal; this path needs the OTP-verified
  phone of the account instead).
Tests: wrong phone → link_invalid; expired → link_invalid; referrer link → link_invalid; success does not change the link.
```

```
Title: CR-C16-009: Message templates for engagement (reporting.g_message_templates seeds)
From chunk: C16            To owner: C6 (+ C0-0B seed migration)
Type: schema (seed)   Blocking? no (fake template registry)
Proposed templates (channel sms; purpose; declared params):
  engagement.login_otp            otp                  {otp_code, lab_name, minutes}
  engagement.booking_confirmation booking_confirmation {lab_name, datetime, short_text(booking_no)}
  engagement.booking_cancelled    booking_confirmation {lab_name, datetime, short_text(booking_no)}
  engagement.booking_reminder     booking_confirmation {lab_name, datetime, short_text(booking_no)}
  engagement.follow_up_reminder   follow_up_reminder   {lab_name, datetime}
Note: NotificationPurpose has no booking_cancelled/booking_reminder value; C16 uses booking_confirmation. If C6 prefers
  new purposes, that is an additive enum change in 03-IC §4.8.
English texts (tenants may override via C6 M2): "{lab_name}: your code is {otp_code}. It expires in {minutes} minutes.
  Do not share it." / "{lab_name}: booking {booking_no} confirmed for {datetime}." / "...cancelled." /
  "{lab_name}: reminder of your booking {booking_no} at {datetime}." / "{lab_name}: it is time for your follow-up test
  by {datetime}. Visit or book in the app." (no test names — 04 R6; REQ-SEC-070).
```

```
Title: CR-C16-010: Portal support for the patient app (app links, fallback pages)
From chunk: C16            To owner: C6 (+ C1 for headers/caching)
Type: api   Blocking? no (payments work with system browser + manual return)
Proposed: apps/portal serves the Android Digital Asset Links and iOS associated-domains files (content per platform
  docs; app ids and certificate fingerprints supplied per tenant flavour by config), and fallback pages for
  /app/payments/{payment_request_id}/done ("Return to the app to see your payment status" — no data) and the
  patient_app.* routes ("Open the app" / portal link-required page per routes.yaml fallback). No PHI on these pages.
```

```
Title: CR-C16-011: routes.yaml additions
From chunk: C16            To owner: C0-0C
Type: api (routes)   Blocking? yes — staff nav build
Proposed:
  - { id: staff.engagement.bookings,   origin: staff_web, path: /engagement/bookings,               owner: C16, permission: engagement.booking.read }
  - { id: staff.engagement.slots,      origin: staff_web, path: /engagement/slots,                  owner: C16, permission: engagement.slot.manage }
  - { id: staff.engagement.bookable,   origin: staff_web, path: /engagement/bookable-items,         owner: C16, permission: engagement.bookable_item.manage }
  - { id: staff.engagement.queue,      origin: staff_web, path: /engagement/queue,                  owner: C16, permission: engagement.queue.operate }
  - { id: staff.engagement.queue_setup, origin: staff_web, path: /engagement/queue/setup,           owner: C16, permission: engagement.queue.manage }
  - { id: staff.engagement.app_access, origin: staff_web, path: /engagement/app-access/{patient_id}, owner: C16, permission: engagement.link.read }
  - { id: staff.engagement.reminders,  origin: staff_web, path: /engagement/reminders,              owner: C16, permission: engagement.reminder.read }
  - { id: staff.engagement.memberships, origin: staff_web, path: /engagement/memberships,           owner: C16, permission: engagement.membership.read }
  - { id: staff.engagement.enquiries,  origin: staff_web, path: /engagement/enquiries,              owner: C16, permission: engagement.enquiry.read }
  - { id: staff.engagement.settings,   origin: staff_web, path: /engagement/settings,               owner: C16, permission: engagement.settings.manage }
  - { id: display.queue,               origin: staff_web, path: /queue-display,                     owner: C16, auth: display_token }
  - { id: patient_app.payment_done,    origin: patient_app, path: /payments/{payment_request_id}/done, owner: C16, auth: patient, fallback: portal_app_fallback }
  (staff.engagement.booking already exists.)
```

```
Title: CR-C16-012: Published views engagement.v_pub_* and their consumers
From chunk: C16            To owner: C0-0B (DDL), C0-0C (consumer lists); C17, C4, C8 agree
Type: schema   Blocking? no
Proposed (05-SCHEMA §7): engagement.v_pub_booking_address (C17), engagement.v_pub_patient_membership (C4),
  engagement.v_pub_booking_daily and engagement.v_pub_queue_daily (C8, if C8 wants B2C stats — 00 §3 item 11).
```

```
Title: CR-C16-013: C16 consumes catalog.changed.v1 and reads catalog.v_pub_price_list_items
From chunk: C16            To owner: C0-0C (C3 agrees)
Type: event (consumer list) + view grant use   Blocking? no — nightly sync covers the gap
Proposed: add C16 to consumers of catalog.changed.v1 (03-IC §3.19/§3.25, 01 §5.1) and of catalog.v_pub_price_list_items
  (03-IC §6.6) for membership-plan validation.
```

```
Title: CR-C16-014: C4 uses engagement.v_pub_patient_membership at registration
From chunk: C16            To owner: C4
Type: api/ui (C4 page)   Blocking? no — without it memberships are display-only
Proposed: on patient selection C4 reads the view; if an active membership exists, it shows "Member: <plan>" and
  pre-selects the plan's price_list_id as CatalogPort.priceFor context.priceListId (explicit list wins — 03-IC §4.2
  precedence). C4 decides UI and override rules.
```

```
Title: CR-C16-015: SmartSummary additive display fields
From chunk: C16            To owner: C14 (+ C0-0C)
Type: port   Blocking? no (app shows panel_code and the tenant default disclaimer meanwhile)
Proposed: panels[].displayName?: string; disclaimerText?: string (pathologist-approved template text, like other text fields).
```

```
Title: CR-C16-016: UI-kit components (lims_ui Flutter + @lims/ui web)
From chunk: C16            To owner: C0-0D
Type: ui-kit   Blocking? no (screens built with existing primitives first where marked in 04-UI-UX §9)
Proposed: Flutter: LimsPhoneField, LimsOtpField, LimsCodeField (grouped XXXXX-XXXXX), LimsStageTimeline,
  LimsSlotPicker, LimsSegmentedControl, LimsBottomNav, LimsCard, LimsQrCode, LimsPdfViewer, LimsProfileSwitcher,
  LimsAppLockGate. Web: QueueBoard (full-screen, large type), TokenSlip (printable), WeekdayTimeRangeEditor.
  Props in 04-UI-UX §9.
```

```
Title: CR-C16-017: Flutter dependency pins for the patient app
From chunk: C16            To owner: C0-0D
Type: shared-lib   Blocking? yes — T-A1 (app skeleton) for router; others per feature task
Proposed: C0 pins packages for the capabilities in 02-TRD §2.2 (router with app links, external browser launch,
  local auth, PDF render, QR render), each checked for licence (02-CV §15.2) and no foreign runtime calls.
```

```
Title: CR-C16-018: Infra rules for engagement
From chunk: C16            To owner: C1
Type: infra   Blocking? no (staging only)
Proposed: expose /v1/engagement/* and /v1/identity/auth/patient/* on the public API origin (TLS per 04 I5);
  nginx limit_req 5/min/IP on POST /v1/engagement/auth/otp-challenges and .../verify, 30/min/IP on
  /v1/identity/auth/patient/session/resolve; strip X-Lims-Patient-PreAuth, X-Lims-Patient-Session and
  X-Lims-Display-Token from access logs; Cache-Control no-store passthrough; no foreign CDN (04 I7).
```

```
Title: CR-C16-019: Access-log action codes
From chunk: C16            To owner: C0-0B (audit.g_cs_access_actions seed)
Proposed: engagement.link_code.issue, engagement.link.redeem, engagement.link.revoke, smart_summary.view,
  membership.lookup, engagement.account.delete. (report.download, report.view exist.)
```

Candidates recorded, **not** raised now: CR-C16-020 push notifications (needs founder approval of B11 first; then a push task with generic text only); CR-C16-021 coupon redemption at C4 registration (needs C4 agreement; out of v1 scope per 01-PRD §4.2); Realtime private channels for status (after C0 SP-4 and claims availability).


# C17-home-collection  (own CRs: 13)

## Change requests raised

```
Title: CR-C17-001: Home-collection bookings — order created by C17, not by C4's booking consumer
From chunk: C17          To owner: C4 (C0-0C for doc)
Type: event/port behaviour   Blocking? yes for US-01/US-03 end-to-end (not for C17 unit work)
Problem: C4's engagement.booking.confirmed.v1 consumer creates a pre_registered order for every booking
  (C4 TRD §8.2). For booking_kind = home_collection, C17 must register the order at assignment through
  FrontdeskPort.createOrderFromBooking(source 'home_collection', sourceRefId = visit_id, confirmImmediately:true)
  (03-IC X5) so that C5 creates specimens/barcodes for label printing. Both would exist → duplicate order.
  C4's booking.cancelled consumer looks up only the engagement_booking link, so a registered home-visit order
  is never flagged for review.
Proposed: (a) C4 booking.confirmed consumer ignores booking_kind = home_collection (inbox + booking_links
  row state 'delegated' or no row); (b) C4 booking.cancelled consumer also resolves the order through
  booking_links (source 'home_collection', source_ref_id = payload.home_visit_id) and raises
  booking_cancelled_after_registration; (c) createOrderFromBooking with source 'home_collection' authorises
  the caller with homecollection.visit.assign (the dispatcher) instead of frontdesk.registration.create,
  and with billing.invoice.issue waived for the cash invoice it issues; (d) C4 home payment path uses
  payments[].reference (CR-C17-006) when present.
Backward compatible? yes (C16 not affected; no payload change)
Tenant/security impact: none new; same RLS; invoice issued in the dispatcher's name (audit).
IRD impact: invoice issued at assignment (cash mode, D-INVOICE-TIMING in C4 PRD) — cancellations go through
  C4 credit notes; C17 raises order_cancel_required.
Alternatives: C17 confirms C4's pre_registered order through a new FrontdeskPort.confirmPreRegisteredOrder
  method (rejected: needs payments/fingerprint semantics of F12). Fallback if (a) is refused: C17 looks up the
  pre_registered order in frontdesk.v_pub_order_status (source engagement_booking, source_ref_id booking_id)
  and the board links the dispatcher to C4's confirm screen; assignment waits for status registered.
Tests: C4 consumer test (home_collection booking → no order); C17 E2E US-03-3; C4 cancel consumer test.
```

```
Title: CR-C17-002: LabPort.listOrderSpecimens (C17 becomes a LabPort consumer)
From chunk: C17          To owner: C0-0C + C5
Type: port   Blocking? yes for barcode verification (fake meanwhile)
Problem: the app must verify scanned tubes against the order's barcodes; status_changed.v1 carries no barcode
  (P1, 03-IC §3.7) and phlebotomists lack lab.specimen.read; no port method returns specimens with barcodes.
Proposed (contracts/ports/LabPort.ts, additive):
  listOrderSpecimens(ctx: RequestContext, input: { orderId: Uuidv7; statuses?: readonly SpecimenStatus[] }):
    Promise<{ orderId: Uuidv7; specimens: readonly { specimenId: Uuidv7; barcode: string; specimenTypeCode: Code;
      containerCode?: Code; status: SpecimenStatus; isActive: boolean; replacesSpecimenId?: Uuidv7; version: number }[] }>;
  Authz: actor holds lab.specimen.read OR homecollection.visit.read, or is a system actor. Runs under the
  caller's RLS (centre scope). p95 ≤ 20 ms for ≤ 20 specimens. Consumers: C17 (add to CM §5.1).
  Contract tests: other tenant → not_found; centre-scoped actor other centre → not_found; statuses filter;
  inactive specimen listed with isActive=false; recollection specimen has replacesSpecimenId.
Backward compatible? yes. Security: returns P2 barcodes — only to assigned phlebotomists (C17 checks) and staff.
```

```
Title: CR-C17-003: FrontdeskPort 'home_visit' purpose adds birthOn and sex
From chunk: C17          To owner: C0-0C + C4
Type: port   Blocking? no (default second identifier = phone)
Problem: two-identifier patient check (D-IDENT) normally uses date of birth; allowlist gives fullName,
  phoneE164, consents only (03-IC §4.3).
Proposed: home_visit → fullName, phoneE164, consents, birthOn?, sex. Additive allowlist change.
Security: one more P2 field on the device for today's visits only; purged with the cache.
```

```
Title: CR-C17-004: Native staff-app sessions (phlebo_app) in identity
From chunk: C17          To owner: C2 (C0-0C spec, C1 nginx exposure)
Type: api   Blocking? yes for device login (Prism mock meanwhile)
Problem: C2 sessions are BFF-only (/v1/identity/auth/* reachable only from the BFF network, CR-C2-012) and
  every API call requires an identity.sessions row (C2 TRD §4 item 5). A native app needs to hold its own
  refresh token (04 A15, REQ-SEC-102).
Proposed: identity.sessions.kind 'mobile'; operations (tier login):
  POST /v1/identity/mobile/sessions        {email, password, device_id, app: 'phlebo_app'} →
       {access_token, access_expires_at, refresh_token, session_id}   errors as loginStaff
  POST /v1/identity/mobile/sessions/refresh {refresh_token} → rotated pair | 401 auth.session_expired
  POST /v1/identity/mobile/sessions/logout  (bearer) → 204
  Rules: absolute lifetime ≤ 12 h (04 A8 absolute bound); BFF idle timeout not applied (04 A16 local
  re-auth replaces it — DECISION to confirm with C2); revoke via existing revokeSession/revokeUserSessions;
  only memberships holding homecollection.sync.upload may open a 'mobile' session; refresh tokens stored
  encrypted as for BFF sessions. Self-hosted refresh-rotation config is UNVERIFIED (04 A6) — C2 T1 proves it.
Security: new public login surface → same login rate limits (04 §4), breached-password checks apply.
```

```
Title: CR-C17-005: EngagementPort.getHomeAddress (new port, owner C16)
From chunk: C17          To owner: C0-0C + C16
Type: port   Blocking? no (dispatcher enters the address; flag address_missing)
Problem: engagement.booking.confirmed.v1 carries home_address_id only ("consumers resolve via authorised
  calls", 03-IC §3.22) but no port or endpoint exists.
Proposed: contracts/ports/EngagementPort.ts
  getHomeAddress(ctx, input: { homeAddressId: Uuidv7; purpose: 'home_visit' }):
    Promise<{ addressText: string; landmark?: string; latitude?: DecimalString; longitude?: DecimalString }>;
  @throws common.not_found. Consumers: C17. System actors allowed.
```

```
Title: CR-C17-006: homecollection.collection.synced.v1 — optional payment reference; field semantics; trigger
From chunk: C17 (producer)  To owner: C0-0C (C4 consumer agrees)
Type: event   Blocking? no
Proposed (additive, stays .v1): payments[].reference { type: string, minLength 1, maxLength 100 } optional
  (C4 seed marks fonepay_qr/card/bank_transfer requires_reference). Document: collected_at_device /
  captured_at_device carry the server-corrected capture time (TRD §7.5), C5 still clamps; trigger also covers
  a dispatcher "apply" of a held collection (collections only, payments empty).
```

```
Title: CR-C17-007: New homecollection error codes
From chunk: C17          To owner: C0-0C
Type: api   Blocking? no
- { code: homecollection.app_version_unsupported, http: 426, owner: C17, title: "App update required", meaning: "Below tenant min_app_version (REQ-SEC-113)" }
- { code: homecollection.device_not_registered, http: 409, owner: C17, title: "Device not registered", meaning: "Unknown device id or bound to another user" }
- { code: homecollection.visit_incomplete, http: 422, owner: C17, title: "Visit is not ready to assign", meaning: "Address and time window required" }
- { code: homecollection.phlebotomist_not_eligible, http: 422, owner: C17, title: "Phlebotomist cannot take this visit", meaning: "Inactive, other centre, or no phlebotomist role" }
- { code: homecollection.collection_not_held, http: 409, owner: C17, title: "Collection is not awaiting review", meaning: "" }
```

```
Title: CR-C17-008: Permissions for handover, devices, settings; lab_manager read
From chunk: C17          To owner: C0-0C
Type: api   Blocking? no
- { code: homecollection.handover.receive,  privileged: false, roles: [centre_staff, front_desk, lab_technologist], phase: 3 }
- { code: homecollection.device.manage,     privileged: true,  roles: [tenant_admin, lab_manager], phase: 3 }
- { code: homecollection.settings.manage,   privileged: true,  roles: [tenant_admin, lab_manager], phase: 3 }
- homecollection.visit.read roles: add lab_manager (it already holds visit.assign but cannot read the board).
```

```
Title: CR-C17-009: Staff routes for home collection
From chunk: C17          To owner: C0-0C (routes.yaml)
- { id: staff.homecollection.dispatch,  origin: staff_web, path: /homecollection/dispatch,  owner: C17, permission: homecollection.visit.read }
- { id: staff.homecollection.handovers, origin: staff_web, path: /homecollection/handovers, owner: C17, permission: homecollection.handover.receive }
- { id: staff.homecollection.devices,   origin: staff_web, path: /homecollection/devices,   owner: C17, permission: homecollection.device.manage }
- { id: staff.homecollection.settings,  origin: staff_web, path: /homecollection/settings,  owner: C17, permission: homecollection.settings.manage }
```

```
Title: CR-C17-010: Flutter dependencies for phlebo_app
From chunk: C17          To owner: C0-0D (pinning, licence review)
Type: shared-lib   Blocking? partially (biometric gate, tel/maps hand-off, GPS)
Request: pin (exact versions, licence, last release, network-egress check = none):
  biometric/device-credential prompt (candidate local_auth); OS URL hand-off (candidate url_launcher);
  location point capture (candidate chosen by C0, no Google Play-services network dependency preferred);
  confirm mobile_scanner (or alternative) for LimsBarcodeScanner works fully on-device.
  Until pinned: re-auth gate falls back to full password login after > 5 min background; capture_gps forced off.
```

```
Title: CR-C17-011: Certificate pin set and rotation runbook for phlebo_app
From chunk: C17          To owner: C1
Type: infra   Blocking? for production release only
Request: per-environment issuing-CA certificates (current + backup) for the API origin, delivered as build
  inputs; rotation runbook with ≥ 30 days lead time; ECDSA P-256 / 90-day ACME per 04 I5 means the pin must be
  on the CA/intermediate, not the leaf.
```

```
Title: CR-C17-012: Founder decision — map hand-off of the patient address (B11)
From chunk: C17          To owner: founder
Problem: "Navigate" passes the address/coordinates to the device's maps app, which may transmit it abroad.
Default: map_handoff_enabled = false. Decision needed per tenant before enabling.
```

```
Title: CR-C17-013: ctx.core membership query by centre and role
From chunk: C17          To owner: C0-0D (core repository)
Type: shared-lib   Blocking? no (fake)
Proposed: ctx.core.memberships.list(tx, { centreId, roleCode?, activeOnly: true }) →
  [{ membershipId, displayName, roleCodes, allCentres }]; ctx.core.centres.list(tx, { kinds? }).
  Used for eligibility (H3/H12) and handover centres (snapshot config).
```


# C18-legacy-migration  (own CRs: 10)

## 19. Change requests raised

All CRs are **non-blocking for other chunks**; they block C18 tasks only (06-IMPLEMENTATION-PLAN). File them now so owners can plan; owners implement when B4 is lifted (founder decides timing). Designed as if accepted, marked [CR].

```
Title: CR-C18-001: migration_staging DDL, role lims_migration, system actor 'migration'
From chunk: C18            To owner: C0-0B
Type: schema               Blocking? yes — C18 T03+ (staging)
Problem: C0 05-SCHEMA §2 creates schema migration_staging with "none (C18 defines its own loader role by CR)". C18 needs its tables and a login role
 that can write staging and run owner port code under RLS (PRD US-02..US-12).
Proposed change (exact): 05-SCHEMA.md of C18 §2 (role + grants), §4 (DDL), §5 (RLS). Summary:
  CREATE ROLE lims_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; ALTER ROLE lims_migration NOLOGIN (enabled per window by C1 runbook);
  GRANT lims_app TO lims_migration WITH INHERIT TRUE, SET FALSE;  GRANT USAGE ON SCHEMA migration_staging TO lims_migration;
  tables of C18 05-SCHEMA §4 owned by lims_owner, policies TO lims_migration only; lims_app gets nothing on migration_staging;
  db/meta/system-actors.yaml: add module 'migration' with a fixed UUIDv7; core.g_system_actors seed row;
  db/meta/tables.yaml entries with class, phi_class per column, retention; migration file prefix migration_staging__ (last in the DAG, C0 02-TRD §4.2).
Backward compatible? yes (additive)
Tenant/security impact: new login role with lims_app membership (REQ-SEC-039/131: NOBYPASSRLS, no ownership); staging tables FORCE RLS (REQ-SEC-011/012);
 role disabled outside windows. Probes: §17. PHI: P2/P3 staging columns (05-SCHEMA §6).
Alternatives considered: running loads as lims_worker (rejected: would let the always-on worker read staging PHI; no window control).
Tests that will prove it: C18 05-SCHEMA §8 test list.
```

```
Title: CR-C18-002: LegacyPatientImportPort + frontdesk.patient_legacy_refs + legacy consent source + search by legacy code
From chunk: C18            To owner: C4 (frontdesk) + C0-0C (port type, permissions, errors) + C0-0B (DDL)
Type: port + schema + api  Blocking? yes — C18 T09
Problem: PRD US-07, US-14 (AC-14.1): migrated patients must be created by C4's own code (01 §5 R2) and found by old lab code (00 A2).
Proposed change (exact):
  Port: contracts/ports/LegacyPatientImportPort.ts = C18 02-TRD §5.1 (incl. LegacyPatientRow.reviewedDuplicates, §9.1).
  Port owner registry (C0 PORT_OWNERS): LegacyPatientImportPort → frontdesk; consumers: migration (tool runtime) only.
  DDL: frontdesk.patient_legacy_refs and frontdesk.legacy_import_batches as in C18 05-SCHEMA Appendix B.1;
       frontdesk.patient_consents.source CHECK adds 'legacy_import'.
  Behaviour: consent row source 'legacy_import', all flags false; C4 registration treats a patient whose latest consent source is
       'legacy_import' as "consent recapture required" (registration UI asks for consent as for a new patient).
  Search: POST /v1/frontdesk/patients/search also matches patient_legacy_refs.legacy_patient_code (exact, case-insensitive, ≥3 chars),
       result marked "matched on legacy code".
  Permissions (contracts/permissions.yaml): { code: frontdesk.patient.import_legacy, privileged: false, roles: [] }  # migration system actor only
  Errors: frontdesk.legacy_batch_conflict (409), frontdesk.legacy_void_window_closed (409).
  Coded set frontdesk legacy_import_reasons: invalid_field, link_target_not_found, duplicate_candidates, anonymised_target, already_voided.
  Coded set duplicate_override_reasons adds 'legacy_import_reviewed'.
  Contract tests (packages/fakes/contract-tests/LegacyPatientImportPort.contract.ts): (1) create_new → created + patient_code; (2) same batchId+hash
       → replayed; (3) same batchId other hash → conflict; (4) known legacy key → already_imported + changedFields; (5) link to other tenant's id → rejected
       link_target_not_found; (6) dry run leaves no rows after rollback and writes no storage; (7) >200 rows → validation_failed; (8) no event published,
       no NotificationPort call; (9) voidBatch deactivates unused patients, reports in_use for patients with a non-legacy order; (10) void after window → error;
       (11) create_new with dedupe candidates and no reviewedDuplicates → rejected duplicate_candidates with candidate ids; (12) system actor without the
       permission → auth.forbidden; (13) consent row source legacy_import with all flags false.
Backward compatible? yes (new port, new tables, new CHECK value, search extension additive)
Tenant/security impact: new P2 columns (legacy codes); search over legacy codes is access-logged like other searches; no new public surface.
Alternatives considered: HTTP bulk endpoint (rejected: needs a human token for hours-long loads; support sessions have no centre scope — C2 02-TRD §6).
```

```
Title: CR-C18-003: LegacyResultImportPort + lab.legacy_results + history/trend inclusion
From chunk: C18            To owner: C5 (lab) + C0-0C + C0-0B
Type: port + schema + api  Blocking? yes — C18 T10
Problem: PRD US-14 AC-14.2/14.3: previous results and trend from day one (00 C2, C7) without creating orders/specimens/results for past visits (PRD D-1).
Proposed change (exact):
  Port: contracts/ports/LegacyResultImportPort.ts = C18 02-TRD §5.1. Owner registry: lab; consumer: migration.
  DDL: lab.legacy_results, lab.legacy_import_batches — C18 05-SCHEMA Appendix B.2 (class C-legacy: content immutable; lifecycle columns
       superseded_at, superseded_by_id, voided_at, voided_by, void_reason_code, void_batch_id).
  Read paths: getResultHistory (#25) and getAnalyteTrend (#26) include rows of lab.legacy_results (not voided, not superseded) for the same
       patient_id + analyte_id when lab setting legacy_in_history = true (default true); each item carries source: 'legacy' and the response
       DTO field legacy_source_system; delta evaluation (02-TRD §5 delta.ts) ignores legacy rows unless legacy_in_delta = true (default false).
  Lab settings (lab.lab_settings): legacy_in_history boolean NOT NULL DEFAULT true, legacy_in_delta boolean NOT NULL DEFAULT false.
  Permissions: { code: lab.legacy_result.import, privileged: false, roles: [] }  # migration system actor only
  Errors: lab.legacy_batch_conflict (409), lab.legacy_void_window_closed (409). Coded set legacy_import_reasons: invalid_field, patient_not_found,
       analyte_not_found, result_type_mismatch, stale_version, already_voided.
  Contract tests: (1) created; (2) replay; (3) conflict; (4) same key+version → already_imported; (5) higher version → superseded_previous and the old
       row superseded; (6) lower version → rejected stale_version; (7) other tenant's patient id → rejected patient_not_found; (8) no event, no critical
       evaluation; (9) history API returns legacy rows labelled; (10) delta ignores legacy by default; (11) voidBatch hides rows from history; (12) dry run
       leaves nothing.
Backward compatible? yes (additive DTO field `source` on history items — consumers tolerate unknown fields)
Tenant/security impact: new P3 table, centre-scoped (centre_id + RLS TC template); no new public surface; history views already access-logged.
Alternatives considered: inserting into lab.results/result_versions (rejected: needs order_test/specimen/approval rows and membership ids that do not exist).
```

```
Title: CR-C18-004: LegacyDocumentImportPort + reporting.legacy_documents + bucket legacy-documents + staff list/download
From chunk: C18            To owner: C6 (reporting) + C0-0C + C0-0B + C0-0A (ctx.storage bucket)
Type: port + schema + api  Blocking? yes — C18 T11
Problem: PRD IS-8, AC-14.4: staff must open old report PDFs (00 §3 item 11) — untrusted files (04 R7).
Proposed change (exact):
  Port: contracts/ports/LegacyDocumentImportPort.ts = C18 02-TRD §5.1. Owner registry: reporting; consumer: migration.
  DDL: reporting.legacy_documents, reporting.legacy_import_batches — C18 05-SCHEMA Appendix B.3.
  Storage: private bucket 'legacy-documents', paths {tenant_id}/quarantine/{yyyy}/{mm}/{document_id}.bin and {tenant_id}/legacy/{yyyy}/{mm}/{document_id}.pdf
       ({yyyy}/{mm} of created_at UTC); same scan → qpdf-sanitise pipeline as input_files (04 R7; REQ-SEC-083/084/087); write-once.
  HTTP (contracts/openapi/reporting.yaml):
     GET  /v1/reporting/patients/{patient_id}/legacy-documents  op listLegacyDocuments  x-permission reporting.legacy_document.read
          → {data:[{id, document_kind, document_date, title?, legacy_registration_no?, page_count?, state, created_at}], page}; only state ready listed
            unless caller holds reporting.template.manage (sees quarantined/rejected for triage) [CONV]
     GET  /v1/reporting/legacy-documents/{legacy_document_id}/pdf  op downloadLegacyDocumentPdf  x-permission reporting.legacy_document.read
          → 200 application/pdf, Content-Disposition attachment, Cache-Control no-store, nosniff; access_log 'legacy_document.download';
            rate tier general; 404 common.not_found for other tenant/centre or not ready.
  Permissions: { code: reporting.legacy_document.import, privileged: false, roles: [] }  # migration system actor only
               { code: reporting.legacy_document.read, privileged: false, roles: [front_desk, centre_staff, lab_technologist, pathologist] }
  Errors: reporting.legacy_batch_conflict (409), reporting.legacy_void_window_closed (409). Coded set legacy_import_reasons: invalid_field,
       patient_not_found, not_pdf, too_large, sha256_mismatch, changed_document, already_voided.
  Not delivered to portal/WhatsApp/patient app; no QR token (PRD D-6).
  Contract tests: (1) accepted → pending_scan, summary states; (2) replay; (3) conflict; (4) same key + sha → already_imported; same key other sha →
       rejected changed_document; (5) non-PDF magic → rejected not_pdf; (6) > 15 MB → rejected too_large; (7) dry run writes no storage object;
       (8) scan hit → quarantined, never downloadable; (9) download by tenant_b → 404; (10) void hides from list and download.
Backward compatible? yes
Tenant/security impact: new P3 objects; first path segment tenant_id (04 D15 pattern); D3 Storage claims UNVERIFIED → server-side ctx.storage only.
```

```
Title: CR-C18-005: Tool runtime for tools/* (port registry + tenant transaction as a system actor) + legacy-common port types
From chunk: C18            To owner: C0-0D (services/worker core) + C0-0C (contracts/ports/legacy-common.ts)
Type: shared-lib / port    Blocking? yes — C18 T02
Problem: C18 must call owner ports in-process (01 §5: ports are the synchronous channel) but owns no API/worker module (01 §3).
Proposed change (exact): export createToolRuntime() from @lims/worker/tool-runtime with the signature in C18 02-TRD §4.2: same claims/set_config
  path as worker jobs (02-CV §5.10, §6), same port registry and fake/real resolution and production no-fake check (02-CV §8.2), opts.rollback for
  dry runs, systemPermissions validated against contracts/permissions.yaml (never platform.*), actorModule must exist in system-actors.yaml.
  contracts/ports/legacy-common.ts with the types of C18 02-TRD §5.1.
Backward compatible? yes
Tenant/security impact: a second process type acting as a system actor; it requires the lims_migration login (CR-C18-001), so it cannot run with
 lims_api/lims_worker credentials by accident (runtime asserts current_user = 'lims_migration').
Tests: runtime opens tx with correct claims; rollback option leaves no rows; fake ports refused in production mode; unknown permission refused.
```

```
Title: CR-C18-006: Migration host provisioning, transfer path, secrets, role window, metrics textfile, alerts
From chunk: C18            To owner: C1
Type: infra                Blocking? yes — C18 T13 (rehearsal), not for build
Proposed change (exact):
  - LUKS-backed volume on app-1 mounted /srv/lims/migration (size per C18 02-TRD §15: ≥ 2 × PDFs of the history years + 20 %), owner uid of the
    lims-migrate container, mode 0700, marker file .lims-migration-volume; excluded from any sync to ops-1; included in no backup (staging is
    re-creatable from the package; the package itself is kept until sign-off on this volume only).
  - Container image lims-migrate (built from tools/migration, pinned by digest) run via playbook migration-run.yml (interactive, ops_admin only).
  - SOPS secret migration.database_url (prod only when a window is approved); playbook migration-window.yml -e action=open|close toggles
    ALTER ROLE lims_migration LOGIN/NOLOGIN and rotates the password on open.
  - Inbox: SFTP-only chroot /srv/lims/migration/inbox/<tenant_code>/ via a temporary WireGuard peer (wg_peers entry with expiry note) — removed on
    close of the cut-over window; age recipient key for the migration volume (private key on the volume only).
  - node_exporter textfile directory + collector for LIMS_MIGRATION_METRICS_TEXTFILE; systemd timer every 5 min: lims-migrate status --metrics.
  - Alerts MigrationLoadStalled, MigrationStagingNotPurged (C18 02-TRD §16), plus a C1-owned alert when role lims_migration
    has an active session or a successful login while no migration window is recorded as open (REQ-SEC-045/133).
  - Network: lims-migrate container → data-1:5432 over wg0 only; no egress to the internet (Squid not configured for it).
Tenant/security impact: REQ-SEC-125 (LUKS), 128 (secrets), 132 (segmentation), 136 (prod only).
```

```
Title: CR-C18-007: IdentityPort handling for the 'migration' system actor
From chunk: C18            To owner: C2
Type: port semantics       Blocking? yes — C18 T09
Problem: assertRole for actor_type 'system' uses the module manifest's systemPermissions (03-IC §4.6). The migration actor is declared by the tool runtime,
 not by a module manifest.
Proposed change: IdentityPort.assertRole resolves systemPermissions for actor 'migration' from the tool-runtime registration (C0 system-actors registry,
 CR-C18-005); access_log entries for owner reads made during verification carry actor 'migration'. No human role gets the three *.import_legacy / *.import codes.
Backward compatible? yes
```

```
Title: CR-C18-008: Optional catalog import kind 'credit_parties'
From chunk: C18            To owner: C3
Type: api                  Blocking? no (default: finance enters credit parties by hand in C3's screens)
Problem: catalog.imports.kind allows price_list, catalog_master, referrers (C3 05-SCHEMA); credit parties (00 E2/E6) cannot be bulk-loaded.
Proposed change: kind 'credit_parties', sheet CreditParties (party_code, name, kind, allows_credit, pan, contact_phone_e164, contact_email, billing_address),
 upsert by party_code, permission catalog.price_list.manage.
```

```
Title: CR-C18-009 (DRAFT — DO NOT FILE until B6/B7 are answered): legacy invoice reference documents and opening balances
From chunk: C18            To owner: C4 (billing) + auditor review
Type: schema + api
Problem: PRD US-15. Historical invoices issued by eLabs may need to be viewable; dues and credit-party balances may need opening entries.
Constraints (04 L5–L8): never insert into billing.invoices/credit_notes/ledger_entries; never allocate or advance billing.fiscal_counters; never sync to CBMS;
 any reference document must be visibly marked as issued by the previous software and must itself be immutable (VAT Act s.29(1)(g2) applies to our software).
Options for the auditor: (A) no import — lab keeps eLabs read-only for invoice look-ups [current default]; (B) read-only "legacy invoice reference" table outside
 the billing sequence with PDF copies; (C) opening-balance records per credit party at cut-over date. Questions: does a mid-FY switch require continuing the
 eLabs number series or a new series (B6 series granularity); how are the two softwares' sales registers combined for that FY.
```

```
Title: CR-C18-010: Align B4 default wording (04 §13 vs 07-BLOCKERS) and 01 §2 C18 row
From chunk: C18            To owner: doc owner (founder)
Type: docs                 Blocking? no
Problem: 04 §13 B4 default = "No migration design"; 07-BLOCKERS B4 = "No migration build; only C18's requirements doc and target mapping"; the lead asked
 for the full pipeline design. C18 follows 04 for building (no build) and the lead's request for documents.
Proposed change: 04 §13 B4 default → "No migration build; C18 documents specify canonical format, staging, mapping, validation and cut-over (design only)".
```
