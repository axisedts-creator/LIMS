# C2 — Identity, Access & Administration — 02 TRD

Status: DECISION draft, 2026-11-05. Reads with `01-PRD.md`. All names (tables, endpoints, permission and error codes) match `program/03-INTERFACE-CATALOG.md` (03) and `program/02-CONVENTIONS.md` (02-CV); anything new is marked **(CR-C2-nnn)** and listed in §15.

---

## 1. Owned paths (01 §3; additions via CR-C2-001)

| Path | Content |
|---|---|
| `services/api/src/modules/identity/` | API module `identity` (handlers, services, domain, repositories, ports/IdentityPort.impl.ts, gotrue gateway, claims resolver) |
| `services/worker/src/jobs/identity/` | worker tasks + crontab for identity |
| `apps/web/src/app/(staff)/admin/` | tenant admin route segment (`/admin/...`) |
| `apps/web/src/features/admin/` | admin components, BFF server functions, nav manifest, help — **also hosts the auth-page components** (`features/admin/auth/`) |
| `apps/web/src/app/(auth)/auth/` | **(CR-C2-001)** unauthenticated route group: `/auth/login`, `/auth/mfa`, `/auth/mfa/enrol`, `/auth/forgot`, `/auth/confirm`, `/auth/set-password`, `/auth/session-expired`, `/auth/logout` |
| `apps/web/src/app/(platform)/platform/` | **(CR-C2-001)** platform console route group with its own layout (replaces `(staff)/platform/`; URLs stay `/platform/...` per `contracts/routes.yaml`) |
| `apps/web/src/features/platform/` | platform console components, BFF server functions, nav manifest, help |
| `docs/manual/admin/`, `docs/manual/platform/` | user manual pages (01 §2 training note) |

C2 never edits `db/`, `contracts/`, `packages/*`, any `core/` folder (01 §4).

## 2. Stack and pinned libraries

| Component | Version | Source |
|---|---|---|
| Node.js | 26.x LTS, exact patch C0-pinned | 02-CV §1.1 |
| TypeScript, Fastify, Next.js (App Router, server-only BFF) | C0 pins | 02-CV §1.1; 04 S4 |
| `fastify-openapi-glue` | 4.12.0 | 04 T7 |
| Graphile Worker | 0.18.0 | 04 S10, T7 |
| PostgreSQL | 17 via `supabase/postgres:17.6.1.136` | 04 D9 |
| PgBouncer | ≥1.21, transaction mode | 04 S8 |
| GoTrue (Supabase Auth, self-hosted) | version fixed by the self-hosted Supabase release C0/C1 pin; C2 records it in §8 at T1 | 04 S2 |
| `openapi-typescript` / `openapi-fetch` (BFF calls) | 7.13.0 / 0.17.0 (generated client from C0) | 04 T7 |
| MSW (web tests) / Prism (mocks) | 3.0.3 / 5.16.0 | 04 T7 |
| B.S. dates | via `@lims/shared-ts/bsdate` (wraps `@remotemerge/nepali-date-converter` 1.2.7) | 04 D13 |
| UUIDv7, logger, errors, CSPRNG | `@lims/shared-ts` | 02-CV §1.3, §4.10 |
| AES-256-GCM, SHA-256, HMAC-SHA-256, timing-safe compare | `node:crypto` (built-in; no new dependency) | DECISION |
| CSV encoding (exports) | every text cell passes `@lims/shared-ts/spreadsheet` `neutraliseFormula` (08 A13 P-9; module-local guards are banned); C2 does only the RFC 4180 quoting (no dependency) | 08 A13 P-9 |
| Image decode/re-encode, malware scan | via C0 upload pipeline (CR-C2-011); C2 adds no image library | 02-CV §10.2 |

**Dependencies table (02-CV §15.1):** C2 adds **no** third-party runtime dependency. Any later addition must add a row here.

## 3. Internal module architecture

### 3.1 Layers (02-CV §2.2)

```
handlers/   thin: authz (IdentityPort / PlatformAuthz) → service → mapper. No SQL.
service/    use-cases; opens ctx.db.tx; enqueues jobs; calls GoTrueGateway only where §4 allows
domain/     pure: password policy, numbering-pattern parser, settings ranges, state tables
repository/ SQL on identity.* and (CR-C2-002) core.* admin tables / audit.* reads
gotrue/     GoTrueGateway interface + HTTP implementation + fake (only place that talks to GoTrue)
claims/     claims resolver registered with C0 core auth (CR-C2-005)
ports/      IdentityPort.impl.ts
mappers/    explicit per-role DTO allowlists (REQ-SEC-081)
```

### 3.2 File skeleton

```
services/api/src/modules/identity/
├── index.ts                         # ModuleManifest: name 'identity', openapi 'contracts/openapi/identity.yaml',
│                                    # handlers, ports { IdentityPort }, produces: [], claimsResolver (CR-C2-005)
├── permissions.ts                   # codes checked (03 §11 + CR-C2-006)
├── config.ts                        # §11 keys (LIMS_IDENTITY_*)
├── handlers/index.ts + one file per operationId (§5)
├── service/
│   ├── auth.service.ts              # login, mfa challenge/enrol, logout, recover, confirm, set-password
│   ├── session.service.ts           # resolve/touch/refresh/revoke, timeouts
│   ├── user.service.ts              # invite, update, roles, centre scope, lock, deactivate, mfa reset, signature
│   ├── role.service.ts
│   ├── org.service.ts               # branches, centres
│   ├── settings.service.ts          # tenant settings, pending numbering, branding assets, feature flags
│   ├── audit-view.service.ts        # audit/access/auth-event queries, exports
│   ├── access-review.service.ts
│   ├── tenant.service.ts            # platform: provisioning, lifecycle
│   ├── ird.service.ts               # platform: annex tracker
│   ├── support.service.ts           # support sessions (platform + tenant side)
│   ├── dead-letter.service.ts       # platform
│   └── platform-staff.service.ts
├── domain/
│   ├── password-policy.ts           # length, 72-byte, breached lookup port (repo)
│   ├── numbering-pattern.ts         # tokenizer/validator for 03 §9.3 tokens
│   ├── settings.ranges.ts           # 04 A8/A10/I8 ranges
│   ├── session.state.ts             # 03-APP-FLOW §2.1
│   ├── membership.state.ts          # §2.2
│   ├── tenant.state.ts              # §2.3
│   ├── support-session.state.ts     # §2.4
│   ├── ird-annex.state.ts           # §2.5
│   ├── invitation.state.ts          # §2.6
│   ├── export.state.ts              # §2.7
│   └── permission-set.ts            # role→permission resolution, support allowlist, fixed actor sets
├── repository/                      # sessions.repo, mfa.repo, auth-events.repo, settings.repo, flags.repo,
│                                    # invitations.repo, support.repo, platform-staff.repo, ird.repo,
│                                    # exports.repo, access-review.repo, assets.repo, breached.repo,
│                                    # core-admin.repo (CR-C2-002), audit-read.repo (CR-C2-002)
├── gotrue/{gateway.ts, gateway.http.ts, gateway.fake.ts, mapping.md}
├── claims/resolver.ts
├── ports/IdentityPort.impl.ts
├── platform/authz.ts                # PlatformAuthz.assertPlatform(ctx, permission)
├── mappers/*.dto.ts
├── cli/bootstrap-platform-admin.ts  # one-shot, see 03-APP-FLOW §9.4
└── __tests__/{unit,integration,contract,probes}/
services/worker/src/jobs/identity/
├── index.ts                         # WorkerManifest (tasks, crontab; subscriptions: {} — C2 consumes no events)
├── tasks/{gotrue_signout,send_invitation,send_recovery,remove_mfa_factors,build_audit_export,
│          import_breached_passwords,rescan_upload,notify_ip_throttle,apply_pending_numbering,access_review_due}.ts
├── cron.ts                          # §10
└── __tests__/
```

## 4. Session and token architecture (the core design)

DECISION summary (04 S4, A5–A8; REQ-SEC-065/068/073):

1. **GoTrue is reachable only from the API network** (C1, CR-C2-012). The browser and the BFF never call GoTrue. All GoTrue calls go through `GoTrueGateway` in the identity module.
2. **The BFF holds only an opaque session token** in cookie `__Host-lims_sid` (`HttpOnly; Secure; SameSite=Lax; Path=/`; `Max-Age` = absolute timeout) [CONV name]. Token = 32 bytes CSPRNG, base64url (256-bit; ≥ the 128-bit floor used for other bearer secrets in 04 A10–A12). Server stores only `SHA-256(token)`.
3. **The server-side session record is `identity.sessions`** (02-CV §5.2 class E "BFF session records"). It stores the GoTrue refresh token and current access JWT **encrypted with AES-256-GCM** (keys `LIMS_IDENTITY_TOKEN_ENC_KEYS`, §11: the newest key id encrypts; key id column for rotation).
4. **BFF → API**: for session operations the BFF forwards the cookie to `/v1/identity/auth/*` operations secured by `bffSession` (02-CV §4.12; CR-C2-009 fixes its meaning as "the `__Host-lims_sid` cookie forwarded server-to-server by the BFF"). For every other API call the BFF sends `Authorization: Bearer <access JWT>` obtained from `resolveSession` (02-CV §6).
5. **Claims are always resolved server-side by the API** (02-CV §6 fallback made the primary path — DECISION, removes dependence on the UNVERIFIED self-hosted access-token hook): after C0 core verifies the GoTrue JWT (alg/exp/aud/iss, 04 A7), the identity `claimsResolver` maps `(sub, session_id claim)` → our `identity.sessions` row → tenant, membership, state, support session; builds the claims JSON that C0 writes into `request.jwt.claims`. `session_id` as a GoTrue claim is **UNVERIFIED for the pinned version** — proven by C0 SP-1 / C2 T1 (08 R10.6); the hosted supabase.com custom-access-token-hook docs (fetched 2026-11-05, not a research/04 source) list it as required. Consequences:
   - a JWT minted by GoTrue without our login flow has no session row → `401 auth.unauthenticated` (closes the "bypass our rate limits/breach check by calling GoTrue directly" hole even if GoTrue were exposed);
   - revocation, lock, tenant suspension, idle and absolute timeouts take effect **on the next API request**, not at JWT expiry (REQ-SEC-065/073);
   - role/centre changes are live (no stale claims).
6. **Idle tracking**: the BFF calls `resolveSession` with `touch: true` for user-initiated requests and `touch: false` for background polling/SSE: the **browser** request carries `X-Lims-Background: 1`, set by the `@lims/ui` polling/SSE helpers, and the BFF maps it to `touch: false` (CR-C2-009; 08 A25 D-206 — nginx passes the header through on BFF origins; spoofing it only shortens the sender's own session). The API updates `last_seen_at`/`idle_expires_at` at most once per 60 s per session [CONV] (write budget §12).
7. **Access JWT refresh** happens inside `resolveSession` when the stored access JWT expires within 120 s [CONV]: `SELECT … FOR UPDATE` on the session row serialises concurrent BFF instances so the rotating refresh token (04 A6) is used once; the rotated refresh token is stored in the same transaction. A refresh failure (reuse detected / revoked in GoTrue) → session `revoked` (reason `refresh_failed`).
8. **BFF cache**: the BFF may cache `{access_token, access_expires_at, idle_expires_at}` in process memory for ≤ 60 s [CONV] keyed by `SHA-256(token)`; never on disk, never in the browser.
9. **Platform staff** use the same mechanism with `identity.sessions.kind = 'platform'` (tenant_id NULL). Support sessions bind a target tenant to a platform session row (§6.3).
10. **Session kinds** `tenant_staff`, `platform`, `partner`, `patient`, `staff_mobile` (08 R10 table, lifetimes and claims):

    | Kind | Client | Endpoint family | Binding | Idle / absolute | Claims |
    |---|---|---|---|---|---|
    | `tenant_staff` | staff-web BFF | `/v1/identity/auth/*` | BFF key = staff_web | 15–30 min / ≤ 12 h (04 A8) | `{sub, tenant_id, membership_id, actor_type:'user', aal, lims_session_id, session_state}` |
    | `platform` | staff-web BFF, `(platform)` group | `/v1/identity/auth/*` | BFF key = staff_web + `platform_staff` login | 15–30 min / ≤ 12 h | `{sub, actor_type:'user', scope:'platform', platform_staff_id, platform_role, aal, lims_session_id}`; with support session `{…, tenant_id, scope:'support', support_session_id, support_scope}` |
    | `partner` | partner BFF (`apps/partner`) | `/v1/identity/auth/partner/*` | BFF key = partner | 15–30 min / ≤ 12 h | `{sub, tenant_id, membership_id, actor_type:'partner', aal, lims_session_id, session_state}` |
    | `patient` | patient app (no BFF) | `/v1/identity/auth/patient/*` | endpoint family | 14 d / 30 d [DECISION; tenant-configurable 1–30 / 1–90 d] + app lock (`LimsAppLockGate`) | `{sub, tenant_id, membership_id, actor_type:'patient', aal:'aal1', lims_session_id, session_state:'active'}` |
    | `staff_mobile` | phlebotomy app | `/v1/identity/mobile/sessions*` | endpoint family; only memberships holding `homecollection.sync.upload` | no idle (04 A16 local re-auth instead) / ≤ 12 h (04 A8) | as `tenant_staff` |

    Each BFF authenticates to `/v1/identity/auth/*` with its own `X-Lims-Bff-Key` (staff_web, partner; secret store); the key, not a header, binds the session kind. Patient and staff-mobile sessions use opaque LIMS session tokens (256-bit, app secure storage, 04 A15) with rotation on every refresh + reuse detection; GoTrue refresh tokens stay server-side, encrypted (item 3). **Rotation and reuse detection (CR-C2-018, 08 Addendum A3.1):** on each refresh, in the same row-locked transaction as the GoTrue refresh (item 7), the current `token_sha256` moves to `identity.sessions.previous_token_sha256` (only one previous token is kept; an older one is overwritten) and the new token's hash becomes `token_sha256`. Token lookup goes only through the DEFINER `app.identity_session_by_token`, which matches either column (partial global unique index on `previous_token_sha256`, an index-rule exception). A presented token that matches `previous_token_sha256` (`token_reused = true`) → the session is revoked (`revoke_reason = 'token_reuse'`), auth event `session_token_reused` is written, and the caller gets `401 auth.session_expired`. A session of one kind presented on another endpoint family → `401 auth.session_expired`; a staff credential on partner login (and vice versa) → `401 auth.login_failed`. No client header (e.g. an origin header) is trusted for binding.
11. **Login throttling** (04 §4 as amended by 08 Addendum A1; applies to staff web, partner and staff-mobile login — patient OTP keeps its own limits): per account 10/hour; ≥ 5 failures per account → exponential backoff + step-up; **per client IP, failed attempts only**: ≥ 10 failed logins within 10 min from one client IP → that IP is limited to 5 attempts/min for 30 min, a security event (`identity.auth_events` `login_ip_throttled`) is written, the LIMS provider on-call is alerted, and the worker task `identity.notify_ip_throttle` (§10; 08 A25 D-217) inserts an `admin_notices` row (kind `login_ip_throttled`) in every tenant whose accounts were targeted (tenants resolved from the failure window's `email_hmac` values by the DEFINER `app.identity_tenants_for_email_hmacs`, 05-SCHEMA §6; no HTTP response can observe the mapping). Successful logins never consume per-IP quota. **The client IP is `ctx.clientIp` (= `app.client_ip`, set by C0 core from the trusted edge only — 08 A25 P-61), never a header read by C2**; C0 takes `X-Forwarded-For` only with a valid `X-Lims-Bff-Key` or from a peer in `LIMS_CORE_TRUSTED_PROXY_CIDRS` (nginx), so the non-BFF public routes (`openMobileSession`, `refreshMobileSession`, patient routes) also get the phone's edge IP, never nginx's or the BFF's address (08 R6 placement rule). Thresholds are [CONV] tenant-independent config (§11). There is no IP registration and no dependency on static lab IPs.

## 5. Endpoints (all in `contracts/openapi/identity.yaml`, prefix `/v1/identity/`)

Conventions for every row: request/response JSON snake_case, `additionalProperties: false`, no `null` on the wire, cursor pagination (`limit` ≤ 200, default 50), `If-Match` on every update/action of a versioned resource (`409 common.version_conflict`, `428 common.precondition_required`), problem+json errors (02-CV §4). "Idem" = `x-idempotency`. "Tier" = `x-rate-limit-tier` (02-CV §10.3). Every operation can also return `400 common.validation_failed`, `401 auth.unauthenticated|auth.token_invalid|auth.token_expired|auth.session_expired`, `404 common.not_found` (object ops), `429 common.rate_limited`, `500 common.internal` — not repeated. Security column: `bffSession` (cookie forwarded by BFF) or `bearerJwt`. **Tier:** every row of §5.3–§5.10 that has no Tier column is `x-rate-limit-tier: general` (02-CV §10.3; no row there uses another tier). **Idem:** every operation states `required`, `optional` or `none` (08 A13 P-8: creates of state, master data included, are `required`; state actions `optional`; reads `none`).

**Pre-auth and session transactions (08 A25 D-212).** Every §5.1 operation is tagged `x-context: identity_auth` and carries `x-public` with a justification; C0's authz guard (stage 9) exempts `x-context: identity_auth`, and these handlers check their own preconditions (session state, kind binding). They are the core-config allowlist of `ctx.db.identityAuthTx(fn)`: `loginStaff`, `loginPartner`, `openMobileSession`, `refreshMobileSession`, `logoutMobileSession`, `confirmEmailToken`, `requestPasswordRecovery`, `verifyMfaChallenge`, `startMfaEnrolment`, `completeMfaEnrolment`, `resolveSession`, `logoutSession`, `setPasswordFromSetup`, `resolvePatientSession`, `logoutPatientSession`. `identityAuthTx` opens the request transaction with claims `{sub: <identity system actor>, actor_type: 'system'}` and **no** `tenant_id`; in that state only the inventoried DEFINERs of 05-SCHEMA §6 and the tenant-less `auth_events` insert (`app.identity_record_auth_event`) work. After a DEFINER (`app.identity_login_context` / `app.identity_session_by_token` / `app.identity_resolve_session`) has chosen the membership, the handler calls `tx.bindTenant(tenantId)` **once**; it rewrites the transaction-local claims to `{…, tenant_id}` and the ordinary `__tenant` policies (with the P-16 guard, which admits system) apply. The `__own` session INSERT policy is not used by these paths; the admitting policy of each write is in 05-SCHEMA §5.2. **Platform staff** (no tenant to bind, 08 A28.1): platform-row writes inside these operations go through the DEFINERs `app.identity_platform_auth_write_{session_insert,session_update,mfa_factor,invitation_accept,staff_login}` (05-SCHEMA §6), never through `bindTenant`; after login, §5.10 operations write platform rows under `__platform` policies. Every success path writes an auth event. Bound: only these operationIds, only the identity system actor, at most one tenant per transaction.

**Failure writes on ≥ 400 (08 A19 P-42; A25 D-202).** A handler that writes a failure auth event, `sessions.mfa_failed_attempts`, the `login_ip_throttled` event / throttle state or an admin notice and then returns ≥ 400 calls `ctx.commitOnError()` right after those writes and makes no other write in that transaction. This covers `loginStaff`, `loginPartner`, `openMobileSession` (wrong password, throttle engaged), `verifyMfaChallenge` and `completeMfaEnrolment` (wrong code, 5th-failure revoke), `changeOwnPassword` (wrong current password) and the refresh-token reuse revoke (`refreshMobileSession` / patient refresh: revoke + `session_token_reused` + `401`). Idempotency keys are never stored for a 4xx (D-202). Each path has an integration test that asserts the write survives the 4xx (06 T6, T7, T10, T31).

### 5.1 Auth (BFF-facing; called only by `apps/web` server code)

| operationId | Method + path | Security / permission | Request fields | Response | Errors (beyond common) | Idem | Tier |
|---|---|---|---|---|---|---|---|
| `loginStaff` | POST `/auth/login` | none; `x-public: "pre-authentication; reachable only from the BFF network (CR-C2-012)"` | `email` (string, email format, ≤254), `password` (string 1–128 chars) | 200 `LoginResult { session_token (string 43), session: SessionState }` | 401 `auth.login_failed`, 401 `auth.step_up_required`, 403 `auth.account_locked`, 403 `identity.membership_inactive`, 403 `identity.tenant_suspended`, 403 `identity.platform_ip_denied` (CR) | none | `login` |
| `verifyMfaChallenge` | POST `/auth/mfa/verify` | bffSession; `x-public: "completes login; session token authenticates"` | `code` (string, pattern `^[0-9]{6}$`) | 200 `SessionState` | 401 `auth.mfa_invalid`, 409 `common.version_conflict` (session not in `mfa_pending`) | none | `login` |
| `startMfaEnrolment` | POST `/auth/mfa/enrolment` | bffSession (`mfa_enrolment_required` or `active`); `x-public: "MFA enrolment during login; session token authenticates, handler checks state"` | `friendly_name` (≤40, optional) | 200 `{ factor_id (uuid), otpauth_uri (string ≤512), qr_svg_base64 (string ≤20000, optional), secret_base32 (string ≤64) }` | 409 `common.version_conflict` (already has verified factor) | none | `login` |
| `completeMfaEnrolment` | POST `/auth/mfa/enrolment/{factor_id}/verify` | bffSession; `x-public: "completes MFA enrolment; session token authenticates"` | `code` (`^[0-9]{6}$`) | 200 `SessionState` | 401 `auth.mfa_invalid` | none | `login` |
| `resolveSession` | POST `/auth/session/resolve` | bffSession; `x-public: "session token authenticates"` | `touch` (boolean) | 200 `ResolvedSession { access_token, access_expires_at, session: SessionState }` | 401 `auth.session_expired`, 403 `auth.account_locked`, 403 `identity.tenant_suspended` | none | `general` |
| `logoutSession` | POST `/auth/logout` | bffSession; `x-public: "ends the presented session; session token authenticates"` | — | 204 | — | none | `general` |
| `requestPasswordRecovery` | POST `/auth/password/recover` | none; `x-public: "forgot password; constant response (04 A12)"` | `email` (≤254) | 202 `{}` always | — | none | `login` |
| `confirmEmailToken` | POST `/auth/token/confirm` | none; `x-public: "email link landing (invite/recovery)"` | `token_hash` (string ≤256), `type` (`invite`\|`recovery`) | 200 `LoginResult` (session in state `password_setup`) | 400 `auth.reset_token_invalid` (recovery), 400 `auth.invite_invalid` (invite) | none | `login` |
| `setPasswordFromSetup` | POST `/auth/password/set` | bffSession (`password_setup`); `x-public: "invite/recovery landing; session token from confirmEmailToken authenticates"` | `new_password` (1–128 chars) | 200 `SessionState` | 422 `auth.password_policy_violation`, 422 `auth.password_breached` | none | `login` |
| `loginPartner` | POST `/auth/partner/login` | as `loginStaff` (`x-public: "partner pre-authentication; partner BFF only"`); `x-edge-exposure: internal`; called only by the partner BFF (`X-Lims-Bff-Key` = partner) | as `loginStaff` | 200 `LoginResult` (session kind `partner`) | as `loginStaff`; staff credential → 401 `auth.login_failed` | none | `login` |
| `resolvePatientSession` | POST `/auth/patient/session/resolve` | `x-public: "patient app; opaque session token authenticates"`; `x-edge-exposure: public`; header `X-Lims-Patient-Session` | `touch` (boolean) | 200 `ResolvedSession` (kind `patient`) | 401 `auth.session_expired` | none | `general` (edge 120/min/IP, 08 R6) |
| `logoutPatientSession` | POST `/auth/patient/session/logout` | as `resolvePatientSession` | — | 204 | — | none | `general` |
| `openMobileSession` | POST `/mobile/sessions` | `x-public: "phlebotomy app login"`; `x-edge-exposure: public` | `email`, `password`, `app_instance_id` (uuid), `app_platform` (`android`\|`ios`) | 200 `{ session_token (opaque, 256-bit), access_token, access_expires_at, session_expires_at, session: SessionState }` (kind `staff_mobile`; only memberships holding `homecollection.sync.upload`) | as `loginStaff`; 403 `auth.forbidden` (permission missing) | none | `login` |
| `refreshMobileSession` | POST `/mobile/sessions/refresh` | `x-public: "session token authenticates"`; `x-edge-exposure: public` | `session_token` | 200 same shape; the session token rotates (old hash kept in `previous_token_sha256`); a reused previous token revokes the session (`token_reuse`, CR-C2-018) | 401 `auth.session_expired` | none | `general` |
| `logoutMobileSession` | POST `/mobile/sessions/logout` | as `refreshMobileSession` | `session_token` | 204 | — | none | `general` |

Patient sessions are opened only through `IdentityPort.openPatientSession` (called by C16 in the patient pre-auth context; the patient kind is blocked until C2 T1 confirms the GoTrue paths, §8, 08 A25 D-218) and refreshed by the app with the same rotate-and-detect-reuse rule (refresh path in the `/v1/identity/auth/patient/*` family). `x-edge-exposure` is `internal` for every other `/auth/*` operation (BFF network only, CR-C2-012). Per-IP flood guards for the public operations are nginx (C1); per-account and per-IP failure limits are this module's (§4 item 11).

`SessionState { session_id, kind (tenant_staff|platform|partner|patient|staff_mobile), state (password_setup|mfa_pending|mfa_enrolment_required|active), aal (aal1|aal2), idle_expires_at, absolute_expires_at, actor { display_name, tenant_code?, roles[], support_session? { id, tenant_code, scope, expires_at } } }`.

### 5.2 Self service (`identity.self.manage`, CR-C2-006; bearerJwt)

**Accepted session kinds: `tenant_staff`, `partner`** (08 A19 D-101: `fixed_actor_permissions.partner.partner_member` += `identity.self.manage`, `partner_admin` inherits it). For a partner, `getMe` returns `roles = [<partner role>]` (§7.1), `permissions` = the fixed partner set, `centre_scope { all: false, centre_ids: [] }`, `mfa` as for staff, `last_login_at` = `core.memberships.last_login_at`. The partner BFF (C13, `X-Lims-Bff-Key` = partner) calls these operations with the partner session's access JWT; the partner screens are C13's (C2's UI ME-1 is staff-only). A partner reads and changes only its own records: own sessions through `sessions__select__own_user` / `__own` (05-SCHEMA §5.2), own factors through `mfa_factors__*__own`; another member's `session_id` / `factor_id` → `404 common.not_found` (07-SECURITY AU-T20). `changeOwnPassword` with a wrong current password writes the failure auth event, calls `ctx.commitOnError()` and returns `401 auth.login_failed` (P-42).

| operationId | Method + path | Request | Response | Errors | Idem | Tier |
|---|---|---|---|---|---|---|
| `getMe` | GET `/me` | — | `Me { membership_id, display_name, email, roles[], permissions[], centre_scope { all, centre_ids[] }, mfa { enrolled, level }, last_login_at }` (`last_login_at` = `core.memberships.last_login_at` (per tenant; `core.users.last_login_at` is internal and never returned — 08 A6.3)) | — | none | general |
| `changeOwnPassword` | POST `/me/password` | `current_password`, `new_password` | 204 | 401 `auth.login_failed` (wrong current), 422 `auth.password_policy_violation`, 422 `auth.password_breached` | none | `login` |
| `listOwnSessions` | GET `/me/sessions` | `cursor`, `limit` | page of `SessionSummary` | — | none | general |
| `revokeOwnSession` | POST `/me/sessions/{session_id}/revoke` | — | 204 | 409 `identity.self_action_forbidden` (CR; current session — use logout) | optional | general |
| `listOwnMfaFactors` | GET `/me/mfa-factors` | — | `[{ factor_id, friendly_name, status, verified_at }]` | — | none | general |
| `removeOwnMfaFactor` | POST `/me/mfa-factors/{factor_id}/remove` | — | 204 | 409 `identity.self_action_forbidden` (role requires MFA and this is the last verified factor) | optional | general |

### 5.3 Users (bearerJwt; resource keyed by `membership_id`, matching route `staff.admin.user`)

| operationId | Method + path | Permission | Request | Response | Errors | Idem |
|---|---|---|---|---|---|---|
| `listUsers` | GET `/users` | `identity.user.read` | filters `status` (invited,active,deactivated), `is_locked` (wire name, kept — 08 A6.1; matches `locked_at IS NOT NULL`, no column — 08 A3.4), `role_id`, `centre_id`, `mfa_enrolled`; `sort` ∈ {`display_name`,`-last_login_at`,`created_at`}; cursor | page of `UserSummary { membership_id, display_name, email_masked, status, is_locked, roles[{role_id,code,name}], all_centres, centre_count, mfa_enrolled, last_login_at, version }` (`is_locked` = `locked_at IS NOT NULL`, wire name kept — 08 A6.1; `last_login_at` and sort `-last_login_at` = `core.memberships.last_login_at` (per tenant; `core.users.last_login_at` is internal and never returned — 08 A6.3)) | — | none |
| `searchUsers` | POST `/users/search` | `identity.user.read` | `query` (string 2–100; matches display name or email prefix), `limit` | same page | — | none |
| `inviteUser` | POST `/users` | `identity.user.manage` (privileged) | `email` (≤254), `display_name` (1–120), `phone_e164` (optional, `^\+[1-9][0-9]{7,14}$` — identical to C0 `users__phone_e164__ck`, 08 A6.2), `role_ids` (1–20 uuid), `all_centres` (bool), `centre_ids` (0–200 uuid; required non-empty when `all_centres=false`), `branch_ids` (0–50) | 201 `User` | 409 `identity.user_exists`, 422 `identity.role_unknown`, 409 `identity.centre_inactive` | **required** |
| `getUser` | GET `/users/{membership_id}` | `identity.user.read` | — | `User` (UserSummary + phone_masked, branch_ids, centre_ids, signatory { display_title, registration_no, signature_asset_id }, lock { locked_at, reason_code }, invitation { status, expires_at }) | — | none |
| `updateUser` | PATCH `/users/{membership_id}` | `identity.user.manage` | `display_name`, `phone_e164` (`^\+[1-9][0-9]{7,14}$`, as `inviteUser`; 08 A6.2), `signatory_title` (≤80), `signatory_registration_no` (≤40), `unset[]` ⊂ {phone_e164, signatory_title, signatory_registration_no}; If-Match | `User` | — | optional |
| `setUserRoles` | PUT `/users/{membership_id}/roles` | `identity.role.manage` | `role_ids` (1–20); If-Match | `User` | 422 `identity.role_unknown`, 409 `identity.last_admin_protected` | optional |
| `setUserCentreScope` | PUT `/users/{membership_id}/centre-scope` | `identity.user.manage` | `all_centres`, `centre_ids`, `branch_ids`; If-Match | `User` | 409 `identity.centre_inactive` | optional |
| `lockUser` | POST `/users/{membership_id}/lock` | `identity.user.manage` | `reason_code` (`left_organisation`\|`security_concern`\|`policy_violation`\|`other`), `reason_text` (≤500, optional); If-Match | `User` | 409 `identity.last_admin_protected`, 409 `identity.self_action_forbidden` | optional |
| `unlockUser` | POST `/users/{membership_id}/unlock` | `identity.user.manage` | If-Match | `User` | — | optional |
| `deactivateUser` | POST `/users/{membership_id}/deactivate` | `identity.user.manage` | `reason_code` (as lock), `reason_text`; If-Match | `User` | 409 `identity.last_admin_protected`, 409 `identity.self_action_forbidden` | optional |
| `reactivateUser` | POST `/users/{membership_id}/reactivate` | `identity.user.manage` | If-Match; sets `status = 'active'` and clears `deactivated_at`/`deactivated_by`/`deactivation_reason_code` (history stays in `audit.audit_log`; 08 A6.3; 03-APP-FLOW §2.2 M5); a never-accepted member goes to `status = 'invited'` (M6) and the same three columns are cleared (08 A8.2) | `User` | — | optional |
| `resendInvitation` | POST `/users/{membership_id}/resend-invitation` | `identity.user.manage` | — | 202 | 409 `common.version_conflict` (not `invited`) | optional |
| `resetUserMfa` | POST `/users/{membership_id}/reset-mfa` | `identity.user.manage` | `reason_text` (≤500); If-Match | `User` | 409 `identity.self_action_forbidden` | optional |
| `revokeUserSessions` | POST `/users/{membership_id}/revoke-sessions` | `identity.session.revoke` | — | 200 `{ revoked: integer }` | — | optional |
| `uploadUserSignature` | POST `/users/{membership_id}/signature` (multipart `file`) | `identity.user.manage` | PNG/JPEG ≤ 1 MB [CONV]; stored with `scan_state` from `ctx.uploads.accept` (P-19, §10 `identity.rescan_upload`) | `User` | 413 `common.payload_too_large`, 415 `common.unsupported_media_type`, 422 `common.upload_quarantined` (scan `infected`) | **required** |

**Hub-lab centre scope warning (08 A13 D-13(2), A17 D-63; C11 hand-off).** `inviteUser`, `setUserRoles`, `setUserCentreScope` and the role editor (`createRole` / `updateRole`) never reject on this rule; the UI (04-UI-UX AD-2, AD-3, AD-5) shows a warning `Banner` [CONV] when the selected roles grant any of `lab.specimen.receive`, `lab.result.*`, `micro.culture.read`, `micro.culture.work`, `anatomic.case.read`, `anatomic.case.work`, `anatomic.case.signout` and `all_centres = false`: "Staff who receive or work on samples from other collection centres need **All centres** or every collection centre whose samples they process. Before receipt, a sample is visible only at its collection centre."

Query plan for `listUsers` [CONV]: the `centre_id` filter and the `-last_login_at` sort run inside one tenant's memberships (tenant-sized: hundreds of rows) on `core.memberships` `UNIQUE (tenant_id, id)` and `core.membership_centres` PK `(tenant_id, membership_id, centre_id)`; no extra `core` index is requested (review C2 m#54).

### 5.4 Roles and permissions

| operationId | Method + path | Permission | Request / Response | Errors | Idem |
|---|---|---|---|---|---|
| `listPermissions` | GET `/permissions` | `identity.user.read` | `[{ code, privileged, module, phase, assignable (bool: false for platform.* and actor-only codes) }]` from `contracts/permissions.yaml` | — | none |
| `listRoles` | GET `/roles` | `identity.user.read` | filters `is_active`; `[Role { role_id, code, name, description, is_default, mfa_required, permission_codes[], member_count, is_active, version }]` | — | none |
| `createRole` | POST `/roles` | `identity.role.manage` | `code` (`^[a-z][a-z0-9_]{1,39}$`), `name` (1–80), `description` (≤500), `permission_codes` (1–200), `mfa_required` (bool) → 201 `Role` | 409 `identity.code_duplicate`, 400 validation (non-assignable code) | **required** |
| `getRole` | GET `/roles/{role_id}` | `identity.user.read` | `Role` | — | none |
| `updateRole` | PUT `/roles/{role_id}` | `identity.role.manage` | `name`, `description`, `permission_codes`, `mfa_required`; If-Match → `Role` | 409 `identity.last_admin_protected` (removing `identity.role.manage` from the last holder's only granting role) | optional |
| `deactivateRole` | POST `/roles/{role_id}/deactivate` | `identity.role.manage` | If-Match → `Role` | 409 `identity.last_admin_protected`; 409 `common.version_conflict` if `member_count > 0` | optional |

### 5.5 Branches and collection centres

| operationId | Method + path | Permission | Request fields | Errors | Idem |
|---|---|---|---|---|---|
| `listBranches` | GET `/branches` | `identity.user.read` | filters `is_active` | — | none |
| `createBranch` | POST `/branches` | `identity.centre.manage` | `code` (`^[A-Za-z0-9-]{1,16}$`, 08 §4.11 note), `name` (1–120), `address_text` (≤300), `phone` (≤30), `is_processing_lab` (bool) | 409 `identity.code_duplicate` | **required** |
| `updateBranch` | PATCH `/branches/{branch_id}` | `identity.centre.manage` | `name`, `address_text`, `phone`, `is_processing_lab`, `unset[]`; If-Match | — | optional |
| `deactivateBranch` / `reactivateBranch` | POST `/branches/{branch_id}/deactivate` \| `/reactivate` | `identity.centre.manage` | If-Match | 409 `identity.centre_inactive` (deactivating a branch that still has active centres) | optional |
| `listCentres` | GET `/centres` | `identity.centre.read` (08 A13 D-16; centre directory, P0 — used by C3 SCR-13/SCR-15 and other roles via their BFF) | filters `branch_id`, `kind`, `is_active` | — | none |
| `createCentre` | POST `/centres` | `identity.centre.manage` | `code` (`^[A-Za-z0-9-]{1,16}$`, e.g. `C000000002`; 08 §4.11 note), `name` (1–120), `branch_id` (processing branch), `kind` (`own`\|`franchise`\|`home_collection`), `address_text`, `phone` | 409 `identity.code_duplicate`, 409 `identity.centre_inactive` (inactive branch) | **required** |
| `updateCentre` | PATCH `/centres/{centre_id}` | `identity.centre.manage` | `name`, `branch_id`, `kind`, `address_text`, `phone`, `unset[]`; If-Match | — | optional |
| `deactivateCentre` / `reactivateCentre` | POST `/centres/{centre_id}/deactivate` \| `/reactivate` | `identity.centre.manage` | If-Match | — | optional |

### 5.6 Tenant settings, branding, flags, IRD status (tenant view)

| operationId | Method + path | Permission | Request / Response | Errors | Idem |
|---|---|---|---|---|---|
| `getSettings` | GET `/settings` | `identity.settings.manage` | `TenantSettingsDto` (05-SCHEMA §4.6 columns, snake_case; incl. `pending_numbering`) | — | none |
| `updateSettings` | PATCH `/settings` | `identity.settings.manage` | any subset of tenant-editable fields (05-SCHEMA §4.6 "editable by"), `unset[]`; If-Match → `TenantSettingsDto`. `timezone`: only `Asia/Kathmandu` in v1 (08 A13 P-15) | 422 `identity.setting_out_of_range` (incl. any other `timezone`, pointer `/timezone`), 400 validation (pattern errors at JSON pointer), 403 `auth.forbidden` (platform-only field) | optional |
| `uploadBrandingAsset` | POST `/settings/branding-assets` (multipart `file`, field `kind` ∈ logo, letterhead_header, letterhead_footer) | `identity.settings.manage` | PNG/JPEG ≤ 2 MB, ≤ 4000×4000 px [CONV] → 201 `BrandingAsset { asset_id, kind, width, height, sha256, scan_state }`; `scan_state` from `ctx.uploads.accept` (`clean` / `pending`; `pending` and `unavailable` are stored as `pending` and re-scanned by `identity.rescan_upload`, 08 A17 P-19) | 413, 415, 422 `common.upload_quarantined` (scan `infected`) | **required** |
| `getBrandingAssetContent` | GET `/settings/branding-assets/{asset_id}/content` | `identity.settings.manage` | core streaming download helper: image bytes, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` (REQ-SEC-085; 08 A13 P-2); access-log `branding_asset.download` (entity `branding_asset`) on every call | 422 `common.upload_quarantined` (row not `clean`) | none |
| `listFeatureFlags` | GET `/feature-flags` | `identity.settings.manage` | `[{ code, description, scope, settable_by, is_enabled, blocker_ref, approval_ref_present }]` | — | none |
| `setTenantFeatureFlag` | PUT `/feature-flags/{flag_code}` | `identity.settings.manage` | `is_enabled`; If-Match | 403 `auth.forbidden` (`settable_by = platform`) | optional |
| `listOwnIrdAnnexes` | GET `/ird-annexes` | `identity.settings.manage` | read-only list of this tenant's records + the platform Annex 1 record referenced by `tenant_settings.ird_annex_1_record_id` (visible through `ird_annex_records__select__tenant_platform_ref`, 08 A25 D-216; no other platform row); `annex_readiness` | — | none |

### 5.7 Sessions (tenant admin)

| operationId | Method + path | Permission | Notes | Idem |
|---|---|---|---|---|
| `listSessions` | GET `/sessions` | `identity.session.revoke` | filters `membership_id`, `state`; returns `SessionSummary { session_id, membership_id, display_name, state, aal, created_at, last_seen_at, idle_expires_at, absolute_expires_at, client_ip_masked, user_agent_family, is_support }` | none |
| `revokeSession` | POST `/sessions/{session_id}/revoke` | `identity.session.revoke` | 409 `identity.self_action_forbidden` for caller's own session | optional |

### 5.8 Support access (tenant side)

| operationId | Method + path | Permission | Notes | Idem |
|---|---|---|---|---|
| `listTenantSupportSessions` | GET `/support-sessions` | `audit.log.read` | filters `status`; shows platform staff display name, scope, reason, ticket_ref, times | none |
| `approveSupportSession` | POST `/support-sessions/{support_session_id}/approve` | `identity.settings.manage` | If-Match; only `requested` | optional |
| `denySupportSession` | POST `/support-sessions/{support_session_id}/deny` | `identity.settings.manage` | `reason_text` ≤500 | optional |
| `revokeSupportSession` | POST `/support-sessions/{support_session_id}/revoke` | `identity.settings.manage` | ends `approved`/`active` session; platform session's support binding cleared | optional |

### 5.9 Audit, access log, auth events, exports, access review

Column names are C0's (05-SCHEMA §3.2 mirror of C0 05-SCHEMA §10: `schema_name`, `old_values`, `new_values`, `outcome`, `purpose_code`). Query plan [CONV]: every list requires the ≤ 31-day range and runs on the PK `(tenant_id, occurred_at, id)`; `actor_id` uses `(tenant_id, actor_id, occurred_at DESC)`; `membership_id`, `centre_id`, `request_id` and `support_session_id` are filtered inside that bounded range. C0 is asked for `(tenant_id, request_id)` and partial `(tenant_id, support_session_id, occurred_at DESC) WHERE support_session_id IS NOT NULL` on both audit tables (hand-off, 08 A3.3; the filters stay).

| operationId | Method + path | Permission | Request | Response / notes | Idem |
|---|---|---|---|---|---|
| `listAuditEntries` | GET `/audit-entries` | `audit.log.read` | required `occurred_at_from`, `occurred_at_to` (span ≤ 31 days [CONV]); optional `table` (enum = allowlist of audited `schema.table`, generated from C0's audit trigger inventory), `action` (insert,update), `row_id`, `actor_id`, `membership_id`, `centre_id`, `request_id`, `support_session_id`; `sort` ∈ {`-occurred_at`, `occurred_at`} | page of `AuditEntrySummary { audit_id, occurred_at, table, action, row_id, actor { type, id, membership_id?, display_name? }, centre_id?, request_id, changed_columns[], support_session_id? }` — **no old/new values** | none |
| `getAuditEntry` | GET `/audit-entries/{audit_id}` | `audit.log.read` | — | summary + `old_values`, `new_values` (objects), `client_ip`, `user_agent`; **writes access_log `audit_entry.view` (entity `audit_entry`)** | none |
| `listAccessLogEntries` | GET `/access-log-entries` | `audit.log.read` | same date rule; `action` (code of `audit.g_cs_access_actions`), `entity_type`, `entity_id`, `actor_id`, `membership_id`, `centre_id`, `outcome` | page of `AccessLogEntry` (all 05-SCHEMA §3.2 `audit.access_log` columns incl. `outcome`, `purpose_code`) | none |
| `listAuthEvents` | GET `/auth-events` | `audit.log.read` | same date rule; `event_type`, `membership_id` | page of `AuthEvent` (email HMAC never returned) | none |
| `createAuditExport` | POST `/audit-exports` | `audit.log.export` (CR, privileged); + the caller's membership has `all_centres = true`, else `403 auth.forbidden` [CONV: the build job runs as the identity system actor, which sees every centre, so a centre-scoped requester could otherwise export rows outside its scope] | `source` (`audit_log`\|`access_log`\|`auth_events`), the list filters of that source, `format` (`csv`) | 202 `AuditExport { export_id, status, … }`; 422 `identity.export_too_large` (CR); 429 `common.rate_limited` (quota) | **required** |
| `listAuditExports` | GET `/audit-exports` | `audit.log.export`; + others' rows when the caller holds `audit.log.read` (08 A13 P-10; checked in the handler with `assertRole`) | — | own exports, plus other requesters' export metadata under the `audit.log.read` branch | none |
| `getAuditExport` | GET `/audit-exports/{export_id}` | `audit.log.export` | — | status, row_count, expires_at, downloads_remaining | none |
| `downloadAuditExport` | GET `/audit-exports/{export_id}/file` | `audit.log.export` (requester only) | — | core streaming download helper: `text/csv; charset=utf-8`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` (08 A13 P-2); access_log `audit_export.download` on every call; 404 after expiry / 3 downloads | none |
| `listAdminNotices` | GET `/notices` | `identity.user.read` | — | active notices for the caller (support requests, exports, review due, `login_ip_throttled`) — no PHI | none |
| `dismissAdminNotice` | POST `/notices/{notice_id}/dismiss` | `identity.user.read` | — | 204; adds caller to `dismissed_by` | optional |
| `listAccessReviews` | GET `/access-reviews` | `identity.user.read` | — | history | none |
| `recordAccessReview` | POST `/access-reviews` | `identity.user.manage` | `notes` (≤2000), `memberships_reviewed` (int) | 201 | **required** |

### 5.10 Platform console (bearerJwt, platform context — CR-C2-004; checked by `PlatformAuthz`, never by `IdentityPort`)

Target-tenant ids in these paths are **object identifiers**, not the acting tenant context (02-CV §6 rule is about the caller's own tenant, which a platform actor does not have).

| operationId | Method + path | Permission | Request / notes | Errors | Idem |
|---|---|---|---|---|---|
| `listTenants` | GET `/platform/tenants` | `platform.tenant.read` | filters `status`; sort `code`,`-created_at` | — | none |
| `provisionTenant` | POST `/platform/tenants` | `platform.tenant.manage` | `code` (`^[a-z][a-z0-9_]{2,31}$` = C0 `core.tenants.tenant_code` CHECK, 08 Addendum A3.3), `legal_name` (1–200), `display_name` (1–120), `pan` (optional, pattern §11), `timezone` (default and only allowed value in v1 `Asia/Kathmandu`, 08 A13 P-15; another value → `422 identity.setting_out_of_range` at `/timezone`), `calendar_display`, `first_branch { code, name, address_text }`, `first_centre { code, name, kind, address_text }`, `first_admin { email, display_name }` | 409 `identity.code_duplicate`, 422 `identity.setting_out_of_range` | **required** (key stored with `tenant_id` NULL in C0's platform idempotency store, 08 A25 D-213) |
| `getTenant` | GET `/platform/tenants/{tenant_id}` | `platform.tenant.read` | tenant, counts (users, branches, centres), status history, annex readiness | — | none |
| `updateTenant` | PATCH `/platform/tenants/{tenant_id}` | `platform.tenant.manage` | `legal_name`, `display_name`, `billing_live_on` (date; once set, fiscal number patterns change only from the next FY — 03-APP-FLOW §6.1), `unset[]`; If-Match (code immutable) | — | optional |
| `activateTenant` | POST `/platform/tenants/{tenant_id}/activate` | `platform.tenant.manage` | If-Match | 409 `identity.tenant_not_ready` (CR) | optional |
| `suspendTenant` | POST `/platform/tenants/{tenant_id}/suspend` | `platform.tenant.manage` | `reason_text` (1–500; stored in `core.tenants.status_reason`, 08 A6.3); If-Match | — | optional |
| `reactivateTenant` | POST `/platform/tenants/{tenant_id}/reactivate` | `platform.tenant.manage` | If-Match | — | optional |
| `terminateTenant` | POST `/platform/tenants/{tenant_id}/terminate` | `platform.tenant.manage` | `confirm_code` (must equal tenant code), `reason_text` (stored in `core.tenants.status_reason`, 08 A6.3); If-Match. Each membership set to `deactivated` gets `deactivated_at = now()`, `deactivated_by` = the id of the platform staff user who performed it (the human actor, claims `sub` of the platform request — never the identity system actor used inside `withTenantScope`; 08 A9.5), `deactivation_reason_code = 'other'` (08 A8.3) | — | optional |
| `getTenantSettingsAsPlatform` | GET `/platform/tenants/{tenant_id}/settings` | `platform.tenant.read` | full settings incl. platform-only fields | — | none |
| `updateTenantSettingsAsPlatform` | PATCH `/platform/tenants/{tenant_id}/settings` | `platform.tenant.manage` | any field; If-Match; `timezone` only `Asia/Kathmandu` (P-15) | 422 `identity.setting_out_of_range` (incl. `/timezone`) | optional |
| `setFeatureFlagAsPlatform` | PUT `/platform/tenants/{tenant_id}/feature-flags/{flag_code}` | `platform.tenant.manage` | `is_enabled`, `approval_ref` (≤200; required when enabling a flag with `requires_founder_approval`) | 400 validation | optional |
| `inviteTenantAdmin` | POST `/platform/tenants/{tenant_id}/admin-invitations` | `platform.tenant.manage` | `email`, `display_name` → membership with `tenant_admin` role | 409 `identity.user_exists` | **required** |
| `listPlatformIrdAnnexes` | GET `/platform/ird-annexes` | `platform.tenant.read` | filters `tenant_id` (omit = platform-level Annex 1 records), `annex_code`, `status` | — | none |
| `createPlatformIrdAnnex` | POST `/platform/ird-annexes` | `platform.tenant.manage` | Annex 1 only (platform-level): `software_version` (≤40), `notes`; writes `platform_events` `annex_1_changed` (08 A25 D-215) | — | **required** (D-213 store) |
| `updateIrdAnnex` | PATCH `/platform/ird-annexes/{record_id}` | `platform.tenant.manage` | `reference_no` (≤100), `office_name` (≤200), `counterparty_name` (≤200, Annex 7 DC operator), `software_version`, `notes` (≤2000), `unset[]`; If-Match | — | optional |
| `transitionIrdAnnex` | POST `/platform/ird-annexes/{record_id}/transition` | `platform.tenant.manage` | `to_status`, `submitted_on`/`completed_on` (dates), `reference_no`, `note` (≤1000); If-Match. `to_status = superseded` (IR7) creates the successor record of the same annex and tenant (`status = 'not_started'`, `supersedes_id` = this record) in the same transaction and returns it [CONV]; an Annex 1 change also writes `platform_events` `annex_1_changed` (D-215) | 409 `identity.annex_invalid_transition` (CR) | optional |
| `uploadIrdAnnexDocument` | POST `/platform/ird-annexes/{record_id}/documents` (multipart) | `platform.tenant.manage` | PDF/PNG/JPEG ≤ 15 MB (02-CV §10.2); row stores `scan_state` from `ctx.uploads.accept` (P-19; re-scan see `downloadIrdAnnexDocument`) | 413, 415, 422 `common.upload_quarantined` (scan `infected`) | **required** (D-213 store) |
| `downloadIrdAnnexDocument` | GET `/platform/ird-annexes/{record_id}/documents/{document_id}/content` | `platform.tenant.read` | core streaming download helper: `Content-Disposition: attachment`, `nosniff`, `Cache-Control: no-store` (P-2). A row with `scan_state = 'pending'` is re-scanned here with `ctx.files.scan(await ctx.storage.read(…))` and updated under the `__platform` UPDATE policy [CONV: worker jobs have no platform claims and this operation is not on the R10.4 `withTenantScope` list, so the P-19 re-scan job cannot update these rows]; still not `clean` → `422 common.upload_quarantined`. Every call writes `platform_events` `ird_document_downloaded` [CONV] (the tenant access-log code `ird_document.download` needs tenant claims that this platform operation does not have) | 422 `common.upload_quarantined` | none |
| `openSupportSession` | POST `/platform/support-sessions` | `platform.support_session.open` | `tenant_id`, `scope` (`read_only`\|`admin`; `admin` only for `platform_superadmin`), `reason_text` (10–500), `ticket_ref` (1–60), `duration_minutes` (5–60 [CONV]); `admin` scope needs tenant `provisioning` or `active`. Access-log `support_session.open` and the tenant notices are written under `ctx.db.withTenantScope` (08 R10 item 4 as extended by 08 A25 D-214) | 403 `auth.forbidden` (`admin` scope by `platform_support`), 403 `identity.tenant_suspended` (`admin` scope on a suspended tenant) | **required** (D-213 store) |
| `activateSupportSession` | POST `/platform/support-sessions/{support_session_id}/activate` | `platform.support_session.open` | binds to caller's current platform session; If-Match; access-log `support_session.activate` via `withTenantScope` (D-214) | 409 `common.version_conflict` (not approved) | optional |
| `endSupportSession` | POST `/platform/support-sessions/{support_session_id}/end` | `platform.support_session.open` | access-log `support_session.close` via `withTenantScope` (D-214) | — | optional |
| `listPlatformSupportSessions` | GET `/platform/support-sessions` | `platform.tenant.read` | filters `tenant_id`, `status`, `platform_staff_id` | — | none |
| `listDeadLetters` | GET `/platform/dead-letters` | `platform.dead_letter.manage` | filters `state`, `platform_rows` (boolean, default `false`; `true` → only platform-task rows with `tenant_id IS NULL`, 08 A10.2), `tenant_id`, `task_identifier`, `dead_at_from` (inclusive) / `dead_at_to` (exclusive), plus `cursor`, `limit` (02-CV §4.3–§4.4); passed 1:1 to `ctx.core.deadLetters.list({ state, platformRows, tenantId, taskIdentifier, deadAtFrom, deadAtTo, cursor, limit })` (08 A9.2, A10.2) → `Page<DeadLetterRow>` (C0 02-TRD §6.8): each item incl. `version` (for If-Match) and `resolution_note`, never `job_payload` (08 A8.5) | 400 `common.validation_failed` when `platform_rows=true` and `tenant_id` is present (08 A10.2) | none |
| `getDeadLetter` | GET `/platform/dead-letters/{dead_letter_id}` | `platform.dead_letter.manage` | via `ctx.core.deadLetters.get({ deadLetterId })` (08 A9.1) → `DeadLetterRow` (C0 02-TRD §6.8) incl. `version` (ETag / If-Match source) and `resolution_note`; `job_payload` is never returned (08 A8.5); logged access: access-log `dead_letter.view` in the row's tenant via `withTenantScope` (D-214), or `platform_events` `dead_letter_viewed` for a NULL-tenant row | 404 `common.not_found` (thrown by `ctx.core.deadLetters.get`, 08 A9.1) | none |
| `replayDeadLetter` | POST `/platform/dead-letters/{dead_letter_id}/replay` | `platform.dead_letter.manage` | If-Match, passed as `expectedVersion` to `ctx.core.deadLetters.replay({ deadLetterId, expectedVersion, reasonText? })` (C0 02-TRD §6.8, 08 A6.4); optional body `reason_text` (1–500; 0 or 501 chars → 400 `common.validation_failed`), passed as `reasonText` and stored in `core.dead_letters.resolution_note` (08 A9.3) | 409 `common.version_conflict` (not `open`, or If-Match ≠ row `version` — 08 A6.4) | optional |
| `discardDeadLetter` | POST `/platform/dead-letters/{dead_letter_id}/discard` | `platform.dead_letter.manage` | `reason_text` (1–500), passed as `reasonText` to `ctx.core.deadLetters.discard({ deadLetterId, expectedVersion, reasonText })` and stored in `core.dead_letters.resolution_note` (08 A8.4); If-Match, passed as `expectedVersion` (08 A6.4) | same | optional |
| `listPlatformStaff` | GET `/platform/staff` | `platform.staff.manage` (CR) | — | — | none |
| `invitePlatformStaff` | POST `/platform/staff` | `platform.staff.manage` | `email`, `display_name`, `role_code` (`platform_superadmin`\|`platform_support`), `allowed_cidrs` (0–20 CIDR strings); writes `platform_events` `platform_staff_invited` (the NULL-tenant invitation gets no `audit_log` row, 08 A25 D-215) | 409 `identity.user_exists` | **required** (D-213 store) |
| `updatePlatformStaff` | PATCH `/platform/staff/{platform_staff_id}` | `platform.staff.manage` | `display_name`, `role_code`, `allowed_cidrs`; If-Match | 409 `identity.last_admin_protected` (last active superadmin) | optional |
| `deactivatePlatformStaff` | POST `/platform/staff/{platform_staff_id}/deactivate` | `platform.staff.manage` | If-Match | same; 409 `identity.self_action_forbidden` | optional |
| `resetPlatformStaffMfa` | POST `/platform/staff/{platform_staff_id}/reset-mfa` | `platform.staff.manage` | — | 409 `identity.self_action_forbidden` | optional |
| `listPlatformSessions` | GET `/platform/sessions` | `platform.staff.manage` | platform-kind sessions | — | none |
| `revokePlatformSession` | POST `/platform/sessions/{session_id}/revoke` | `platform.staff.manage` | — | 409 `identity.self_action_forbidden` | none |
| `listPlatformAuthEvents` | GET `/platform/auth-events` | `platform.tenant.read` | date rule as §5.9; `tenant_id` (optional), `event_type`; includes tenant-less events | — | none |

Note on `openSupportSession` for suspended tenants: allowed with `scope = read_only` only (diagnosis); `admin` → `403 identity.tenant_suspended`.

## 6. Claims resolution (CR-C2-005)

### 6.1 Extension point

```ts
// services/api/src/modules/identity/claims/resolver.ts  (registered via manifest.claimsResolver; only module 'identity' may register — CR-C2-005)
export interface VerifiedJwt { readonly sub: Uuid; readonly sessionId: Uuid; readonly aal: 'aal1' | 'aal2'; readonly exp: number; readonly iat: number }
export type ResolvedClaims =
  | { readonly kind: 'tenant'; readonly claimsJson: string; readonly tenantId: Uuidv7; readonly actor: Actor; readonly sessionState: SessionStateCode }   // session kind tenant_staff (staff_mobile has its own variant below)
  | { readonly kind: 'platform'; readonly claimsJson: string; readonly actor: Actor; readonly platformRole: 'platform_superadmin' | 'platform_support' }
  | { readonly kind: 'partner'; readonly claimsJson: string; readonly tenantId: Uuidv7; readonly actor: Actor; readonly sessionState: SessionStateCode }   // 08 R10
  | { readonly kind: 'patient'; readonly claimsJson: string; readonly tenantId: Uuidv7; readonly actor: Actor }                                          // 08 R10
  | { readonly kind: 'staff_mobile'; readonly claimsJson: string; readonly tenantId: Uuidv7; readonly actor: Actor; readonly sessionState: SessionStateCode }   // 08 R10
  | { readonly kind: 'rejected'; readonly code: 'auth.unauthenticated' | 'auth.session_expired' | 'auth.account_locked' | 'identity.tenant_suspended' | 'identity.membership_inactive' | 'identity.platform_ip_denied' };
export interface ClaimsResolver { resolve(jwt: VerifiedJwt, request: { clientIp: string; requestId: Uuidv7; endpointFamily: 'staff' | 'partner' | 'patient' | 'mobile' | 'api'; bffKey?: 'staff_web' | 'partner' | 'portal' }): Promise<ResolvedClaims> }
// bffKey 'portal' (08 R10 table as amended by A13 D-32) is never accepted on /v1/identity/*: such a request → 401 auth.unauthenticated.
// The resolver is the sole claims source for every GoTrue JWT in every environment (CR-C2-005 as modified; 08 R10). A JWT without session_id is rejected by C0 core (401 auth.token_invalid).
```

### 6.2 Algorithm (one DB round trip, p95 ≤ 3 ms [CONV])

1. Call `app.identity_resolve_session(p_gotrue_session_id => jwt.sessionId, p_sub => jwt.sub)` (SECURITY DEFINER, C0-inventoried; SQL in 05-SCHEMA §6) — it reads `identity.sessions` + `core.memberships` + `core.tenants` + `identity.platform_staff` + `identity.support_sessions` without tenant context and returns one row.
2. Reject (`kind: 'rejected'`) if: no row → `auth.unauthenticated`; `revoked_at` set or `now() ≥ idle_expires_at` or `now() ≥ absolute_expires_at` → `auth.session_expired`; tenant status ∈ {suspended, offboarded} (C0 `core.tenants.status` values, 08 Addendum A3.3) and not a support session → `identity.tenant_suspended`; membership `locked_at IS NOT NULL` (DEFINER output `membership_locked`, 08 A3.4) → `auth.account_locked`; membership status ≠ active → `identity.membership_inactive`; platform session and client IP ∉ `allowed_cidrs` (when non-empty) → `identity.platform_ip_denied`.
3. Build claims JSON (snake_case):
   - tenant staff: `{ "sub", "tenant_id", "membership_id", "actor_type": "user", "aal", "lims_session_id", "session_state" }`
   - platform without support: `{ "sub", "actor_type": "user", "scope": "platform", "platform_staff_id", "platform_role", "aal", "lims_session_id" }` — **no `tenant_id`** → every tenant policy evaluates false (02-CV §5.8 fail-closed); platform tables use `app.is_platform_actor()` (CR-C2-004).
   - platform with active support session: `{ "sub", "tenant_id": <target>, "actor_type": "user", "scope": "support", "support_session_id", "support_scope", "platform_staff_id", "aal", "lims_session_id" }` — no `membership_id` → `app.has_all_centres()` = false, `app.current_centre_ids()` = `{}` (fail-closed for centre-scoped tables, 02-CV §5.8).
   - partner: `{ "sub", "tenant_id", "membership_id", "actor_type": "partner", "partner_role", "aal", "lims_session_id", "session_state" }` (`partner_role` from the DEFINER output, 08 A28.3); patient: `{ "sub", "tenant_id", "membership_id", "actor_type": "patient", "aal": "aal1", "lims_session_id", "session_state": "active" }`; staff_mobile: as tenant staff (08 R10). Non-staff actors never get centre scope (`app.has_all_centres()` false, `memberships__all_centres_user_only__ck`, 08 R3) and are excluded from `__tenant` policies by `app.is_staff_or_system()` unless a table has an actor-specific policy.
   - Kind check on the identity endpoint families: the session's `kind` must match the BFF key or endpoint family of the request (`tenant_staff`/`platform` ↔ staff_web key; `partner` ↔ partner key; `patient` ↔ `/v1/identity/auth/patient/*`; `staff_mobile` ↔ `/v1/identity/mobile/*`); mismatch → `rejected` `auth.session_expired`. On module API calls (`endpointFamily: 'api'`) the kind determines only the claims shape / `actor_type`.
4. `aal` comes from the verified JWT (not from DB); if DB `sessions.aal = 'aal2'` and JWT says `aal1`, use `aal1` (lowest wins).
5. Per-request memo: the result is attached to the request; `IdentityPort` reuses it.

## 7. `IdentityPort` implementation (03 §4.6 — signatures verbatim)

```ts
// services/api/src/modules/identity/ports/IdentityPort.impl.ts
import type { IdentityPort, ActorProfile, TenantSettings, TenantSettingKey, PermissionCode } from '@lims/contracts/ports/IdentityPort';
import type { RequestContext, Uuidv7 } from '@lims/contracts/ports/common';
export const identityPortImpl: IdentityPort = {
  getActor(ctx: RequestContext): Promise<ActorProfile>,
  assertRole(ctx: RequestContext, requirement: { permission: PermissionCode; centreId?: Uuidv7; branchId?: Uuidv7 }): Promise<void>,
  getTenantSettings<K extends TenantSettingKey>(ctx: RequestContext, input?: { keys?: readonly K[] }): Promise<Pick<TenantSettings, K>>,
  // added by 08 §4.14 (CR-C6-007, CR-C13-003, CR-C16-004) — signatures verbatim from 03 §4.6
  getSignatories(ctx, input: { membershipIds: readonly Uuidv7[] }): Promise<readonly Signatory[]>,          // system actor holding identity.signatory.read; ≤ 20 ids; unknown/other tenant omitted; inactive still returned
  readBrandingAsset(ctx, input: { assetId: Uuidv7 }): Promise<BrandingAssetContent>,                      // any `user` or `system` actor of the tenant (08 A13 D-26); only branding_assets.kind IN ('logo','letterhead_header','letterhead_footer'); a signature asset id → common.not_found (D-26, A14.1); row not `clean` → common.upload_quarantined (P-19); ≤ 2 MB base64; assets referenced by released reports never deleted; common.not_found
  provisionPartnerMembership(ctx, input: { email: string; displayName: string; partnerRole: PartnerRole }):
    Promise<{ membershipId: Uuidv7; userId: Uuid; invitationId: Uuidv7; status: 'invited' }>,              // C13 service with partners.partner.manage (staff) or partners.partner_user.manage (partner admin of same partner — allowed for partner actors, 08 A22.2); identity.user_exists, identity.tenant_suspended
  /** Omitted expectedVersion → C2 applies the action to the current row under SELECT … FOR UPDATE.
   *  Present → common.version_conflict on mismatch. (08 A19 D-100) */
  updatePartnerMembership(ctx, input: { membershipId: Uuidv7; action: 'deactivate' | 'reactivate' | 'set_role' | 'resend_invitation';
    partnerRole?: PartnerRole; reasonCode?: Code; expectedVersion?: number }):
    Promise<{ membershipId: Uuidv7; status: 'invited' | 'active' | 'deactivated'; version: number }>,     // revokes sessions on deactivate/role change; non-partner membership → common.not_found; allowed for partner-admin actors (08 A22.2)
  provisionPatientMembership(ctx, input: { accountId: Uuidv7 }): Promise<{ membershipId: Uuidv7; userId: Uuid }>,   // patient pre_auth context only; idempotent per accountId; account id = C16 OTP challenge id (CR-C16-004 note: C16 passes the id of the verified challenge, so a retried verify maps to the same membership); no phone/e-mail in GoTrue
  openPatientSession(ctx, input: { membershipId: Uuidv7; appInstanceId: Uuidv7; appPlatform: 'android' | 'ios' }):
    Promise<{ sessionToken: string; accessToken: string; accessExpiresAt: IsoUtc; sessionExpiresAt: IsoUtc }>,   // same caller restriction; membership actor_type 'patient' and active; opaque session token (08 R10); BLOCKED until C2 T1 confirms the GoTrue paths (§8, 08 A25 D-218)
  // 08 A28.2: provisionPatientMembership, openPatientSession and revokePatientSessions run their identity/core writes inside
  //           ctx.db.withTenantScope(ctx.tenantId, <identity system actor>) (R10 item-4 allowlist); the patient actor never writes identity tables
  revokePatientSessions(ctx, input: { membershipId: Uuidv7; reason: Code; deactivateMembership: boolean }): Promise<{ revokedSessions: number }>,   // the patient themself or the engagement system actor
  // added by 08 A4.2 (CR-C6-018, additive)
  /** Caller: system actors only (reporting worker), else auth.forbidden. eligible = status = 'active' AND actor_type = 'user'
   *  AND locked_at IS NULL AND the membership holds requiredPermission (through an active role). email = core.users.email_normalized. */
  getStaffNotificationContact(ctx, input: { membershipId: Uuidv7; requiredPermission: PermissionCode }):
    Promise<{ membershipId: Uuidv7; email: string | null; eligible: boolean }>,
  // added by 08 A21.2 (CR-C6-020, additive)
  /** Caller: system actor holding identity.signatory.read (C6 render worker), else auth.forbidden. Returns the membership's
   *  active signature image (branding_assets kind 'signature', scan_state 'clean'). No such image, or another tenant → common.not_found. */
  readSignatureImage(ctx, input: { membershipId: Uuidv7 }): Promise<SignatureImageContent>,   // 08 A26.1
};
```
`SignatureImageContent { membershipId: Uuidv7; contentBase64: string; mimeType: 'image/png' | 'image/jpeg'; sha256: string }` (08 A26.1; 03-IC §4.6) — not `BrandingAssetContent`.

**Contract cases** (`packages/fakes/contract-tests/IdentityPort.contract.ts`): 03-IC §4.6 cases (1)–(12) verbatim (incl. A4.2 (11)–(12) for `getStaffNotificationContact`), plus C2 cases (renumbered from the former (11)–(15) so they no longer collide with IC (11)–(12)):
- **C2-1** support-session actor limited to the allowlist (§7.4); **C2-2** session revoked mid-request-chain → next request `auth.session_expired`; **C2-3** settings change visible within the cache TTL; **C2-4** system actor holds exactly its worker-manifest permissions (CR-C2-013); **C2-5** `getTenantSettings` never returns another tenant's values;
- **C2-6** (08 A19 D-100) `updatePartnerMembership` without `expectedVersion` succeeds; with a stale version → `common.version_conflict`;
- **C2-7** (D-26) `readBrandingAsset` by a `user` actor of the tenant (e.g. C4 invoice letterhead) → content; **C2-8** `readBrandingAsset` with a signature asset id → `common.not_found`;
- **C2-9** (A21.2, A26.1) `readSignatureImage` by a system actor holding `identity.signatory.read` → `SignatureImageContent` of the signature image; by a `user` actor or a system actor without the permission → `auth.forbidden`; membership without signature or of another tenant → `common.not_found`;
- **C2-10** (08 A19 D-119) `getTenantSettings` by a `patient`, `portal` or `partner` actor with `keys` ⊆ {`timezone`, `calendarDisplay`} → those keys; without `keys`, or with any other key → `auth.forbidden`.

Migration-actor semantics (CR-C18-007): DEFER (B4).

**`TenantSettings` (final shape 08 §4.12, CR-C2-008 primary; CR-C0-009, C4-009, C5-009, C11-005 merged).** Mapping from `identity.tenant_settings` (05-SCHEMA §4.6):

| `TenantSettings` field | Column(s) |
|---|---|
| unchanged keys (`calendarDisplay`, `timezone`, `idleTimeoutMinutes`, `absoluteSessionHours`, `reportLinkTtlDays`, `releaseRequiresPayment`, `partialReleaseAllowed`, `letterheadDefault`, `channels`, `referralIncentiveReportEnabled`, `autoVerificationEnabled`, `westgardMode`) | as before (05-SCHEMA §4.6) |
| `numbering.{registrationNoPattern, barcodePattern, patientCodePattern, invoiceNoPattern, creditNoteNoPattern, receiptNoPattern}` | `*_pattern` columns. `registrationNoPattern`: C4 grammar applied by C2 — must contain `{branch}` (08 A13 D-23(1)); invoice `{branch}` vs `invoice_series_scope` is checked by C4 (D-23(2)–(3)). `barcodePattern` default `{prefix}{yy}{seq:8}` (08 A13 D-8) |
| `numbering.barcodePrefix` (`[A-Z0-9]{0,4}`, CR-C5-009) | `barcode_prefix` |
| `numbering.accessionNoPattern` (default `{prefix}{yy}-{seq:4}`), `numbering.accessionPrefixes{histology,cytology,ihc,molecular}` (`[A-Z0-9]{0,4}`; defaults S/C/I/M; C2 validates with C11's grammar — CR-C11-005) | `accession_no_pattern`, `accession_prefix_histology|_cytology|_ihc|_molecular` |
| `branding.legalName`, `branding.displayName` | `legal_name_snapshot`, `display_name` |
| `branding.addressLines` (≤ 4 × ≤ 120) | `address_lines text[]` |
| `branding.phones` (≤ 3 × ≤ 40) | `phones text[]` |
| `branding.contactEmail`, `branding.website` | `contact_email`, `website` |
| `branding.logoAssetId`, `letterheadHeaderAssetId`, `letterheadFooterAssetId` (asset ids, read via `readBrandingAsset`; 08 R21) | `logo_asset_id`, `letterhead_header_asset_id`, `letterhead_footer_asset_id` |
| `branding.receiptFooterNote` (≤ 200) | `receipt_footer_note` |
| `branding.accentColor` (`#RRGGBB`; CR-C0-009) | `accent_color` |
| `retentionYears` (= `retention.clinicalYears`), `retention.{clinicalYears, auditYears, rawInstrumentYears}` (floors 5/5/1) | `retention_*_years` |
| `featureFlags` (codes of `identity.g_feature_flags`, incl. `smart_report` — CR-C14-005) | `identity.feature_flags` rows over registry defaults |
| `ird.{pan, cbmsRealtimeRequired, abbreviatedInvoiceLimitPaisa, annexReadiness}` | `ird_pan`, `cbms_realtime_required`, `abbreviated_invoice_limit_paisa`, computed readiness |

There is no separate `letterhead` key (CR-C4-009 merged into `branding`). C2 validates every field on write (`identity.setting_out_of_range`; pattern grammar errors at JSON pointer); the fake returns defaults.

### 7.1 `getActor(ctx)`
1. If memo for `ctx.requestId` exists → return it.
2. By `ctx.actor.type`:
   - `user` + `membershipId`: one query in `ctx.tx` joining `core.memberships`, `core.users`, `core.membership_roles` → `core.role_permissions`, `core.membership_centres`, `core.membership_branches`, `identity.mfa_factors` (any verified) → `ActorProfile`. `permissions` = union of active roles' codes. `mfa.level` = claims `aal`. `isLocked` (IC §4.6 field; wire name kept, no rename — 08 A6.1) = membership `locked_at IS NOT NULL` (08 A3.4). `signature` from the C0 membership columns `signatory_display_title`, `signatory_registration_no` and `signature_image_ref` (= storage object path, returned as `signatureImageRef`; 05-SCHEMA §3.1 mirror, 08 Addendum A3.3).
   - `user` + support session (no membership): roles `[]`, permissions = support allowlist for `support_scope` (§7.4), `centreScope { all: false, centreIds: [] }`, `branchIds []`, `displayName` = platform staff display name + " (the LIMS provider support)".
   - `partner`: permissions = `fixed_actor_permissions.partner[<partner role>]` (`partner_member` / `partner_admin`; `partner_member` includes `identity.self.manage`, 08 A19 D-101), `centreScope { all:false, centreIds:[] }`, roles `[<partner role>]`, `branchIds []` (08 §4.14). Built from the fixed sets with no further core read. **Source of `<partner role>` (08 A28.3):** `core.memberships.partner_role` (C0 column; present iff `actor_type = 'partner'`), written by C2 in `provisionPartnerMembership` / `updatePartnerMembership(set_role)`. Partner claims cannot read `core.memberships` (P-16 guard), so `app.identity_resolve_session` returns `partner_role` and the resolver puts it into the partner claims (`partner_role`) [CONV]; `getActor` takes it from the claims. C2 never reads C13's `partners.partner_users`.
   - `patient`: the fixed `patient` set; `pre_auth` stage (claims `patient_stage = 'pre_auth'`, no membership) → the `patient_pre_auth` set; `centreScope { all:false, centreIds:[] }`.
   - `device`: by claims `device_kind` — absent/`bridge_agent` → `fixed_actor_permissions.device.bridge_agent`; `queue_display` → `[engagement.queue.board_read]`; `centreScope { all:false, centreIds:[claims.centre_id] }`.
   - `portal`: fixed `portal` set; no centre scope. displayName = actor type label for all of these.
   - `branchIds` for `user` = the member's explicit `core.membership_branches` rows only; `centreScope.all = true` implies all branches (08 R3). Branch scope is application-level only (no RLS).
   - `system`: permissions = the worker-manifest declaration for that system actor id (CR-C2-013); `centreScope.all = true`.
3. Locked → throw `auth.account_locked`; unauthenticated context → `auth.unauthenticated`.

### 7.2 `assertRole(ctx, req)`
1. `req.permission` not in the generated permission registry → `LimsError('common.validation_failed')` (contract case 10).
2. `profile = getActor(ctx)`; session state (from resolved claims) `mfa_pending` → `auth.mfa_required`; `mfa_enrolment_required` → `identity.mfa_enrolment_required`; `password_setup` → `auth.forbidden`.
3. `platform.*` permission → `auth.forbidden` (platform permissions are checked by `PlatformAuthz` in platform context only).
4. Platform actor without support session hitting a tenant handler → `identity.support_session_required`.
5. Permission ∉ `profile.permissions` → `auth.forbidden`.
6. `centreId` given and not (`centreScope.all` or `centreIds` includes it) → `auth.forbidden`. `branchId` given and not (`centreScope.all` or `branchIds` includes it) → `auth.forbidden`.
7. Registry `privileged: true` → (a) re-read membership + role grants **without memo** in `ctx.tx` (`SELECT … FROM core.memberships WHERE tenant_id=$1 AND id=$2`) and repeat 5–6 on fresh data (contract case 6); (b) require claims `aal = 'aal2'` else `auth.mfa_required` (04 A4); (c) support session: still active (`expires_at > now()`) else `identity.support_session_required`.
8. Resolve; increment `lims_identity_authz_decisions_total{outcome}` (no ids in labels).

### 7.3 `getTenantSettings(ctx, {keys})`
- Process cache `Map<tenantId, {value: TenantSettings, version, loadedAt}>`, TTL 30 s [CONV]; same-process writes invalidate immediately. Miss → one query on `identity.tenant_settings` + `identity.feature_flags` + Annex readiness (`identity.ird_annex_records`: the tenant's rows and the referenced platform Annex 1 row, visible through `ird_annex_records__select__tenant_platform_ref`, 08 A25 D-216) in `ctx.tx`.
- Field mapping (snake → camel) in 05-SCHEMA §4.6. Values always within 04 ranges (validated on write).
- `keys` given → return only those keys (contract case 9). Unknown key → `common.validation_failed`.
- Actor types `patient`, `portal`, `partner` (08 A19 D-119; 02-CV §8.5 item 1): `keys` must be given and ⊆ {`timezone`, `calendarDisplay`}, else `auth.forbidden` (contract case C2-10). The partner-admin port writes `provisionPartnerMembership` / `updatePartnerMembership` stay allowed for partner actors (08 A22.2).
- Defaults when a row is missing (should not happen after provisioning; contract case 8): `calendarDisplay 'AD'`, `timezone 'Asia/Kathmandu'`, `idleTimeoutMinutes 15`, `absoluteSessionHours 12`, `reportLinkTtlDays 30`, `retentionYears 5`.

### 7.4 Support permission allowlist [DECISION]
- `read_only`: `identity.user.read`, `identity.centre.read` [CONV: keeps the centre directory readable for support after `listCentres` moved to it, 08 A13 D-16; a P0 read, no new data exposure], `audit.log.read`.
- `admin`: `read_only` + `identity.user.manage`, `identity.role.manage`, `identity.centre.manage`, `identity.settings.manage`, `identity.session.revoke`.
- Never: `audit.log.export`, any permission of another module (no clinical, billing or patient data via support), any `platform.*`.
Rationale: the LIMS provider staff need configuration access to support onboarding; PHI access by the vendor is not needed for that and would be an s.12(4)/s.26(1) exposure (04 L17). A broader allowlist needs a CR with founder approval.

## 8. `GoTrueGateway` (adapter; endpoint mapping UNVERIFIED until T1)

```ts
// services/api/src/modules/identity/gotrue/gateway.ts
export interface GoTrueTokens { accessToken: string; refreshToken: string; expiresAt: number /* epoch s */; sessionId: Uuid; userId: Uuid; aal: 'aal1' | 'aal2' }
export interface GoTrueGateway {
  signInWithPassword(email: string, password: string): Promise<{ ok: true; tokens: GoTrueTokens } | { ok: false }>;
  refresh(refreshToken: string): Promise<{ ok: true; tokens: GoTrueTokens } | { ok: false; reason: 'revoked' | 'reused' | 'invalid' }>;
  signOut(accessToken: string, scope: 'local' | 'global'): Promise<void>;
  adminCreateUser(input: { email: string; emailConfirm: boolean }): Promise<{ userId: Uuid } | { exists: true; userId: Uuid }>;
  adminUpdatePassword(userId: Uuid, password: string): Promise<void>;
  adminSignOutUser(userId: Uuid): Promise<void>;                     // all sessions
  adminFindUserByEmail(email: string): Promise<{ userId: Uuid } | null>;  // used only inside worker jobs (no timing oracle on HTTP path)
  adminDeleteFactor(userId: Uuid, factorId: Uuid): Promise<void>;
  sendInvite(email: string, redirectPath: '/auth/confirm'): Promise<void>;
  sendRecovery(email: string, redirectPath: '/auth/confirm'): Promise<void>;
  verifyEmailToken(tokenHash: string, type: 'invite' | 'recovery'): Promise<{ ok: true; tokens: GoTrueTokens } | { ok: false }>;
  mfaEnrollTotp(accessToken: string, friendlyName?: string): Promise<{ factorId: Uuid; otpauthUri: string; secret: string; qrSvg?: string }>;
  mfaChallengeAndVerify(accessToken: string, factorId: Uuid, code: string): Promise<{ ok: true; tokens: GoTrueTokens } | { ok: false }>;
  mfaListFactors(accessToken: string): Promise<readonly { factorId: Uuid; type: 'totp'; status: 'verified' | 'unverified'; friendlyName?: string }[]>;
}
```

| Item | Status |
|---|---|
| `aal` claim with values `aal1`/`aal2`; absent = aal1 | **UNVERIFIED for the pinned version** — proven by C0 SP-1 / C2 T1 (08 R10.6); hosted docs (supabase.com/docs/guides/auth/auth-mfa, fetched 2026-11-05; not a research/04 source) say so |
| `session_id`, `aal`, `sub`, `exp`, `iat`, `role` required claims | **UNVERIFIED for the pinned version** — proven by C0 SP-1 / C2 T1 (08 R10.6); hosted custom-access-token-hook docs (fetched 2026-11-05) list them |
| GoTrue recovery/invite link TTL configurable to ≤ 60 min (04 A12) | **UNVERIFIED — T1 verification and release precondition** (08 A25 D-219, A25.2). There is no LIMS-side fallback (the earlier `recovery_issued_at` fallback had no storage and is deleted). If T1 refutes it, a CR adds `identity.recovery_requests` (class E) before release |
| Patient session kind (08 A25 D-218): (a) `adminCreateUser` without an e-mail (credential-less user for `provisionPatientMembership`); (b) an admin path that issues a GoTrue session / access JWT with `session_id` for a credential-less user (`openPatientSession`, patient refresh) | **UNVERIFIED — T1 items.** Default: **the patient session kind is blocked until T1 confirms both**; C16 builds against the fake resolver meanwhile (as R10 item 6 does for SP-1). If T1 refutes both, a CR to 08 R10 for a LIMS-issued patient access JWT goes to the lead and founder (touches 04 A5/A7). No gateway method is added for (a)/(b) until T1 names the real paths |
| HTTP paths, request/response field names, admin auth header, invite/recovery link template variables (`token_hash`), email OTP TTL env var, refresh-reuse env var, min-password env var, for the **pinned self-hosted version** | **UNVERIFIED** — T1 reads the pinned GoTrue source/docs and writes `gotrue/mapping.md` + contract tests against the real container; any gap becomes a CR to C1 (config) or a redesign note here |
| GoTrue admin operations require the service-role key | UNVERIFIED for pinned version (expected); key confined to `gotrue/gateway.http.ts` (CR-C2-014, REQ-SEC-029/030) |
| WebAuthn factors | UNVERIFIED (not listed on the MFA page) → not used |

Timeouts: 3 s per GoTrue call [CONV]; no retries inside request handlers except `refresh` (1 retry after 200 ms on network error only). Circuit: 5 consecutive failures → 30 s open → `503 common.dependency_unavailable` [CONV].

## 9. Events and ports

| Kind | C2 |
|---|---|
| Events produced | **none** (03 §3.25). Settings changes propagate by cache TTL (§7.3). |
| Events consumed | **none**. Worker manifest `subscriptions: {}`. |
| Ports implemented | `IdentityPort` (§7): the three base methods plus the nine added methods (seven by 08 §4.14, `getStaffNotificationContact` by 08 A4.2, `readSignatureImage` by 08 A21.2). |
| Ports consumed | **none**. |
| C0 core APIs consumed | `ctx.db.tx`; `ctx.db.identityAuthTx` + `tx.bindTenant` (§5 pre-auth paragraph; 08 A25 D-212); `ctx.commitOnError()` (P-42); `ctx.clientIp` (P-61); `ctx.core.*` (read helpers); `ctx.audit.access(...)`; rate limits through C0's `ctx.rateLimit.consume()` with C0's `login`-tier keys `a:<account>` (account = `email_hmac`) and, for failures only, `f:<client_ip>` (C0 02-TRD §6.7; a C0 CR for a non-consuming `peek(key)` is raised only if T6 shows that step-up/backoff cannot be built from `consume()` results); storage adapter + upload pipeline (CR-C2-011) and `ctx.files.scan` (P-19); job enqueue (`app.enqueue_job` via core); platform context + `withTenantScope` (CR-C2-004; only for the operationIds of 08 R10 item 4 as extended by 08 A25 D-214); platform idempotency store with `tenant_id` NULL (D-213); claims-resolver registration (CR-C2-005). |

**Access-log calls (08 A13 P-3).** Every `ctx.audit.access({action, entityType, entityId?, outcome, detail?})` call C2 makes (C0 02-TRD §6.9; codes of 08 §4.4, CR-C2-010 as modified; every code is in the C0 seed `audit.g_cs_access_actions`):

| Operation (or job) | `action` | `entityType` |
|---|---|---|
| `getAuditEntry` | `audit_entry.view` | `audit_entry` |
| `getDeadLetter` (tenant row, via `withTenantScope`, D-214) | `dead_letter.view` | `dead_letter` |
| `createAuditExport` | `data.export` | `audit_export` |
| `downloadAuditExport` | `audit_export.download` | `audit_export` |
| `getBrandingAssetContent` | `branding_asset.download` | `branding_asset` |
| `setUserRoles`, `createRole`, `updateRole`, `deactivateRole` | `role.change` | `role` (role editor) / `membership` (`setUserRoles`) |
| `revokeSession`, `revokeUserSessions`, `revokeOwnSession` | `session.revoke` | `session` |
| `openSupportSession` (via `withTenantScope`) | `support_session.open` | `support_session` |
| `approveSupportSession` | `support_session.approve` | `support_session` |
| `denySupportSession` | `support_session.deny` | `support_session` |
| `activateSupportSession` (via `withTenantScope`) | `support_session.activate` | `support_session` |
| `endSupportSession` (via `withTenantScope`) | `support_session.close` | `support_session` |
| `revokeSupportSession` | `support_session.revoke` | `support_session` |
| `provisionTenant`, `activateTenant`, `suspendTenant`, `reactivateTenant`, `terminateTenant`, `inviteTenantAdmin` (via `withTenantScope`) | `tenant.lifecycle_change` | `tenant` |
| `updateSettings`, `updateTenantSettingsAsPlatform` (via `withTenantScope`) | `settings.change` | `tenant_settings` |
| `setTenantFeatureFlag`, `setFeatureFlagAsPlatform` (via `withTenantScope`) | `feature_flag.change` | `feature_flag` |

`ird_document.download` stays registered but is not written by C2 in v1: `downloadIrdAnnexDocument` runs in platform context and is not on the R10.4 list, so it writes `platform_events` `ird_document_downloaded` instead (§5.10).

## 10. Background jobs (worker `jobs/identity`)

| Task id | Trigger | Behaviour | Idempotency | max_attempts |
|---|---|---|---|---|
| `identity.gotrue_signout` | enqueued on revoke/lock/deactivate/tenant suspend/password change/role change | tenant kinds: `adminSignOutUser(userId)` or `signOut(accessToken,'local')` with the token read under tenant claims; **`platform` kind: payload `{user_id}` only and always `adminSignOutUser(user_id)`** (a worker cannot read a platform session row: the `__platform` policies need `is_platform_actor()`) | `job_key = signout:<session_id or user_id>:<reason>`; GoTrue sign-out of an already signed-out session is treated as success | 10 (02-CV §7.5 consumer class) |
| `identity.send_invitation` | `inviteUser`, `resendInvitation`, `provisionTenant`, `inviteTenantAdmin`, `invitePlatformStaff` | `sendInvite(email)`; sets invitation `sent_at`, `issued_at`; on permanent failure state `failed` + `last_error_code` | `job_key = invite:<invitation_id>:<attempt_no>` | 8 (messaging class) |
| `identity.send_recovery` | `requestPasswordRecovery` (only when account exists & active) | `sendRecovery(email)`. The ≤ 60-min link TTL is GoTrue's (T1 verification and release precondition, §8; 08 A25 D-219); the job records nothing else | `job_key = recovery:<sha256(email_norm)>:<10-min bucket>` (≤1 email / 10 min / account [CONV]) | 8 |
| `identity.remove_mfa_factors` | `resetUserMfa`, `resetPlatformStaffMfa` | lists + deletes factors; mirror rows `removed` | `job_key = mfa_reset:<membership or staff id>:<version>` | 10 |
| `identity.build_audit_export` | `createAuditExport` | streams rows in batches of 5,000 under the requester's tenant claims (system actor with tenant_id; filters re-validated; the requester had `all_centres = true` at create time, §5.9) to CSV — every text cell through `neutraliseFormula` (P-9) — writes object `{tenant_id}/{yyyy}/{mm}/{export_id}.csv` in bucket `identity-exports` (08 R26), sha256, row_count → `ready` | `job_key = export:<export_id>` | 5 |
| `identity.import_breached_passwords` | manual (platform CLI) | reads `LIMS_IDENTITY_BREACHED_LIST_PATH` (one lowercase hex SHA-1 per line), upserts batches through the owner-role DEFINER `app.identity_load_breached_batch(p_hashes, p_version)`, then calls `app.identity_finish_breached_import(p_version)` to delete older `list_version` rows (05-SCHEMA §6, §10.3) | by file sha256 | 3 |
| `identity.rescan_upload` | enqueued (under the tenant's claims) by `uploadBrandingAsset` / `uploadUserSignature` when `ctx.uploads.accept` returns `scanState` `pending` or `unavailable` (08 A17 P-19) | system actor of identity with the tenant's claims: `ctx.files.scan(await ctx.storage.read(bucket, objectPath))`; `clean` → `scan_state = 'clean'`; `infected` → `scan_state = 'quarantined'` (terminal); still unavailable → retry with backoff | `job_key = rescan:branding_assets:<asset_id>` | 5 (backoff [CONV] 1, 5, 15, 60 min) |
| `identity.notify_ip_throttle` | enqueued (platform task, no tenant; payload `{client_ip, window_start}`) when the per-IP throttle engages (§4 item 11; 08 A25 D-217) | collects the `email_hmac` values of that IP's failure window with the DEFINER `app.identity_notify_ip_throttle_hmacs(p_client_ip, p_since)` (tenant-less `login_failed` rows, ≤ 100, gated by `app.maintenance = 'identity_notify_ip_throttle'`, 08 A28.4), resolves the tenants with `app.identity_tenants_for_email_hmacs(p_hmacs)` (≤ 100 values; DEFINER, 05-SCHEMA §6), and for each tenant inserts one `admin_notices` row (kind `login_ip_throttled`, `subject_type = 'auth_event'`, `subject_id` NULL) under `withTenantScope(tenant, identity system actor)` (core-internal use per D-214) | `job_key = ipthrottle:<sha256(client_ip)>:<throttle start, ISO minute>` | 5 |

The `auth_events` read of `identity.notify_ip_throttle` is the A28.4 DEFINER above (owner policy branch on `auth_events__select__owner_only`, 05-SCHEMA §5.4); the task never reads `identity.auth_events` directly.
Crontab (`cron.ts`, all times Asia/Kathmandu). `platform` = the task only calls an inventoried maintenance DEFINER; `per_tenant` = the worker core enqueues one job per tenant with `status IN ('active','suspended')` inside `withTenantScope(tenantId, <identity system actor>)`, payload `{tenant_id}`, `job_key = '<identifier>:<tenant_id>:<tick ISO minute>'` (08 A13 P-6, A23.1):

| Task | Schedule | tenantScope | Behaviour |
|---|---|---|---|
| `identity.purge_sessions` | every hour at :07 | platform | `app.identity_purge_sessions()`: delete `identity.sessions` rows with `expires_at < now()` (expires_at = max(absolute_expires_at, revoked_at) + 30 days [CONV]) and expired `admin_notices` |
| `identity.expire_support_sessions` | every 5 min | platform | `requested` > 24 h → `expired`; `approved` not activated within 60 min → `expired`; `active` past `expires_at` → `expired` (resolver already enforces) |
| `identity.expire_invitations` | hourly at :17 | platform | `sent` past `expires_at` → `expired`; redact `email` of invitations resolved > 30 days |
| `identity.expire_audit_exports` | hourly at :27 | platform | `ready` past `expires_at` or downloads exhausted → delete object, `expired`; delete `expired`/`failed` rows created more than 1 year ago (05-SCHEMA §9; 08 A17 P-18(c)) |
| `identity.apply_pending_numbering` | daily 00:10 | **per_tenant** | system actor of identity under that tenant's claims: when the tenant has pending fiscal patterns whose effective B.S. fiscal year (Shrawan 1, 04 L16, via `bsdate`) has started → apply, bump settings version (`tenant_settings__update__tenant`) |
| `identity.access_review_due` | daily 06:40 | **per_tenant** | when the tenant's last access review is > 90 days old and no unexpired `access_review_due` notice exists → insert one `admin_notices` row (kind `access_review_due`, subject `access_review`) |
| `identity.purge_auth_events` | daily 03:40 | platform | delete auth events older than the tenant's `retention_audit_years` (≥5) via owner-role purge function (02-CV §5.11) |

## 11. Configuration keys

| Key | Scope | Default | Notes |
|---|---|---|---|
| `LIMS_IDENTITY_GOTRUE_URL` | global | — (required) | internal URL only |
| `LIMS_IDENTITY_GOTRUE_SERVICE_KEY` | global secret | — | CR-C2-014; secret store (REQ-SEC-128) |
| `LIMS_IDENTITY_TOKEN_ENC_KEYS` | global secret | — | JSON `{ "<key_id>": "<base64 32 bytes>" }`; newest id encrypts |
| `LIMS_IDENTITY_EMAIL_HMAC_KEY` | global secret | — | HMAC for `email_hmac` in auth events, rate-limit keys and `core.users.email_hmac` (written on user create and on e-mail change, 08 A25 D-217) |
| `LIMS_IDENTITY_BREACHED_LIST_PATH` | global | — | file for import task |
| `LIMS_IDENTITY_PAN_PATTERN` | global | `^[0-9]{9}$` | PAN format **UNVERIFIED** |
| `LIMS_IDENTITY_PLATFORM_ALLOWED_CIDRS` | global | `` (empty = no global restriction) | intersected with per-staff list (REQ-SEC-063 "IP-restricted where feasible") |
| `LIMS_IDENTITY_PLATFORM_IDLE_MINUTES` / `_ABSOLUTE_HOURS` | global | 15 / 8 [CONV] | within 04 A8 |
| `LIMS_IDENTITY_SUPPORT_MAX_MINUTES` | global | 60 [CONV] | |
| `LIMS_IDENTITY_EXPORT_MAX_DAYS` / `_MAX_ROWS` | global | 31 / 500000 [CONV] | |
| `LIMS_IDENTITY_EXPORT_QUOTA_USER_DAY` / `_TENANT_DAY` | global | 5 / 20 [CONV] | |
| `LIMS_IDENTITY_EXPORT_TTL_HOURS` / `_MAX_DOWNLOADS` | global | 24 / 3 [CONV] | |
| `LIMS_IDENTITY_SETTINGS_CACHE_SECONDS` | global | 30 [CONV] | |
| `LIMS_IDENTITY_TOUCH_INTERVAL_SECONDS` | global | 60 [CONV] | |
| `LIMS_IDENTITY_LOGIN_BACKOFF_BASE_SECONDS` / `_MAX_SECONDS` | global | 30 / 900 [CONV] | §03-APP-FLOW 3.3 |
| `LIMS_IDENTITY_INVITE_TTL_HOURS` | global | 72 [CONV] (effective TTL = min(this, GoTrue link TTL — UNVERIFIED)) | REQ-SEC-076 |
| `LIMS_IDENTITY_RECOVERY_TTL_MINUTES` | global | 60 | 04 A12 (≤60) |
| `LIMS_IDENTITY_LOGIN_IP_FAILURE_THRESHOLD` / `_WINDOW_MINUTES` | global | 10 / 10 [CONV] | per-client-IP failure counter (08 Addendum A1); failures only |
| `LIMS_IDENTITY_LOGIN_IP_THROTTLE_PER_MINUTE` / `_THROTTLE_MINUTES` | global | 5 / 30 [CONV] | throttle applied to an IP over the threshold (08 Addendum A1) |
| `LIMS_IDENTITY_PATIENT_IDLE_DAYS` / `_ABSOLUTE_DAYS` | global default; tenant-configurable 1–30 / 1–90 | 14 / 30 [DECISION] | patient sessions (08 R10) |
| `LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS` | global | 12 | staff_mobile sessions (04 A8; no idle timeout, 04 A16) |
| Tenant settings (per tenant) | tenant | see 05-SCHEMA §4.6 | |

Rate limits applied by C2 through C0's `ctx.rateLimit.consume()` (`login` tier, C0 02-TRD §6.7; values 04 §4 as amended by 08 Addendum A1; key prefixes are C0's): per-account login `10/hour` keyed `a:<email_hmac>`; per-account failure sliding window 1 h (≥ 5 → backoff + step-up); per-client-IP **failure** counter keyed `f:<client_ip>` (≥ 10 failures in 10 min → that IP limited to 5 attempts/min for 30 min, auth event `login_ip_throttled`, task `identity.notify_ip_throttle` (admin notices to targeted tenants, D-217), alert to the LIMS provider on-call; successful logins never counted); MFA verify 5 per `mfa_pending` session; `general` tier elsewhere. The throttle state for an IP is held by C2 in the same C0 store [CONV key `f:<client_ip>:throttle`, C0 prefix `f:`]. Scope: staff web, partner and staff-mobile login (patient OTP limits are C16's). The client IP is `ctx.clientIp` (08 A25 P-61), never a header read by C2 and never the BFF address (08 R6 placement rule). nginx adds only a 60 req/min/IP (burst 20) flood guard on the public login/recovery routes (C1); `/v1/identity/auth/*` itself is BFF-network only (CR-C2-012).

## 12. Performance targets (04 §14 ASSUMPTION inputs; arithmetic shown)

| Flow | Load derivation | Target [CONV] |
|---|---|---|
| Claims resolution (every API request) | N=10: 60–120 req/s sustained, ~500 req/s burst (04 §14) → 500 definer calls/s at burst, each an index lookup by `gotrue_session_id` (unique) + PK joins | p95 ≤ 3 ms; p99 ≤ 8 ms |
| `assertRole` | per request, memoised profile | p95 ≤ 2 ms; privileged ≤ 10 ms (03 §4.6) |
| `getTenantSettings` | cached | ≤ 2 ms (03 §4.6); hit ratio ≥ 99 % |
| `resolveSession` | ~60 concurrent staff/lab × 10 labs = 600 sessions; BFF cache 60 s → ≤ 10 resolves/s; touch writes ≤ 1/min/session → ≤ 10 writes/s ≈ 4 % of the 250 writes/s headroom (04 §14) | p95 ≤ 25 ms without refresh, ≤ 400 ms with GoTrue refresh |
| `loginStaff` | assume ≤ 10 logins/staff/day (idle 15–30 min forces re-login) → 600 × 10 = 6,000/day; peak hour 25 % (04 §14) = 1,500/h ≈ 0.42/s | p95 ≤ 1.5 s (bcrypt cost 10 inside GoTrue dominates; measure) |
| Audit list | ASSUMPTION: ~1 audit row per write; ≲50 writes/s at N=10 (04 §14) ≈ 4.3 M rows/day upper bound across 10 labs; query by `(tenant_id, occurred_at DESC, id)` with LIMIT 50 | p95 ≤ 300 ms over 1 year of data at 10× volume |
| Audit export | ≤ 500,000 rows; batches of 5,000 | ≤ 5 min per export |
| Provisioning | single transaction (~40 inserts) + 1 job | p95 ≤ 2 s |

Load test (REQ-SEC-025) uses the seed generator at 1× and 10× (05-DoD §3.5).

## 13. Observability

Logs (02-CV §9): every handler logs `operation_id`, `tenant_id`, `actor_id`, `error_code`. **Never logged:** email, phone, passwords, TOTP codes, session tokens, JWTs, refresh tokens, `token_hash`, otpauth URI/secret, QR SVG, IP is allowed in auth events table but **not** in general logs beyond C0's access log fields.

Metrics:

| Metric | Labels |
|---|---|
| `lims_identity_logins_total` | `outcome` (success, failed, step_up, locked, suspended, inactive, rate_limited, ip_throttled, ip_denied), `kind` |
| `lims_identity_login_ip_throttles_active` | — (gauge; 08 Addendum A1) |
| `lims_identity_mfa_verifications_total` | `outcome`, `flow` (challenge, enrol) |
| `lims_identity_session_resolves_total` | `outcome` (ok, refreshed, expired, revoked, refresh_failed) |
| `lims_identity_claims_resolve_duration_seconds` | — (histogram) |
| `lims_identity_authz_decisions_total` | `outcome` (allow, forbidden, mfa_required, locked, support_required), `privileged` |
| `lims_identity_active_sessions` | `kind` (gauge, sampled every 5 min) |
| `lims_identity_gotrue_requests_total` / `_duration_seconds` | `op`, `outcome` |
| `lims_identity_audit_exports_total` | `tenant_id`, `source` |
| `lims_identity_support_sessions_active` | — |
| `lims_identity_support_sessions_opened_total` | `scope` [CONV] |
| `lims_identity_breached_list_loaded` | gauge 0/1 |
| `lims_identity_settings_cache_total` | `result` (hit, miss) |

Backing gauges for the alert rules [CONV] (08 A22.4 precedent: the chunk defines the gauges its rules need): `lims_identity_login_failures_by_tenant_5m{tenant_id}` (failed logins of known accounts in the last 5 min, sampled every minute from `identity.auth_events`), `lims_identity_stuffing_distinct_accounts_15m` and `lims_identity_stuffing_distinct_ips_15m` (distinct failing `email_hmac` / client IPs in the last 15 min, sampled every minute), `lims_identity_audit_exports_tenant_day{tenant_id}` (exports created today).

#### Alert rules for C1 (08 A13 P-14; REQ-SEC-133)

C2 keeps the rule file in its own path, `services/worker/src/jobs/identity/ops/identity.rules.yml` [CONV]; C1 wires it through **CR-C2-019** (§15) and adds only `team` and `runbook_url` (C1 02-TRD §11.3). Thresholds [CONV]. In-app notices to tenant admins are written by C2 itself (`admin_notices`), not by Alertmanager.

| Alert | expr | for | severity | route (C1 receiver) |
|---|---|---|---|---|
| `IdentityLoginFailureSpike` | `sum(increase(lims_identity_logins_total{outcome="failed"}[5m])) > 50 or max by (tenant_id) (lims_identity_login_failures_by_tenant_5m) > 20` | 0m | warn | `ops-digest-email` |
| `IdentityCredentialStuffing` | `lims_identity_stuffing_distinct_accounts_15m >= 30 and lims_identity_stuffing_distinct_ips_15m >= 10` | 0m | page | `oncall-email` |
| `IdentityLoginIpThrottleEngaged` | `increase(lims_identity_logins_total{outcome="ip_throttled"}[5m]) > 0 or lims_identity_login_ip_throttles_active > 0` (tenant admins get the in-app notice from `identity.notify_ip_throttle`, 08 A1 / A25 D-217) | 0m | page | `oncall-email` |
| `IdentityPlatformIpDenied` | `increase(lims_identity_logins_total{outcome="ip_denied"}[5m]) > 0` | 0m | page | `oncall-email` |
| `IdentitySupportSessionOpened` | `increase(lims_identity_support_sessions_opened_total[5m]) > 0` [CONV counter] (tenant admins: in-app notice) | 0m | info | `ops-digest-email` |
| `IdentityAuditExportsHigh` | `max by (tenant_id) (lims_identity_audit_exports_tenant_day) > 3` (every export also raises an in-app notice) | 0m | warn | `ops-digest-email` |
| `IdentityGoTrueUnavailable` | `sum(rate(lims_identity_gotrue_requests_total{outcome="error"}[5m])) / sum(rate(lims_identity_gotrue_requests_total[5m])) > 0.2` | 5m | page | `oncall-email` |
| `IdentityRefreshFailures` | `increase(lims_identity_session_resolves_total{outcome="refresh_failed"}[10m]) > 10` | 0m | warn | `ops-digest-email` |
| `IdentityBreachedListMissing` | `lims_identity_breached_list_loaded{env="production"} == 0` | 10m | page | `oncall-email` |
| `IdentityDeadLetter` | `increase(lims_core_dead_letters_total{task=~"identity\\..*"}[5m]) > 0` | 0m | page | `oncall-email` |

#### CI jobs for C0-0A (08 A13 P-14)

C2 keeps the scripts in its own paths; C0-0A wires them through **CR-C2-019** (§15).

| Job id | Trigger paths | Runner OS | Command |
|---|---|---|---|
| `identity-service-key-grep` (CR-C2-014) | `services/**`, `apps/**`, `packages/**` | ubuntu (C0 default runner) | `node services/api/src/modules/identity/__tests__/ci/service-key-grep.mjs` — fails if `LIMS_IDENTITY_GOTRUE_SERVICE_KEY` is read outside `gotrue/gateway.http.ts` |
| `identity-no-dead-letter-sql` (D-T12) | `services/api/src/modules/identity/**` | ubuntu | `tools/lint/no-foreign-schema-sql` run with the C2 fixture `services/api/src/modules/identity/__tests__/ci/no-dead-letter-sql.fixture.json` (no SQL naming `core.dead_letters`) |

## 14. Test strategy

| Layer | What | Fakes |
|---|---|---|
| Unit | password policy (12 chars, 72 bytes, breached lookup), numbering-pattern validator (every token in 03 §9.3, required tokens, max length), settings ranges, all state tables (every allowed transition + one forbidden per state), permission-set resolution, support allowlist, CSV quoting (injection guard is `@lims/shared-ts/spreadsheet`'s, P-9), claims builder | none |
| Integration | services + repositories on migrated PG17 with `tenant_a`/`tenant_b` seeds; real GoTrue container from compose (pinned image) for `GoTrueGateway` contract tests | `GoTrueGateway` fake for service tests; C0 rate-limit fake |
| Contract — HTTP | every operationId request/response against `identity.yaml`, every `x-error-codes` entry | Prism for web tests |
| Contract — port | `packages/fakes/contract-tests/IdentityPort.contract.ts` (03-IC §4.6 cases 1–12) against the real impl + C2 cases C2-1…C2-10 (§7) | — |
| Probes | every operationId: tenant A credentials with tenant B ids (path/body/query/batch), centre-scoped admin vs other centre, tenant user against `/platform/*` (expect 403), support session of A against B ids (expect 404); every identity table SQL probe (02-CV §11.3) | C0 probe generator |
| Security | see 07-SECURITY §6 | — |
| E2E (nightly) | login → MFA enrol → invite user → user accepts → role change → lock → audit view; platform provision → support session → end | full compose |
| Load | §12 targets | seed generator 1×, 10× |

## 15. Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C2-001 | ACCEPTED in 08 |
| CR-C2-002 | ACCEPTED in 08; `core.dead_letters` removed from the allowlist (08 A8.6) |
| CR-C2-003 | ACCEPTED-MODIFIED in 08 — Explicit branch scope via `core.membership_branches` (R3); add CHECK `actor_type = 'user' OR NOT all_centres`; token hashes `bytea` (R24). Remaining columns merged into C0 05-SCHEMA §10 by 08 Addendum A3.4 (no `is_locked`; `terminated_at` → `offboarded_at`). |
| CR-C2-004 | ACCEPTED-MODIFIED in 08 — `withTenantScope` only for an enumerated operationId allowlist in core config + access-log entry per use (R10). |
| CR-C2-005 | ACCEPTED-MODIFIED in 08 — Resolver is the sole claims source for every GoTrue JWT in every environment; extended to kinds partner/patient/staff_mobile (R10). |
| CR-C2-006 | ACCEPTED-MODIFIED in 08 — `identity.self.manage` roles += radiologist (CR-C6-003). |
| CR-C2-007 | ACCEPTED in 08 |
| CR-C2-008 | ACCEPTED-MODIFIED in 08 — Primary of merged TenantSettings change: branding (C0-009, C4-009), retention, featureFlags, ird.annexReadiness, numbering (C5-009, C11-005) — final shape §4.12. |
| CR-C2-009 | ACCEPTED-MODIFIED in 08 — + `X-Lims-Bff-Key`; kind binding from key, not from a free header (R10). |
| CR-C2-010 | ACCEPTED-MODIFIED in 08 — Event types mapped to 2-segment action codes (§4.4). |
| CR-C2-011 | ACCEPTED-MODIFIED in 08 — Primary of merged upload/storage CR (R12); final API §4.13. |
| CR-C2-012 | ACCEPTED-MODIFIED in 08 — Per-IP login zone sits on public BFF/app login routes keyed by client IP, not on BFF-only API routes; buckets renamed `identity-assets`, `identity-exports` (R26). |
| CR-C2-013 | ACCEPTED in 08 |
| CR-C2-014 | ACCEPTED in 08 |
| CR-C2-015 | MERGED in 08 into CR-C0-008 |
| CR-C2-016 | ACCEPTED-MODIFIED in 08 — OtpCodeInput→`OtpInput`; SecretRevealField→`SecretRevealOnce`; StatusTimeline→existing `Timeline`; JsonDiffView→`DiffTable`; SupportBanner = C0 shell slot; new `PermissionMatrix`, `DataUriImage` (R22). |
| CR-C2-017 | ACCEPTED in 08 |
| CR-C2-018 | ACCEPTED in 08 Addendum A3.1 — `identity.sessions.previous_token_sha256` (bytea, 32 bytes, NULL) + partial global unique index WHERE NOT NULL (index-rule exception, DEFINER-only); reuse of the previous token → revoke `token_reuse` + `session_token_reused`. |
| 08 Addendum A3 | applied 2026-11-06 — A3.1 → CR-C2-018 (§4 item 10; 05-SCHEMA §2, §4.1, §6, §10.1, §10.3, §11 test 17; 03-APP-FLOW §3.5a; 07-SECURITY AU-T15). A3.2: C2 text checked, no fail2ban reference, consistent. A3.3: 05-SCHEMA §3.1 rewritten as mirror of C0 05-SCHEMA §10 (C0 wins); renamed references fixed (tenant status values, `tenant_code` pattern, `signature_image_ref`, `is_system_default`); columns C2 needed that C0 §10 lacked were listed as OPEN at the time; closed by A3.4 (next row). |
| 08 A3.4 | applied 2026-11-06 — CR-C2-003 remainder merged into C0 05-SCHEMA §10. 05-SCHEMA: §3 intro; §3.1 mirror now carries `core.tenants` `status_reason`/`activated_at`/`suspended_at`/`offboarded_at`/`billing_live_on`, `core.users` `email_normalized` (+ UNIQUE (tenant_id, email_normalized))/`phone_e164`/`last_login_at`, `core.memberships` `status` + generated `is_active` + `invited_at`/`accepted_at`/`deactivated_at`/`deactivated_by`/`deactivation_reason_code`/`lock_reason_text`/`last_login_at` + `lock_reason_code` CHECK set + both partial unique indexes `WHERE status IN ('invited','active')`, `core.dead_letters.version`, `role_permissions`/`membership_roles` indexes; OPEN subsection deleted and replaced by a lifecycle-writes note; §10.2 column proposal removed (only the §5.3 `__platform` policy SQL remains); §10.3 DEFINERs return `membership_locked` = `locked_at IS NOT NULL` (no `is_locked` column); §11 test 18. This TRD §5.3 `listUsers`, §6.2 and §7.1 lock wording; 03-APP-FLOW §2.2 (status `invited`/`active`/`deactivated`, lock orthogonal via `locked_at`), §2.3 (`suspended_at`, `offboarded_at`; T5 sets `status = 'deactivated'`), §4.2, §12 edge row; 04-UI-UX AD-1 filter/badge; 07-SECURITY E-8 note, AU-T18. |
| 08 A6 | applied 2026-11-06 — A6.1: `is_locked` (listUsers filter, UserSummary) and `ActorProfile.isLocked` annotated as kept wire names = `locked_at IS NOT NULL` (§5.3, §7.1; 04-UI-UX AD-1; 05-SCHEMA §3.1; 07-SECURITY E-8). A6.2: `inviteUser`/`updateUser` `phone_e164` `^\+[1-9][0-9]{7,14}$` (§5.3; 04-UI-UX AD-2/AD-3; 07-SECURITY D-T7; 06 T13). A6.3: `reactivateUser` sets `status = 'active'` and clears `deactivated_at`/`deactivated_by`/`deactivation_reason_code` (§5.3; 03-APP-FLOW §2.2 M5; 05-SCHEMA §3.1 lifecycle note); `memberships__deactivation_reason__ck` mirrored in 05-SCHEMA §3.1; `suspendTenant`/`terminateTenant` `reason_text` → `core.tenants.status_reason` (§5.10; 03-APP-FLOW §2.3 T3/T5); `last_login_at` on the wire and in the admin UI = `core.memberships.last_login_at` (§5.2, §5.3; 03-APP-FLOW SS4; 04-UI-UX ME-1, AD-1, AD-15); 07-SECURITY D-T8. A6.4: `replayDeadLetter`/`discardDeadLetter` pass If-Match as `expectedVersion` to `ctx.core.deadLetters.replay/discard`, mismatch → `409 common.version_conflict` (§5.10; 03-APP-FLOW §2.8, §9.3; 04-UI-UX PL-6; 06 T24; 07-SECURITY D-T9). A6.5: confirmations, no change (`membership_locked` DEFINER output, `__platform` SQL in 05-SCHEMA §10.2 kept). A6.6: `app.identity_login_context` counts only `status = 'active' AND actor_type = 'user'` (05-SCHEMA §10.3; 03-APP-FLOW §3.1 rule 4; 05-SCHEMA §11 test 19; 06 T6). |
| 08 A8 | applied 2026-11-06 — A8.1: `app.identity_login_context` `one` CTE = `ORDER BY (status = 'active') DESC, updated_at DESC LIMIT 1` over `actor_type = 'user'` memberships (05-SCHEMA §10.3; 03-APP-FLOW §3.1 rule 4; 05-SCHEMA §11 test 20; 07-SECURITY AU-T19; 06 T6). A8.2: M6 reactivate → `invited` clears `deactivated_*` (§5.3 `reactivateUser`; 03-APP-FLOW §2.2 M6; 05-SCHEMA §3.1 lifecycle note; 07-SECURITY D-T13; 06 T13). A8.3: `terminateTenant` sets `deactivated_at = now()`, `deactivated_by` = platform actor, `deactivation_reason_code = 'other'` on each membership it deactivates (§5.10; 03-APP-FLOW §2.3 T5; 05-SCHEMA §3.1; 07-SECURITY D-T13; 06 T22). A8.4: `discardDeadLetter` `reason_text` → `ctx.core.deadLetters.discard({ …, reasonText })` → `resolution_note` (§5.10; 03-APP-FLOW §2.8, §9.3; 04-UI-UX PL-6; 05-SCHEMA §3.1 mirror incl. CHECK and trigger list; 01-PRD US-E5; 07-SECURITY D-T10; 06 T24). A8.5: list/get return C0 `DeadLetterRow` with `version`, never `job_payload` (§5.10; 03-APP-FLOW §9.3; 04-UI-UX PL-6 no payload; 07-SECURITY threat row + D-T11). A8.6: `core.dead_letters` removed from the CR-C2-002 allowlist; no C2 SQL or direct UPDATE on it; `__platform` policies kept, written by C0 for `ctx.core` (§15 CR-C2-002 + status table; 05-SCHEMA §3.1, §5.3, §10.2; 07-SECURITY D-T12; 06 T24). |
| 08 A9 | applied 2026-11-06 — A9.1: `getDeadLetter` via `ctx.core.deadLetters.get({ deadLetterId })`, `404 common.not_found` (§5.10 table; 03-APP-FLOW §9.3; 04-UI-UX PL-6; 01-PRD US-E5; 07-SECURITY D-T14; 06 T24). A9.2: `listDeadLetters` filters `state`, `tenant_id`, `task_identifier`, `dead_at_from`/`dead_at_to`, `cursor`, `limit` passed 1:1 to `ctx.core.deadLetters.list` (§5.10 table; 03-APP-FLOW §9.3; 04-UI-UX PL-6; 01-PRD US-E5; 07-SECURITY D-T15; 06 T24). A9.3: `replayDeadLetter` optional `reason_text` (1–500) → `reasonText` → `resolution_note` (§5.10 table; 03-APP-FLOW §2.8 + §9.3; 04-UI-UX PL-6; 01-PRD US-E5; 07-SECURITY D-T16; 06 T24). A9.4: C0-only (C0 05-SCHEMA §10 `app.dl_*` bodies); no C2 change. A9.5: `terminateTenant` `deactivated_by` = the platform staff user's id (human actor, claims `sub`), never a system actor (§5.10 table; 03-APP-FLOW §2.3 T5; 07-SECURITY D-T13). A9.6: C0-only (C0 02-TRD §6.8 reference); no C2 change. |
| 08 A10 | applied 2026-11-06 — A10.1: C0-only. `app.dl_resolve` returns `job_payload` to the C0 core service only, for a platform-row replay; C2 receives `void` from `ctx.core.deadLetters.replay`. C2 note added in 03-APP-FLOW §9.3; C2 responses still never contain `job_payload` (07-SECURITY D-T11 unchanged). A10.2: `listDeadLetters` `platform_rows` (boolean, default false) → `platformRows`; with `true`, `tenant_id` must be absent, else `400 common.validation_failed` (§5.10 table; 03-APP-FLOW §9.3; 04-UI-UX PL-6; 07-SECURITY D-T17; 06 T24). A10.3: confirmed, no C2 change (C0 `get` via `p_dead_letter_id`; `dead_at DESC, id DESC` [CONV]; `dl_resolve_invalid_input`). A10.4: `dead_letters__select__platform` / `__update__platform` gain `tenant_id IS NOT NULL` (05-SCHEMA §3.1 mirror, §5.3, §10.2 SQL; §11 test 23; 07-SECURITY D-T18). A10.5: `platform_staff__select__owner_only TO lims_owner USING (true)` and an owner-policy audit of every §6 DEFINER (05-SCHEMA §4.5 RLS note, §5.4 table, §6 note, §10.1 DDL; §11 tests 21–22; 07-SECURITY D-T19; 06 T27 note). Owner policies added: `platform_staff__select__owner_only`, `platform_staff__insert__owner_only`, `platform_events__insert__owner_only`, `auth_events__{insert,select,delete}__owner_only`, `sessions__{select,delete}__owner_only`, `admin_notices__{select,delete}__owner_only`, `support_sessions__{select,update}__owner_only`, `invitations__{select,update}__owner_only`, `audit_exports__{select,update}__owner_only`. OPEN (05-SCHEMA §5.4): owner policies for the parameter-bound pre-tenant lookups (`app.identity_resolve_session`, `app.identity_session_by_token`, `app.identity_login_context`, `app.identity_user_exists`) and for the `identity.tenant_settings` read of `app.identity_purge_auth_events`. |
| 08 A12 | applied 2026-11-06 — A12.1: 05-SCHEMA §10.3 `app.identity_resolve_session`, `app.identity_session_by_token`, `app.identity_login_context`, `app.identity_user_exists` rewritten as plpgsql (`VOLATILE`): set `app.pre_gotrue_session_id` / `app.pre_session_token_sha256` / `app.pre_user_id` / `app.pre_tenant_id` (the last after the A8.1 membership or the session's tenant is chosen) with `set_config(…, true)` and reset them to `''` before return; `app.identity_user_exists` already takes the GoTrue `sub` (signature unchanged). Owner SELECT policies (§5.4 table + GUC table, §10.1): `sessions__select__owner_only` (expiry OR current/previous hash OR GoTrue session id), `mfa_factors__select__owner_only`, `tenant_settings__select__owner_only`, `support_sessions__select__owner_only` (`app.pre_tenant_id` branch added); `core` ones written by C0 and mirrored in §10.2 (`memberships`, `users`, `tenants`, `roles`, `membership_roles__select__owner_only`). A12.2: `app.identity_purge_auth_events` (plpgsql) sets/resets `app.maintenance = 'identity_purge_auth_events'`; `auth_events__{select,delete}__owner_only` gated on it; `tenant_settings__select__owner_only` maintenance branch. A12.3/A12.4: C0-only (`app.platform_list_tenants` body; `app.purge_event_log()` call). A12.5: 05-SCHEMA §3.1 audit-trigger list no longer includes `identity.platform_staff` (platform-only tables recorded in `identity.platform_events`); 05-SCHEMA §4.5 RLS note. A12.6: `app.identity_expire_invitations` = one `UPDATE … SET status = CASE … END, email = CASE … END`. A12.7: 05-SCHEMA §11 test 22 rewritten (lookup and tenant-retention cases now expected green), tests 24 (GUC isolation + reset) and 25 (bootstrap with no claims, no audit trigger on platform-only tables); 06 T4; 07-SECURITY D-T19. Not decided (05-SCHEMA §5.4 "Not decided", raised to the lead): support-session columns of `app.identity_resolve_session` for `platform` sessions, and platform staff tenant-less MFA factors in `app.identity_login_context`, are not admitted by the A12.1 predicates; their test-22 cases stay red. |
| 08 A15 | applied 2026-11-06 — A15.1: 05-SCHEMA §10.3 `app.identity_resolve_session` reads the session row's `support_session_id`, sets `app.pre_support_session_id` before `identity.support_sessions` is read and resets it before return; `support_sessions__select__owner_only` gains `id = app.pre_support_session_id` (§5.4 GUC table + function table, §10.1). A15.2: `mfa_factors__select__owner_only` = `user_id = app.pre_user_id AND tenant_id IS NOT DISTINCT FROM app.pre_tenant_id` (§5.4, §10.1; §10.3 comment). The §5.4 "Not decided" subsection and the §10.3 NOT DECIDED comments are removed; §11 test 22's two red cases are now expected green. A15.3: `app.identity_purge_sessions`, `app.identity_expire_support_sessions`, `app.identity_expire_invitations`, `app.identity_expire_audit_exports` rewritten as plpgsql `VOLATILE` with `app.maintenance = '<function name>'` set/reset; every maintenance branch of `sessions`, `admin_notices`, `support_sessions`, `invitations`, `audit_exports` owner policies gated on it (UPDATE `WITH CHECK` too) — no static maintenance policy remains (§5.4 maintenance paragraph + table, §6 note, §10.1, §10.3). A15.4/A15.5: C0-only. A15.6: `app.is_platform_actor()` DDL removed from §5.1 (now C0 05-SCHEMA §10; contract stated, C2 keeps §11 tests 3 and 21); §4.5 RLS note. Tests: §11 tests 21, 22 (support columns for a `platform` session, tenant-less platform staff factor, maintenance GUC reset), 24 (`app.pre_support_session_id`; every maintenance name; owner policies admit nothing without their GUC). 06 T4, T27; 07-SECURITY D-T19. Open (raised to the lead, §5.4): `support_tenant_status` of a `platform` session stays NULL (no branch admits the support tenant's `core.tenants` row). |

| CR-C2-019 | ACCEPTED in 08 A28.6 (08 A13 P-14; review C2 m#55) — C1 wires `services/worker/src/jobs/identity/ops/identity.rules.yml` and C0-0A wires the two §13 CI jobs |
| 08 A1 | applied 2026-11-06 — per-IP failure throttle in C2 (§4 item 11, §11, note below; 03-APP-FLOW §3.1; 07-SECURITY A-1, AU-T2a–d). |
| 08 A2 | applied 2026-11-06 — A2.6 staff e-mail lookup is superseded by A4.2 (row below); A2.1–A2.5, A2.7–A2.12: not applicable to C2. |
| 08 A4 | applied 2026-11-06 (review fix pass) — A4.2 `getStaffNotificationContact` (§7, §9, contract cases IC (11)–(12)); A4.1, A4.3–A4.8 not applicable. |
| 08 A5 | not applicable (C13, C12, C8, C16 items). |
| 08 A7 | not applicable (C3, C4, C6, C8, C12, C13, C16 notes). |
| 08 A11 | not applicable (C6/C15 portal payments, B1 order). |
| 08 A13 | applied 2026-11-06 (review fix pass) — P-1 (01-PRD AC-B2.2, AC-C3.1, AC-C3.2, AC-C5.3, AC-E3.1 → 400); P-2 (§5.6 `getBrandingAssetContent`, §5.9 `downloadAuditExport`, §5.10 `downloadIrdAnnexDocument`); P-3 (§9 access-log table; 03-APP-FLOW §2.4, §9.1 codes); P-6 (§10 crontab `per_tenant`); P-8 (Idem column §5.2–§5.9, creates `required`); P-9 (§2, §10; 01-PRD AC-D4.6; 06 T19; 07-SECURITY A-13, D-T4); P-10 (§5.9 `listAuditExports`); P-14 (§13 alert and CI tables, CR-C2-019); P-15 (§5.6, §5.10; 05-SCHEMA §4.6 + `tenant_settings__timezone__ck`; 04-UI-UX AD-8, PL-2); D-8 (05-SCHEMA §4.6/§10.1 barcode default; §7 mapping); D-13 (§5.3 note; 04-UI-UX AD-2, AD-3, AD-5); D-16 (§5.5, §7.4; 01-PRD §2; 04-UI-UX AD-7); D-23 (§7 mapping row); D-26 (§7 `readBrandingAsset`, C2-7/C2-8); D-32 (§6.1 `bffKey` `portal`). Other A13 items not applicable. |
| 08 A14 | applied 2026-11-06 — A14.1 (§7 `readBrandingAsset` excludes signatures); A14.2–A14.4 not applicable. |
| 08 A16 | applied 2026-11-06 — A16.1 cast in 05-SCHEMA §3.2 RLS text and CR-C2-010 text below. |
| 08 A17 | applied 2026-11-06 (review fix pass) — P-16 (05-SCHEMA §5.2, §10.1 guard in every `__tenant` policy; `shared_with: [partner]` for `sessions`, `mfa_factors`; §11 test 26); P-18(c) (05-SCHEMA §9/§10.3 `audit_exports` 1-year delete via `app.maintenance`); P-19 (§5.3, §5.6, §5.10, §10 `identity.rescan_upload`; 05-SCHEMA §4.10, §4.14); D-63 (§5.3 warning); A17.4 (= A16.1). Other A17 items not applicable. |
| 08 A18 | applied 2026-11-06 — A18.1 (07-SECURITY §1 REQ-SEC-088/089 CSP text). |
| 08 A19 | applied 2026-11-06 (review fix pass) — P-41 (05-SCHEMA §6 rows for every C2 DEFINER incl. `app.identity_finish_breached_import`, `app.identity_tenants_for_email_hmacs`); P-42 (§5 failure-writes paragraph, §5.2; 03-APP-FLOW §3.1, §3.2, §3.4, §3.5a; 06 T6, T7, T10, T31); D-100 (§7 `expectedVersion?`, C2-6); D-101 (§5.2, §7.1; 07-SECURITY AU-T20); D-119 (§7.3, C2-10). Other A19 items not applicable. |
| 08 A20 | applied 2026-11-06 (review fix pass) — A20.1 (05-SCHEMA §10.3 `app.identity_resolve_session` sets `app.pre_tenant_id` to the active support session's tenant for a `platform` session; §5.4; §11 test 22); A20.2 (05-SCHEMA §5.1: `app.current_lims_session_id()` is C0 DDL, C2 references it); A20.3 (05-SCHEMA §4.10/§4.14 triggers list their mutable columns; the `coalesce(TG_ARGV::text[], '{}')` body is C0's); A20.4 no change. |
| 08 A21 | applied 2026-11-06 — A21.2 `readSignatureImage` (§7, §9, C2-9; CR-C6-020); A21.4 (C2 already uses `app.pre_*` names, reset before return); A21.1, A21.3, A21.5 not applicable. |
| 08 A22 | applied 2026-11-06 — A22.2 (§7, §7.3: partner-admin port writes allowed); A22.0, A22.1, A22.3, A22.4 not applicable (A22.4 used as precedent for the §13 backing gauges). |
| 08 A23 | applied 2026-11-06 — A23.1 per-tenant cron fan-out (§10 crontab); A23.2/A23.3 are C0 DDL (C2 cites them; no C2 policy on `core.*`/`audit.*`). |
| 08 A24 | not applicable (`CatalogPort.getPriceListStatus`, C3/C16). |
| 08 A25 | applied 2026-11-06 (review fix pass) — P-60 (this table); P-61 (§4 item 11, §9, §11; 07-SECURITY A-1b, AU-T2c); D-202 (§5); D-206 (§4 item 6; 03-APP-FLOW §3.5); D-212 (§5, §5.1; 05-SCHEMA §5.2; 03-APP-FLOW §3.1–§3.7; 06 T6; 07-SECURITY AU-T21); D-213 (§5.10); D-214 (§5.10, §9; 03-APP-FLOW §8, §9.3); D-215 (05-SCHEMA §3.1, §4.17, §11 test 27); D-216 (§5.6, §7.3; 05-SCHEMA §5.2, §10.1, §11 test 2); D-217 (§4 item 11, §10, §11; 05-SCHEMA §3.1, §4.18, §6, §10.2, §10.3, §11 test 28); D-218 (§7, §8; 06 T1, T31); D-219 (§8, §10; 01-PRD §10; 03-APP-FLOW §3.7; 06 T1, T9); D-220 (01-PRD §11 Q5; 03-APP-FLOW §4.2). D-200, D-201, D-203–D-211 not applicable (C0/C1). |
| Review fix pass | Review fix pass 2026-11-06 — review/C2-identity-admin.md + 08 Addendum A25 applied (binding work list `review/_triage-batch4.md` §(e): all P/D/addendum items incl. A20, A21.2 `readSignatureImage`, A22.2, D-100, D-101, D-13 warning text, D-16, D-23, P-15, CR-C16-004 note, and every hand-off addressed to C2). The open items it raised were decided by 08 A26.1 and A28 (rows below). |
| 08 A26 | applied 2026-11-06 — A26.1 `readSignatureImage` returns `SignatureImageContent` (§7, C2-9; 06 T5); A26.2–A26.4 not applicable. |
| 08 A27 | not applicable (C1). |
| 08 A28 | applied 2026-11-06 — A28.1 platform-staff auth DEFINERs `app.identity_platform_auth_write_*` + `__platform` policies for tenant-less `mfa_factors` / `invitations` (§5; 05-SCHEMA §5.2, §5.3, §5.4, §6, §10.1, §10.3, §11 test 34; 03-APP-FLOW §3.1); A28.2 patient-context port writes in `withTenantScope` (§7; 05-SCHEMA §5.2); A28.3 `partner_role` from `core.memberships` via the resolver DEFINER and claims (§6.2, §7.1; 05-SCHEMA §3.1, §10.3); A28.4 `app.identity_notify_ip_throttle_hmacs` (§10; 05-SCHEMA §5.4, §6, §10.1, §10.3, §11 test 35); A28.5 is C0's `tg_row_audit` change (05-SCHEMA §3.1, §11 test 33); A28.6 accepted items already in place (CR-C2-019 ACCEPT). |

> Note (08 Addendum A1, founder decision 2026-11-06, supersedes R6's registered-egress-IP zone): the per-IP part of login limiting counts **failed** attempts only and is enforced by this module (§4 item 11, §11); nginx keeps only a 60 req/min/IP (burst 20) flood guard on the public login/recovery routes. No registered egress IPs, no `platform.tenant_egress_ip.manage`, no `setTenantEgressIps` operation and no related error/access-log codes exist. The CR-C2-012 placement rule (client IP from the public edge, never the BFF's) stands.

Each CR follows the `program/04-CHANGE-REQUESTS.md` template; C2 builds as if accepted, against fakes, until merged.

**CR-C2-001: Web route groups for auth pages and platform console**
From C2 → C0-0D · Type ui-kit (path allocation) · Blocking: T12, T20.
Problem: login/MFA/reset pages must render without a session (US-A1–A8); the platform console must not use the tenant staff shell (REQ-SEC-063; US-E*). 01 §3 only allocates `apps/web/src/app/(staff)/<module>/`.
Proposed: allocate `apps/web/src/app/(auth)/auth/**` and `apps/web/src/app/(platform)/platform/**` to C2 in CODEOWNERS; C0 provides `(auth)/layout.tsx`-free shell primitives (C2 owns the layouts inside these groups); remove `(staff)/platform/` from C2's list. URLs unchanged vs `routes.yaml`. Backward compatible: yes. Security: new unauthenticated pages (no data); CSP same as shell.

**CR-C2-002: CI exception — identity repository access to `core` admin tables and `audit` reads**
From C2 → C0-0A (CI) · Type shared-lib/CI · Blocking: T6–T10, T15.
Problem: 01 §3 makes C2 the logic owner of `core` tables and the `audit` viewer, but 02-CV §5.13 CI grep rejects `<other_schema>.` references in `repository/`.
Proposed: allowlist `services/api/src/modules/identity/repository/{core-admin,audit-read}.repo.ts` for `core.{tenants,branches,collection_centres,users,memberships,membership_centres,membership_branches,membership_roles,roles,role_permissions}` (read/write) and `audit.{audit_log,access_log}` (read only). `core.dead_letters` is not in the allowlist: C2 writes dead letters only through `ctx.core.deadLetters` (08 A8.6; C2's earlier allowlist entry for it and its direct UPDATE grant are removed). Backward compatible: yes. Security: no new grants beyond §5.9 class rules.

**CR-C2-003: `core` table columns, constraints and inventory functions required by C2** — full list in 05-SCHEMA §3 and §6. To C0-0B · schema · Blocking: T2.

**CR-C2-004: Platform request context**
To C0-0D (API/worker core) + C0-0B · Blocking: T18–T22.
Proposed: (a) C0 core accepts a resolved claims object of `kind: 'platform'` and builds `PlatformRequestContext { actor, requestId, tx, now, platformRole, platformStaffId }` (no `tenantId`, no port registry access); handlers declare `x-context: platform` in the spec; (b) SQL helper `app.is_platform_actor() RETURNS boolean` (DEFINER, `SET search_path=''`): true iff claims `scope ∈ ('platform')` and `platform_staff_id` maps to an active `identity.platform_staff` row and claims `aal = 'aal2'`; (c) `__platform` policies on tables listed in 05-SCHEMA §5.3; (d) `ctx.db.withTenantScope(tx, tenantId, fn)` available only in platform context of module `identity`, which `set_config('request.jwt.claims', <system claims of identity for tenantId>, true)` for the duration of `fn` and restores the platform claims after; every use writes an access-log event (codes as registered later: `tenant.lifecycle_change`, `support_session.*`, `dead_letter.view` — §9; 08 A25 D-214). Security: new privileged context; inventory + probes required (07-SECURITY T-P*).

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

**CR-C2-010: `audit` tables — columns, indexes, RLS and access-event types needed by the viewer** To C0-0B. Columns/indexes in 05-SCHEMA §3.2 (mirror of C0 05-SCHEMA §10, C0 wins — 08 A3.3); RLS `__select__tenant` (tenant_id match; centre predicate `centre_id IS NULL OR (SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])`, 08 A16.1); `ctx.audit.access` accepts the event types listed in §9.

**CR-C2-011: Shared upload pipeline + storage adapter** To C0-0A. `ctx.uploads.accept({ file, allow: ['image/png','image/jpeg'(,'application/pdf')], maxBytes, reencodeImages: true, scan: true, bucket, path })` implementing 02-CV §10.2 (magic bytes, re-encode, ClamAV-class scan, quarantine) and `ctx.storage.read/write` via server-side credentials; also needed by C4 (TRF) and C6 (outsourced PDFs).

**CR-C2-012: Infra rules for identity** To C1. GoTrue port reachable only from the API network; `/v1/identity/auth/*` reachable only from the BFF network (nginx deny for public origin); per-IP `limit_req` 5/min on `/v1/identity/auth/login` and `/v1/identity/auth/password/recover` (04 §4); GoTrue SMTP via the transactional relay (REQ-ARCH-018) with link-only templates pointing at `{staff_web}/auth/confirm?token_hash=…&type=…`; exclude query strings of `/auth/confirm` from nginx access logs (token is a secret, like `/r/` and `/v/` routes in routes.yaml); GoTrue recovery/invite link TTL ≤ 60 min (04 A12); refresh-token rotation + reuse detection on (04 A6); buckets `tenant-assets` and `exports` private (with C0-0B policies).

**CR-C2-013: System-actor permission lookup** To C0-0D. Expose `ctx.core.systemActorPermissions(actorId): readonly PermissionCode[]` built from worker manifests (02-CV §2.3, 03 §11 `system:` row) so `IdentityPort` can authorise system actors.

**CR-C2-014: Service-role key use by the identity GoTrue adapter** To C0 (audited module list, 02-CV §10.2; REQ-SEC-029/030). Only `services/api/src/modules/identity/gotrue/gateway.http.ts` may read `LIMS_IDENTITY_GOTRUE_SERVICE_KEY`; it is sent only to the internal GoTrue URL, never used for PostgREST or DB; CI grep enforces.

**CR-C2-015: Glossary table-name fix** To doc owner. `06-GLOSSARY.md` "Collection centre" row says `core` table `centres`; 02-CV §5.3 and 03 §9.1 say `core.collection_centres`. C2 uses `core.collection_centres`.

**CR-C2-016: UI-kit components** To C0-0D — list in 04-UI-UX §2.2.

**CR-C2-017: Exceptions to "tenant_id leads every index/unique constraint"** To C0-0B (02-CV §5.3 rule; REQ-SEC-023). Requested global unique indexes: `identity.sessions(token_sha256)`, `identity.sessions(gotrue_session_id)`, partial `core.memberships(user_id) WHERE actor_type = 'user'`. Justification: pre-tenant lookups through inventoried DEFINER functions only; values are 256-bit random hashes or a one-tenant-per-user invariant (02-CV §6); no client-reachable query exposes a uniqueness violation across tenants (invite collisions return the generic `identity.user_exists`, 07-SECURITY A-6). Tenant-leading secondary indexes are also present. Also `UNIQUE NULLS NOT DISTINCT (tenant_id, …)` on tables with platform rows (PostgreSQL 15+ feature; PG 17 per 04 D9).

**CR-C2-018: Reuse detection for rotated app session tokens** To C0-0B (08 Addendum A3.1; ACCEPTED). `identity.sessions` gains `previous_token_sha256 bytea NULL CHECK (previous_token_sha256 IS NULL OR octet_length(previous_token_sha256) = 32)`; on rotation (patient, staff_mobile) the old `token_sha256` moves there and only one previous token is kept. New index-rule exception: partial global unique index `identity.sessions(previous_token_sha256) WHERE previous_token_sha256 IS NOT NULL`, read only by the inventoried DEFINER `app.identity_session_by_token` (05-SCHEMA §6, §10.3); recorded in 08 §4.7 and `db/meta/index-exceptions.yaml`. Presenting a token that matches `previous_token_sha256` revokes the session (`revoke_reason = 'token_reuse'`) and writes `auth_events.session_token_reused`. Justification as CR-C2-017 (256-bit random hashes, pre-tenant DEFINER lookup, no client-visible uniqueness oracle).

**CR-C2-019: Wiring of C2's alert rules and CI jobs** (08 A13 P-14; review C2 m#55). To C1 (alerts) and C0-0A (CI). C1 loads `services/worker/src/jobs/identity/ops/identity.rules.yml` (rules in §13 "Alert rules for C1") into its Prometheus/Alertmanager config, adding only `team` and `runbook_url`; C0-0A adds the two jobs of §13 "CI jobs for C0-0A" to the CI workflow. Backward compatible: yes. Security: alerts REQ-SEC-133; no new secret.
