# C2 — Identity, Access & Administration — 07 Security

Status: DECISION draft, 2026-11-05. REQ IDs from `research/02-security.md` (cited, not copied). C2 is the access-control authority for the whole product, so most failures here are tenant-wide or platform-wide.

## 1. Applicable requirements

| REQ | How it applies in C2 |
|---|---|
| REQ-SEC-001/002 | ASVS 5.0 L2 V6/V7/V8 traceability for login, sessions, authz; BOLA is the primary review lens for every C2 endpoint |
| REQ-SEC-004 | column classification in 05-SCHEMA §4 (P0–P3, S) |
| REQ-SEC-011–016 | ENABLE+FORCE RLS on all identity tables; per-command policies `TO lims_app`; every `__tenant` policy carries the staff-or-system guard (08 A17 P-16; partner access only through the `__own` / `__own_user` policies of `sessions`, `mfa_factors`); no `USING (true)`; no DELETE policies for `lims_app` (05-SCHEMA §5, §10) |
| REQ-SEC-017 | centre scope modelled in memberships (`all_centres`, `membership_centres`); `assertRole({centreId})`; audit viewer centre predicate (CR-C2-010) |
| REQ-SEC-019–021 | every C2 DEFINER function: unexposed `app` schema, `search_path = ''`, schema-qualified, no caller tenant parameter, inventoried (05-SCHEMA §6) |
| REQ-SEC-022–024 | `(SELECT helper())` wrapping; tenant-leading indexes; explicit `tenant_id = $1` in repositories |
| REQ-SEC-026/027 | composite FKs; `tenant_id` never defaulted; platform rows explicit `NULL` with shape CHECKs |
| REQ-SEC-028 | UUIDv7 ids in all paths; tenant codes are slugs, never path ids |
| REQ-SEC-029/030 | GoTrue service key confined to `gotrue/gateway.http.ts`, internal URL only (CR-C2-014) |
| REQ-SEC-031 | no views; audit viewer queries tables under invoker RLS |
| REQ-SEC-038 | never query `auth.*`; emails duplicated in `core.users`/`platform_staff` for display |
| REQ-SEC-039/131 | `lims_api`/`lims_worker` non-BYPASSRLS; grants per class |
| REQ-SEC-040/044 | probes for every C2 operation and table (§6) incl. mixed-tenant ids in role/centre arrays |
| REQ-SEC-045/133 | alerts: login spikes, stuffing, per-IP login failure throttle engaged (08 Addendum A1), IP-denied, exports, support sessions (02-TRD §13) |
| REQ-SEC-060 | bcrypt cost 10 accepted (04 A2); compensating: MFA (A4), local breach list (A3), rate limits/backoff (§4), lockout/step-up; 72-byte input limit enforced; test asserts `$2a$10$` prefix in GoTrue (T1) |
| REQ-SEC-061 | ≥12 chars, local breached list only (online HIBP = B11 flag, not implemented) |
| REQ-SEC-062 | MFA mandatory for roles with `mfa_required` and any role containing a privileged permission; platform staff always |
| REQ-SEC-063 | separate platform identities (`identity.platform_staff`), TOTP (hardware key UNVERIFIED in GoTrue → deferred), IP allowlist, every platform action in `platform_events` or target-tenant access log |
| REQ-SEC-064 | 10/hour/account + backoff + step-up; per-client-IP **failure** throttle in C2 (≥ 10 failures/10 min → 5 attempts/min for 30 min + security event + alerts; successful logins never counted — 08 Addendum A1); nginx 60 req/min/IP (burst 20) flood guard on public login/recovery routes (C1); client IP from the public edge, never the BFF's (08 R6 placement) |
| REQ-SEC-065 | JWT ≤1 h (GoTrue default, 04 A5); refresh rotation; server-side revocation on logout/password change/role change — effective next request via resolver |
| REQ-SEC-066 | C0 core verifies; C2 never decodes unverified JWTs; resolver consumes only verified claims |
| REQ-SEC-067 | claims built server-side from DB on every request by the identity `claimsResolver`, the sole claims source (08 R10); session kind bound by BFF key / endpoint family, never by a client header; privileged checks re-read membership |
| REQ-SEC-068 | opaque HttpOnly `__Host-` cookie; no Supabase client or JWT in the browser; lint + bundle scan |
| REQ-SEC-073 | idle 15–30, absolute ≤12 h enforced in BFF and API; session listing + remote revoke |
| REQ-SEC-074 | `identity.auth_events` for every auth event with tenant, user, IP, UA, request id |
| REQ-SEC-075 | recovery: constant response, single-use, ≤60 min, identical invalid-token responses |
| REQ-SEC-076 | invites time-limited; password set + MFA enrolment before first PHI access (state machine) |
| REQ-SEC-078/079 | tiers `login` and `general`; sliding windows in C0 limiter |
| REQ-SEC-080/081 | spec-strict bodies (no `tenant_id`, `permissions`, `status` in non-action bodies); DTO allowlists, masked email/phone/IP in lists |
| REQ-SEC-082 | parameterised SQL; search uses escaped prefix `LIKE` |
| REQ-SEC-083–085 | uploads (logo, letterhead, signature, IRD docs) through C0 pipeline; PNG/JPEG/PDF only; SVG rejected; served as attachment + nosniff |
| REQ-SEC-088/089 | QR SVG rendered only via `DataUriImage` (`<img src="data:…">`); staff-web CSP `img-src 'self' data:` (08 A18.1, C0 CSP config); no `dangerouslySetInnerHTML`; `DiffTable` renders text nodes |
| REQ-SEC-091/092 | BFF Origin/Sec-Fetch-Site check on all auth POSTs; `/v1/identity/auth/*` not reachable from browsers (C1) |
| REQ-SEC-095 | generic problem bodies; login errors never say which factor failed except MFA stage |
| REQ-SEC-096/097 | role/permission/lock/settings changes via C0 triggers; view/export/download via access log; append-only tables |
| REQ-SEC-098 | no emails/phones in URLs (`searchUsers` is POST); token URLs (`/auth/confirm`) excluded from logs; tokens never logged |
| REQ-SEC-099 | all `x-public` operations justified (02-TRD §5.1) |
| REQ-SEC-100 | audit export privileged + quota |
| REQ-SEC-128 | secrets in store: GoTrue service key, token encryption keys, email HMAC key |
| REQ-SEC-136 | synthetic tenants/users only; non-prod GoTrue SMTP to a sink, never to real inboxes |
| REQ-SEC-137 | all time comparisons in DB `now()`; TOTP depends on server NTP (C1) |
| REQ-SEC-139 | retention settings per tenant (B15 floors) |
| REQ-SEC-140 | lock/deactivate in ≤3 clicks, immediate effect; quarterly access review screen |
| REQ-SEC-141 | email relay used by GoTrue is the only foreign touchpoint C2 causes (04 §11) |

## 2. Assets

| Asset | Where | Class |
|---|---|---|
| Session tokens (cookie) | browser cookie; SHA-256 in `identity.sessions` | S |
| GoTrue refresh/access tokens | AES-GCM ciphertext in `identity.sessions`; BFF memory ≤60 s | S |
| GoTrue service key, token-enc keys, email HMAC key | secret store | S |
| Passwords | transit only (BFF → API → GoTrue); never stored by C2 | S |
| TOTP secrets | GoTrue only; shown once at enrolment | S |
| Membership/role/permission data | `core.*` | P1 (authority data) |
| Staff PII (email, phone, signature image, IP, UA) | `core.users`, `core.memberships`, `branding_assets`, `auth_events`, `sessions` | P2 |
| Audit/access logs (old/new rows contain PHI of other modules) | `audit.*` (viewer), exports | P3 |
| Tenant configuration (numbering, retention, flags) | `identity.tenant_settings`, `feature_flags` | P0 but integrity-critical (IRD) |
| IRD documents | bucket `identity-assets`, `{tenant_id}/ird/…` (platform Annex 1: `platform/ird/…`, platform context only — 08 R26) | business-confidential |

## 3. Threat model (STRIDE per entry point)

| Entry point / asset | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| `loginStaff`, `loginPartner`, `openMobileSession` | credential stuffing → 10/h/account, per-IP failure throttle (08 Addendum A1), nginx flood guard, MFA, breach list, alerts; staff credential on partner login → `401 auth.login_failed` | — | auth events with IP/UA | account oracle → constant body + timing floor | step-up abuse → bounded window, unlock | GoTrue direct-login bypass → GoTrue not exposed + resolver requires our session row |
| `verifyMfaChallenge` | TOTP brute force → 5 per session then revoke + account counter | — | events | — | — | skipping MFA by calling business APIs in `mfa_pending` → resolver passes state; `assertRole` rejects |
| Session cookie / `resolveSession` | stolen cookie → HttpOnly, Secure, `__Host-`, idle/absolute, remote revoke | cookie fixation → new random token per login, never accept client-supplied ids | — | token leak in logs → never logged; only hash stored | — | — |
| Claims resolver | forged JWT → C0 verification (alg pinned, no grace) | claims tampering → claims never taken from JWT beyond `sub`/`session_id`/`aal` | — | — | DB hot path → 3 ms budget | stale role → live DB lookup per request |
| `IdentityPort.assertRole` | — | — | decision metric | — | — | privileged without MFA → aal2 check; revoked membership → fresh re-read |
| Recovery / invite links | link guessing → GoTrue token entropy (UNVERIFIED value; 04 A12 requires ≥128-bit — T1 verifies) | — | events | account existence → constant 202 | email bombing → 1 email/10 min/account, nginx flood guard on the public recovery route | link reuse → single-use, 60-min TTL |
| User/role admin endpoints | — | mass assignment (`tenant_id`, `permissions`) → strict spec | audit trigger | cross-tenant ids → RLS 404 | — | self-escalation via custom role → cannot grant `platform.*`; privileged roles force MFA; last-admin guard; admin cannot lock self |
| Support sessions | The LIMS provider staff impersonating tenant users → support claims distinct, banner, audit `support_session_id` | — | access log in tenant + platform events | vendor PHI access → allowlist excludes all clinical/billing permissions; centre-bound audit rows hidden | — | support `admin` scope only for superadmin |
| Platform console | stolen platform account → TOTP, IP allowlist, short sessions (15 min idle / 8 h) | provisioning tampering → idempotency + audit | platform_events | cross-tenant listing is intended for platform only → `__platform` policies require aal2 + active staff | — | tenant admin reaching `/platform/*` → platform context requires platform session |
| Audit viewer/export | — | — | access log of views/exports/downloads | insider exfiltration (02 failure mode #10) → privileged + MFA, quota, range/row caps, no values in exports, notices to all admins, 24 h/3 downloads | large exports → row cap, async job | — |
| Uploads (branding/signature/IRD docs) | — | malicious file → magic bytes, re-encode, scan, no SVG | — | serving inline → attachment + nosniff | oversize → size caps | stored XSS via SVG/HTML → banned types |
| Dead-letter replay | — | replaying a poisoned job → superadmin only, view logged, task / error code / redacted message visible before replay | platform_events + access log | payload may contain P3 ids → `job_payload` never returned by `ctx.core.deadLetters` or the API (08 A8.5) | replay storms → per-item action, If-Match | — |

## 4. Abuse cases (each has a test in §6)

| # | Abuse case | Control |
|---|---|---|
| A-1 | Attacker sprays passwords over many staff emails of a lab from one IP | per-IP failure throttle (≥ 10 failures/10 min → 5/min for 30 min, `login_ip_throttled`, alerts to targeted tenants' admins + the LIMS provider on-call) + per-account 10/h + stuffing alert; generic errors |
| A-1a | Distributed stuffing from many IPs | per-account 10/h, backoff + step-up, breach list, MFA, stuffing alert (08 Addendum A1 rationale) |
| A-1b | Attacker sends a forged `X-Forwarded-For` to dodge or poison the per-IP counter | nginx overwrites `X-Forwarded-For`; C0 core sets `app.client_ip` from it only with a valid `X-Lims-Bff-Key` or from a peer in `LIMS_CORE_TRUSTED_PROXY_CIDRS` (08 A25 P-61), else from the peer address; C2 reads only `ctx.clientIp`, never a header; `/v1/identity/auth/*` reachable only from the BFF network |
| A-1c | A session of one kind is replayed on another endpoint family (patient token on staff BFF, partner session via staff key, staff session on partner BFF) | kind bound by BFF key / endpoint family → `401` (08 R10) |
| A-2 | Attacker with a phished password tries to reach PHI with an aal1 session as a pathologist | MFA-required role → `mfa_pending` / enrolment state; privileged ops need aal2 |
| A-3 | Ex-employee keeps a browser tab open at a centre PC | idle timeout; lock → next request fails |
| A-4 | Tenant admin creates role "superuser" with `platform.tenant.manage` | non-assignable → 400 |
| A-5 | Tenant admin of Alpha calls `getUser` with a Beta membership id | 404 `common.not_found` |
| A-6 | Tenant admin probes whether `ceo@competitor.example.test` uses the product | `identity.user_exists` generic message; rate tier; alert > 20/day — residual risk accepted |
| A-7 | Insider tenant admin exports a year of access logs to harvest patient ids | 31-day range, 500k cap, 5/day/user, metadata only, notices to all admins, alert |
| A-8 | Support engineer uses a support session to read results | allowlist → 403 on `lab.result.read`; audit |
| A-9 | Stolen platform password used from abroad | IP allowlist (`identity.platform_ip_denied`) + TOTP |
| A-10 | Replay of an old session cookie after logout | session `revoked`; resolver rejects |
| A-11 | Refresh token replay from a leaked DB backup | tokens AES-GCM encrypted with key outside DB; GoTrue reuse detection (04 A6, UNVERIFIED config) |
| A-12 | Uploading an SVG "logo" with script | 415 |
| A-13 | CSV injection in an export opened in Excel (actor display name `=HYPERLINK(...)`) | every text cell through `@lims/shared-ts/spreadsheet` `neutraliseFormula` (08 A13 P-9; also guards a leading `'`) |
| A-14 | Lowering of retention to 1 year to purge evidence | CHECK floors (5/5/1) + audit trigger |
| A-15 | Changing invoice number pattern mid-year to hide a gap | pending pattern effective next FY after billing live; audit |
| A-16 | Enabling WhatsApp PDF attachments (B11) by a tenant admin | platform-only flag + founder approval ref |
| A-17 | Locking the last tenant admin to take over (by a second admin) | last-admin protection applies to lock/deactivate/role removal |
| A-18 | Calling `/v1/identity/auth/login` from the internet directly | nginx deny for non-BFF sources (CR-C2-012); still rate-limited if misconfigured |
| A-19 | Partner or patient claims (they carry `tenant_id`) used to read tenant sessions, auth events, invitations, exports or settings | P-16 guard in every `__tenant` policy; partner sees only its own sessions/factors (08 A17 P-16, A19 D-101) |
| A-20 | A pre-auth handler writes into a tenant other than the one its DEFINER chose | `identityAuthTx` starts with no tenant; `bindTenant` once per transaction, only after the DEFINER chose the membership; allowlisted operationIds only (08 A25 D-212) |
| A-21 | A non-staff handler reads IRD/branding/retention settings through `getTenantSettings` | `patient` / `portal` / `partner` actors limited to `timezone`, `calendarDisplay` (08 A19 D-119) |
| A-22 | An unscanned upload is served while the scanner is down | `scan_state` stays `pending`, content → `422 common.upload_quarantined` until a re-scan is `clean` (08 A17 P-19) |

## 5. PHI handling and logging rules

1. Never log: email, phone, password, TOTP code, otpauth URI/secret, QR SVG, session token, JWT, refresh token, `token_hash`, signature image paths with membership ids in query strings. C0 logger denylist must include `password`, `code` (for MFA routes), `token`, `token_hash`, `session_token`, `secret`, `otpauth`.
2. `auth_events.email_hmac` only for unknown accounts; never store plaintext emails of failed attempts.
3. Lists mask email/phone/IP (04-UI-UX §3); detail views show full values only to holders of the page permission.
4. Audit detail views write the access log **before** returning values; failure to log = request fails.
5. Exports never include `old_values`/`new_values` (C0 column names, 05-SCHEMA §3.2 mirror; 08 A3.3).
6. Support reasons/ticket refs: UI warns "no patient details"; treated as P2 (may contain names by mistake) and not logged.
7. Error `detail` strings never contain emails or names (REQ-SEC-095).
8. Non-prod: GoTrue SMTP points at a local mail sink (C1); seed emails `@example.test`.

## 6. Required security tests

### 6.1 Cross-tenant probes (every operation in 02-TRD §5; generator + hand-written)
- P-1 Every `/v1/identity/*` tenant operation with an object id: tenant A admin (aal2) + tenant B id in path → `404 common.not_found`, DB unchanged for B.
- P-2 Array inputs mixing A and B ids (`role_ids`, `centre_ids`, `branch_ids`) → `422 identity.role_unknown` / `409 identity.centre_inactive` style rejection **without** revealing B (same response as a random UUID).
- P-3 Lists (`listUsers`, `listRoles`, `listCentres`, `listSessions`, `listAuditEntries`, `listAccessLogEntries`, `listAuthEvents`, `listAuditExports`, `listTenantSupportSessions`, `listAdminNotices`) with B data present → zero B rows.
- P-4 Export of A never contains B rows (build job under A claims; verify file contents).
- P-5 SQL probes for every identity table (05-SCHEMA §11 items 1–4).
- P-6 Support session for A: any B id → 404; platform-level rows invisible.
- P-7 Tenant user (even `tenant_admin`, aal2) on every `/v1/identity/platform/*` operation → `403 auth.forbidden`.
- P-8 Platform actor without support session on every tenant operation → `403 identity.support_session_required`.

### 6.2 Centre scoping
- C-1 A centre-scoped admin (if a tenant grants `identity.user.read` to a centre-scoped role) lists users: all memberships are tenant-level data (not centre-scoped) — documented; but `listAuditEntries` returns only rows with `centre_id IS NULL` or in scope.
- C-2 `IdentityPort.assertRole({centreId: A2})` for an A1-scoped user → `auth.forbidden`; `all_centres` → ok; centre of tenant B → `auth.forbidden`.
- C-3 `branchId` checks analogous, against explicit `core.membership_branches` grants only (08 R3): a user with centre A1 (branch X) but no branch grant → `assertRole({branchId: X})` forbidden unless `all_centres`; partner/patient/device actors never get centre or branch scope.

### 6.3 Privilege escalation
- E-1 Role editor rejects `platform.*`, actor-only and unknown codes.
- E-2 User cannot assign themselves roles (`setUserRoles` on self requires `identity.role.manage`; with it, removing own last admin role → `identity.last_admin_protected`).
- E-3 aal1 session calling each privileged C2 operation → `403 auth.mfa_required`.
- E-4 Membership revoked after JWT issued → next privileged call fails (contract case 6); next any call fails (resolver).
- E-5 `read_only` support → every write op 403; `admin` support → `audit.log.export` 403, any non-identity permission 403.
- E-6 `platform_support` cannot open `admin` scope, cannot manage staff, cannot replay dead letters.
- E-7 JWT from GoTrue without an `identity.sessions` row → `401 auth.unauthenticated`.
- E-8 Request bodies with `tenant_id`, `permissions`, `status`, `is_locked`, `aal` → 400 unknown field (`is_locked` is a response/filter wire name only, kept by 08 A6.1; storage is `locked_at`, 08 Addendum A3.4).
- E-9 Cookie with valid format but unknown token → `401 auth.session_expired`, timing indistinguishable from revoked.

### 6.4 Authentication specifics
- AU-T1 Unknown vs wrong password: identical body; p95 timing difference ≤ 50 ms over 200 trials.
- AU-T2 11th attempt/hour → 429; 5 failures → step-up without password check (instrument GoTrue fake call count = 0).
- AU-T2a Shared NAT (08 Addendum A1): 60 successful logins of 60 different staff from one client IP within one minute → all 60 succeed; no `login_ip_throttled` event.
- AU-T2b Stuffing: 10 failed logins (mixed accounts, tenants A and B) from one client IP within 10 min → throttle engaged: further attempts from that IP limited to 5/min for 30 min (excess → `429 common.rate_limited`), one `login_ip_throttled` auth event, admin notices to admins of A and B, on-call alert metric; after 30 min (injected clock) the throttle lifts; a different IP is unaffected.
- AU-T2c The per-IP key is `ctx.clientIp` (08 A25 P-61): two clients behind different public IPs through the same BFF get separate counters; two phones on `openMobileSession` (no BFF; peer = nginx in `LIMS_CORE_TRUSTED_PROXY_CIDRS`) get separate counters, not nginx's address; a request with a client-supplied `X-Forwarded-For` from a peer outside the trusted CIDRs and without a BFF key is counted under the peer address; C2 code contains no read of `X-Forwarded-For` (grep).
- AU-T2d Same rules for `loginPartner` and `openMobileSession`; patient OTP endpoints are not affected (C16 limits).
- AU-T3 5th invalid MFA code in `mfa_pending` → session revoked (`mfa_failed`), matching AC-A2.3 / SS6; a 6th request → `401 auth.session_expired`. Each failed attempt's `mfa_failed_attempts` increment and auth event are present after its 401 (`ctx.commitOnError()`, 08 A19 P-42).
- AU-T4 Password 11 chars / 73-byte Devanagari / breached → rejected; GoTrue never called.
- AU-T5 Recovery for unknown, locked, existing emails → identical 202 and timing class; only existing active triggers a job.
- AU-T6 Recovery link at 61 min → `auth.reset_token_invalid`; second use → same.
- AU-T7 Idle and absolute expiry with injected clock; background polling does not extend idle.
- AU-T8 Cookie attributes: `HttpOnly; Secure; SameSite=Lax; Path=/`, `__Host-` prefix; no `Domain`.
- AU-T9 Staff web bundle contains no `@supabase/` import and no `access_token` string sinks (C0 bundle scan + C2 test).
- AU-T10 Platform login from non-allowlisted IP → 403 + alert metric.
- AU-T11 Password change and reset revoke all other sessions.
- AU-T12 GoTrue hash prefix `$2a$10$` observed for a test user (REQ-SEC-060 verification, T1).
- AU-T13 Session kind × endpoint family (08 R10): a `patient` session token on `/v1/identity/auth/*` (staff key) → 401; a `tenant_staff` session resolved with the partner BFF key → `401 auth.session_expired`; a `partner` session resolved with the staff_web key → 401; a `staff_mobile` token on `/v1/identity/auth/patient/*` → 401; a request without a valid `X-Lims-Bff-Key` on any `bffSession` operation → 401.
- AU-T14 BFF key of the partner BFF on `loginStaff` / a staff credential on `loginPartner` → `401 auth.login_failed`; no session row created.
- AU-T15 Patient / staff-mobile session token rotation (CR-C2-018, 08 Addendum A3.1): refresh returns a new token and the row's `previous_token_sha256` equals the SHA-256 of the old token; the old token presented again (refresh or resolve) → `401 auth.session_expired`, session `revoked` with `revoke_reason = 'token_reuse'`, auth event `session_token_reused`, and the new token stops working too; after two refreshes only the immediately previous token is kept (the token from two rotations ago matches neither column → `401`, session state unchanged).
- AU-T16 A JWT carrying its own `tenant_id`/`membership_id`/`actor_type` claims → those claims ignored; resolved claims come from the session row only (C0 AC-0D-2.2a).
- AU-T17 `openMobileSession` for a membership without `homecollection.sync.upload` → `403 auth.forbidden`.
- AU-T18 Lock is `locked_at IS NOT NULL` (08 Addendum A3.4): after `lockUser` the membership row has `locked_at`/`locked_by` set and the next `resolveSession` and `loginStaff` return `403 auth.account_locked` (DEFINER output `membership_locked = true`); after `unlockUser` both are NULL and login succeeds. An unlocked membership with `status = 'deactivated'` → `403 identity.membership_inactive` (02-TRD §6 check order); the identity repository never writes `core.memberships.is_active` (generated; a write fails with SQLSTATE `428C9`).
- AU-T20 Partner self-service (08 A19 D-101): a `partner` session (partner BFF key) runs `getMe` (roles = `[<partner role>]`, centre scope empty), `changeOwnPassword`, `listOwnSessions`, `revokeOwnSession`, `listOwnMfaFactors`, `removeOwnMfaFactor` on its own records; another partner member's `session_id` / `factor_id` → `404 common.not_found`, DB unchanged; a `portal` BFF key on any `/v1/identity/*` operation → `401 auth.unauthenticated`.
- AU-T21 Pre-auth transactions (08 A25 D-212): `loginStaff` with an unknown e-mail writes only the tenant-less auth event (DEFINER) and no tenant row; a successful tenant-staff login creates its session row only after `bindTenant` (claims `tenant_id` = the DEFINER's membership tenant); a second `bindTenant` in the same transaction throws; an operation outside the allowlist cannot obtain `identityAuthTx` (C0 core refuses); every §5.1 operation carries `x-context: identity_auth` and `x-public` (spec-lint).
- AU-T22 Failure writes survive the 4xx (08 A19 P-42): wrong password on `loginStaff` / `loginPartner` / `openMobileSession` (auth event + `f:` counter + throttle event at the 10th), wrong code on `verifyMfaChallenge` / `completeMfaEnrolment` (`mfa_failed_attempts`), wrong current password on `changeOwnPassword`, refresh-token reuse (revoke + `session_token_reused`) — each write is present after the error response and no other write of that request is.
- AU-T23 Per-IP throttle notices (08 A25 D-217): after the throttle engages for failures against accounts of tenants A and B, `identity.notify_ip_throttle` inserts exactly one `login_ip_throttled` notice (`subject_id` NULL) in A and one in B and none in C; no HTTP response differs by whether an e-mail exists.
- AU-T24 Platform staff login (08 A28.1): a platform staff login with MFA creates its `platform` session, verifies the factor and stamps `last_login_at` only through `app.identity_platform_auth_write_*` (05-SCHEMA §11 test 34); the same writes issued directly as `lims_api` under the `identityAuthTx` claims are refused by RLS; a call naming another staff user's session changes 0 rows.
- AU-T19 Login membership choice (08 A8.1): a staff user deactivated in tenant A and active in tenant B logs in with the correct password → session in tenant B (`200`, session `tenant_id` = B); a user whose only `user` membership is `deactivated` → `403 identity.membership_inactive` (the error reflects that membership; 05-SCHEMA §11 test 20).

### 6.5 Data/integrity
- D-T1 Settings out-of-range for every ranged field → 422 at API and CHECK at DB.
- D-T2 Pending fiscal pattern applied only after Shrawan 1 of the next FY (B.S. via `bsdate`, golden dates).
- D-T3 Audit detail without successful access-log insert → request fails (fault injection).
- D-T4 CSV injection guard: export cells starting with `=`, `+`, `-`, `@`, tab, CR or `'` are prefixed by `neutraliseFormula` (`@lims/shared-ts/spreadsheet`, 08 A13 P-9); no module-local guard exists in `services/**/identity/**` (grep).
- D-T5 Upload corpus: SVG, HTML-in-PNG polyglot, EICAR, 3 MB PNG, 5000 px PNG, `.png` with PDF magic → rejected with the right code.
- D-T6 Feature flag requiring founder approval without `approval_ref` → rejected at API and DB trigger.
- D-T7 Phone pattern (08 A6.2): `inviteUser` and `updateUser` accept `phone_e164 = +9779841000000` and reject `9779841000000`, `+0123456789` and `+1234567` (7 digits) with `400 common.validation_failed` at the JSON pointer — the same cases C0 05-SCHEMA §10 test 5 runs against `users__phone_e164__ck`; the AD-2/AD-3 Mobile field rejects the same values client-side.
- D-T8 Deactivate / reactivate (08 A6.3): `deactivateUser` with `reason_code = security_concern` sets `status = 'deactivated'`, `deactivated_at`, `deactivated_by`, `deactivation_reason_code`; `reactivateUser` (accepted member) sets `status = 'active'` and all three `deactivated_*` columns to NULL, and `audit.audit_log` keeps the old values. `suspendTenant` / `terminateTenant` store `reason_text` in `core.tenants.status_reason`. `listUsers`/`getUser` `last_login_at` equals `core.memberships.last_login_at`.
- D-T9 Dead-letter If-Match (08 A6.4): `replayDeadLetter` / `discardDeadLetter` with a stale If-Match → `409 common.version_conflict`, row still `open`, no job enqueued; with the current version → state changes and `version` + 1. The handler passes If-Match as `expectedVersion` to `ctx.core.deadLetters.replay/discard` (unit test with a C0 core fake asserting the argument).
- D-T10 Dead-letter discard reason (08 A8.4): `discardDeadLetter` with `reason_text` "duplicate of replayed job" and the current If-Match → the row has `state = 'discarded'` and `resolution_note` = that text, and `getDeadLetter` / `listDeadLetters` return it as `resolution_note`; `reason_text` of 0 or 501 chars → `400 common.validation_failed` and the row is unchanged. The handler passes `reasonText` to `ctx.core.deadLetters.discard` (unit test with the C0 core fake asserting the argument). The DB CHECK is C0's (`dead_letters__resolution_note__ck`, C0 05-SCHEMA §10 test 9).
- D-T11 Dead-letter response shape (08 A8.5): every `listDeadLetters` item and the `getDeadLetter` body carry `version` (equal to the row's `version`, usable as If-Match) and never a `job_payload` key (contract test against the spec schema + response-shape assertion on a row whose `job_payload` is non-empty).
- D-T14 Dead-letter detail via `get` (08 A9.1): `getDeadLetter` calls `ctx.core.deadLetters.get({ deadLetterId })` (unit test with the C0 core fake asserting the call and argument) and returns its `DeadLetterRow`; an unknown `dead_letter_id` → the fake throws `common.not_found` → `404 common.not_found`, and no `dead_letter.view` access-log entry or platform event with outcome `allowed` is written.
- D-T15 Dead-letter list filters (08 A9.2): `listDeadLetters?state=open&tenant_id=<A>&task_identifier=<t>&dead_at_from=<f>&dead_at_to=<u>&limit=10&cursor=<c>` passes `{ state, tenantId, taskIdentifier, deadAtFrom, deadAtTo, cursor, limit }` 1:1 to `ctx.core.deadLetters.list` (fake asserts the argument); with seeded rows, each filter alone and combined returns only matching rows, `dead_at_from` is inclusive and `dead_at_to` exclusive, and paging returns every row once; an unknown query param or `limit = 201` → `400 common.validation_failed`.
- D-T16 Dead-letter replay note (08 A9.3): `replayDeadLetter` with body `reason_text` "re-run after provider fix" and the current If-Match → `state = 'replayed'`, `resolution_note` = that text, returned by `getDeadLetter`; without `reason_text` → `resolution_note` NULL; `reason_text` of 0 or 501 chars → `400 common.validation_failed`, row still `open`, nothing enqueued. The handler passes `reasonText` (or omits it) to `ctx.core.deadLetters.replay` (fake asserts the argument).
- D-T17 Dead-letter `platform_rows` (08 A10.2): `listDeadLetters` without `platform_rows` passes `platformRows: false` to `ctx.core.deadLetters.list`; `?platform_rows=true` passes `platformRows: true` and returns only rows with `tenant_id` NULL (fake asserts the argument; integration with seeded tenant and platform rows); `?platform_rows=true&tenant_id=<A>` → `400 common.validation_failed` and `ctx.core.deadLetters.list` is not called; a non-boolean value → `400 common.validation_failed`.
- D-T18 Dead-letter `__platform` policies (08 A10.4; 05-SCHEMA §11 test 23): under platform claims a direct `SELECT` on `core.dead_letters` returns no NULL-tenant row and a direct `UPDATE` of one changes 0 rows; NULL-tenant rows are listed and resolved only through the C0 `app.dl_*` DEFINERs.
- D-T19 DEFINER owner policies (08 A10.5; 05-SCHEMA §5.4, §11 tests 21–22): `app.is_platform_actor()` returns `true` for an active staff row with FORCE RLS on `identity.platform_staff`, so `__platform` policies admit an aal2 platform session. Each §6 maintenance function changes its due rows under FORCE RLS through `app.maintenance` = its name (set and reset in the body; its owner policies admit nothing without it, and a `lims_worker` session setting it itself sees nothing; 08 A15.3; §11 test 24). No C2 test disables RLS or uses an RLS-less stand-in for an identity table. The pre-tenant lookups (`app.identity_resolve_session`, `app.identity_session_by_token`, `app.identity_login_context`, `app.identity_user_exists`) and the tenant-retention part of `app.identity_purge_auth_events` return their fixture rows under FORCE RLS through the `app.pre_*` / `app.maintenance` GUCs; a `lims_api` session that sets those GUCs itself sees no row; the GUCs are `''` after each function returns (08 A12.1, A12.2, A12.7; 05-SCHEMA §11 tests 22, 24). Bootstrap with no claims succeeds and `identity.platform_staff` has no audit trigger (08 A12.5; test 25). A `platform` session with an active support session resolves with its support-session columns (`app.pre_support_session_id`, 08 A15.1), and a platform staff login with a verified tenant-less factor gets `has_verified_factor = true` (08 A15.2) (§11 test 22). `app.is_platform_actor()` is C0 DDL (08 A15.6); its contract test stays here (§11 test 21).
- D-T12 Single write path (08 A8.6): CI grep finds no SQL naming `core.dead_letters` in `services/api/src/modules/identity/**` (the CR-C2-002 allowlist does not include it; `tools/lint/no-foreign-schema-sql` fixture); the dead-letter service imports no repository and calls only `ctx.core.deadLetters.*`; C2's SQL (05-SCHEMA §10) contains no `GRANT` on `core.dead_letters` (the `__platform` policies stay, written by C0 for `ctx.core`).
- D-T20 Uploads while the scanner is down (08 A17 P-19): `uploadBrandingAsset` / `uploadUserSignature` with the C0 scanner fake returning `unavailable` → row `scan_state = 'pending'`, `identity.rescan_upload` enqueued; `getBrandingAssetContent` and `IdentityPort.readBrandingAsset` → `422 common.upload_quarantined` until the job sets `clean`; a re-scan result `infected` → `quarantined`, still 422. `downloadIrdAnnexDocument` re-scans a `pending` row and returns 422 until clean. Every download response has `Cache-Control: no-store` (P-2).
- D-T21 v1 settings rules: `updateSettings` / `provisionTenant` / `updateTenantSettingsAsPlatform` with `timezone = 'Asia/Kolkata'` → `422 identity.setting_out_of_range` at `/timezone` (P-15); a new tenant's `barcode_pattern` = `{prefix}{yy}{seq:8}` (D-8).
- D-T22 Export centre scope [CONV]: `createAuditExport` by a holder of `audit.log.export` whose membership has `all_centres = false` → `403 auth.forbidden`, no export row.
- D-T23 Annex readiness (08 A25 D-216): tenant A's `listOwnIrdAnnexes` / `getTenantSettings(['ird'])` sees the Annex 1 row its settings reference and computes `annexReadiness = 'complete'` when all four are completed; no other platform row is returned.
- D-T13 Membership lifecycle columns (08 A8.2, A8.3): `reactivateUser` on a never-accepted deactivated member → `status = 'invited'`, new invitation, `deactivated_at`/`deactivated_by`/`deactivation_reason_code` NULL; `terminateTenant` → every membership moved to `deactivated` has `deactivated_at` set, `deactivated_by` = the calling platform staff user's id (claims `sub` of the platform request; 08 A9.5) — asserted to differ from the identity system actor id that `withTenantScope` runs under — `deactivation_reason_code = 'other'`, and `core.tenants.status_reason` = the request's `reason_text`.

## 7. Secrets used

| Secret | Env key | Holder | Rotation |
|---|---|---|---|
| GoTrue service key | `LIMS_IDENTITY_GOTRUE_SERVICE_KEY` | API identity gateway only | with Supabase JWT/key rotation runbook (C1); rotation invalidates nothing in C2 storage |
| Token encryption keys | `LIMS_IDENTITY_TOKEN_ENC_KEYS` (key id → 32 bytes) | API | add new key id → new sessions use it; old sessions expire ≤12 h; remove old key after 24 h |
| Email HMAC key | `LIMS_IDENTITY_EMAIL_HMAC_KEY` | API | rotation resets per-account counters and breaks correlation of old `email_hmac` values (accepted) |
| SMTP relay credentials | GoTrue env (C1) | GoTrue | C1 |

No secret is present in the repo, in `apps/web` bundles, or in logs (gitleaks gate, REQ-SEC-128).

## 8. Sign-off checklist (05-DoD §4)

- [ ] Every REQ in §1 mapped to code location + test id.
- [ ] No foreign touchpoint added (GoTrue email via existing relay only).
- [ ] No BYPASSRLS role used; DEFINER functions only from 05-SCHEMA §6 and in C0 inventory.
- [ ] Rate limits equal 04 §4; token sizes/TTLs equal 04 A8/A12; MFA rules equal 04 A4.
- [ ] §6 tests present and green.
