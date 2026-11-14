# C2 — Identity, Access & Administration — 01 PRD

Status: DECISION draft, 2026-11-05. Phase 1 (04 §12 "roles, audit, masters"). Owner chunk: C2.
Precedence: `research/00` > `research/04` > `program/03` > `program/01`/`02` > this file. Where this file needs something the contracts lack, it is designed "as if accepted" and listed in `02-TRD.md` §15 "Change requests raised" (CR-C2-nnn).

Labels: **VERIFIED / UNVERIFIED / DECISION / BLOCKED (B#) / ASSUMPTION / [CONV]** as defined in `program/00-README.md`.

---

## 1. Purpose

C2 is the single authority for **who may do what, where, in which tenant** of the LIMS, and the administration surface that configures it. It delivers:

1. **Staff authentication through the Next.js server-only BFF** (04 S4, REQ-SEC-068): password login against self-hosted GoTrue (04 S2), TOTP MFA (04 A4), session lifecycle with idle/absolute timeouts (04 A8), password policy (04 A3) and compensating controls for GoTrue's fixed bcrypt cost 10 (04 A2).
2. **The `IdentityPort` implementation** (03 §4.6) that every other module calls before touching state (`getActor`, `assertRole`, `getTenantSettings`).
3. **Tenant administration** for lab tenant admins: users, roles, memberships, centre scope, branches, collection centres, lock/unlock, sessions, tenant settings (calendar display, numbering patterns, branding/letterhead assets, delivery channels, retention, feature flags), audit-log and access-log viewer with controlled export, quarterly access review.
4. **The the LIMS provider platform console**: tenant provisioning, per-tenant settings and feature flags (incl. B11/B13 flags), **IRD Annex 1/2/3/7 workflow tracking** (04 L3/L4 — tracking only), support-access sessions (02-CV §6), dead-letter replay/discard (02-CV §7.5), platform staff management.

## 2. Users and roles

Permission codes are from 03 §11 (`contracts/permissions.yaml`). Codes marked **(CR)** are requested in CR-C2-006.

| Actor | Who (synthetic examples only) | Default role(s) | Permissions C2 checks |
|---|---|---|---|
| Tenant admin | Lab owner / IT admin of "Synthetic Lab Alpha" | `tenant_admin` (mfa_required) | `identity.user.read`, `identity.user.manage`, `identity.role.manage`, `identity.centre.read` (centre directory, also held by other staff roles — 08 A13 D-16), `identity.centre.manage`, `identity.settings.manage`, `identity.session.revoke`, `audit.log.read`, `audit.log.export` (CR) |
| Any tenant staff user | Front desk, technologist, pathologist, finance, centre staff, lab manager, owner viewer, phlebotomist | any tenant role | `identity.self.manage` (CR) — own profile, password, MFA, own sessions (also partner users, 08 A19 D-101; their screens are C13's) |
| Platform superadmin | The LIMS provider operator (separate identity, REQ-SEC-063) | `platform_superadmin` (mfa_required) | `platform.tenant.read`, `platform.tenant.manage`, `platform.support_session.open`, `platform.dead_letter.manage`, `platform.staff.manage` (CR) |
| Platform support | The LIMS provider support engineer | `platform_support` (mfa_required) | `platform.tenant.read`, `platform.support_session.open` |
| Every module (in-process) | C3–C17 handlers and worker jobs | — | call `IdentityPort` |

Role model note (03 §11): the role codes and grants above are [CONV] defaults. **The client's real role model is not in 00** (00 E1 says only "create staff logins, give roles, lock a user"). DECISION: ship the default roles of `contracts/permissions.yaml` `roles:` (03 §11; currently 10, incl. `radiologist` — CR-C6-003) and let tenant admins create custom roles; confirm with the client during onboarding (open question Q1, §11).

## 3. Problems this chunk solves

| # | Problem | Evidence |
|---|---|---|
| P1 | 20 branches/centres per lab, shared reception PCs, staff turnover; ex-staff and walk-away sessions are the most common healthcare breach vector in small orgs | 00 G3; REQ-SEC-073, REQ-SEC-140 |
| P2 | GoTrue hashes with fixed bcrypt cost 10, not configurable | 04 A2 (VERIFIED) |
| P3 | Admin account takeover = tenant-wide PHI breach; credential stuffing of staff accounts | 02 failure modes #17; REQ-SEC-062/064 |
| P4 | Every module needs one consistent "may this actor do X at this centre" answer, with centre scoping as a second predicate | 04 D2; 03 §4.6; REQ-SEC-017 |
| P5 | The product is sold to many labs; each lab is a separate IRD taxpayer needing its own Annex 2 letter, Annex 3 permission and Annex 7 tripartite contract | 00 G1, G5; 04 L3, L4 |
| P6 | Insider at a lab exporting data, discovered only when patients complain | 02 failure mode #10; REQ-SEC-045/133 |
| P7 | The LIMS provider staff must sometimes act inside a tenant; that access must be bounded and visible | REQ-SEC-063; 02-CV §6 |
| P8 | Per-tenant formats (A.D./B.S. display, number patterns, letterhead) differ per lab | 00 §4, A12, D7; 04 D12; 03 §9.3 |

## 4. In scope (mapped to client baseline)

| ID | Capability | Client baseline item(s) | Other basis |
|---|---|---|---|
| S1 | Staff login via BFF, HttpOnly session cookie, logout | 00 E1 ("create staff logins") | 04 S4; REQ-SEC-068 |
| S2 | TOTP MFA: mandatory for MFA-required roles, offered to all; enrolment before first PHI access | 00 E1 | 04 A4; REQ-SEC-062/076 |
| S3 | Password policy ≥12 chars, ≤72 bytes, local breached-password list | 00 E1 | 04 A2, A3; REQ-SEC-060/061 |
| S4 | Login throttling (04 §4 as amended by 08 Addendum A1): 10/hour/account; ≥5 failures → exponential backoff + step-up; per client IP **failed attempts only** — ≥10 failures in 10 min → that IP limited to 5 attempts/min for 30 min + security alert; successful logins never count; nginx 60 req/min/IP (burst 20) flood guard on public login/recovery routes (C1); no static-IP dependency | — | 04 §4; REQ-SEC-064; 08 Addendum A1 |
| S5 | Idle timeout (15–30 min, tenant-configurable) and absolute timeout (≤12 h), enforced in BFF and API | — | 04 A8; REQ-SEC-073 |
| S6 | Session listing and revoke (own sessions; tenant-wide for admins; platform sessions) | — | REQ-SEC-073 |
| S7 | Password reset and invitation flows (single-use tokens, ≤1 h reset TTL, no account oracle) | 00 E1 | 04 A12; REQ-SEC-075/076 |
| S8 | User management: invite, edit, roles, centre scope, deactivate/reactivate, **lock/unlock**, MFA reset, signatory profile + signature image | 00 E1 ("lock a user"); 00 §4 footer signatories; 00 D7 "signature" | 03 §9.1 Membership |
| S9 | Role management: custom roles from the permission registry; last-admin protection | 00 E1 ("give roles") | 03 §11 |
| S10 | Branch and collection-centre management (incl. franchise centres, home-collection pseudo-centre), unlimited count | 00 E2 ("manage collection centres"), 00 §3 item 1 ("unlimited users; unlimited collection centres / franchise based"), 00 G3 | 03 §9.1 |
| S11 | Tenant settings: calendar display A.D./B.S. (04 D12), timezone, session timeouts, report-link TTL (04 A10), hold-till-paid and partial-release switches, letterhead default, numbering patterns (03 §9.3), delivery-channel switches + SMS sender id (04 R6), retention years (B15), IRD fields (PAN, CBMS real-time flag), password min length | 00 A12 ("letterhead"), D1 (hold-till-paid), D7 (with/without letterhead, logo), §4 (A.D. dates) | 03 §4.6 TenantSettings |
| S12 | Branding assets (logo, letterhead header/footer images, lab contact strip) used by C4 receipts and C6 reports | 00 A12, D7 ("add logo, signature, watermark" — watermark and template layout are C6) | REQ-ARCH-044 |
| S13 | Feature flags per tenant incl. B11 flags (default off, founder-approval reference required) and the B13 referral-incentive report flag | 00 E5 ("track commission/incentive") → reporting only | 04 L19, B11, B13 |
| S14 | Tenant provisioning by platform admin: tenant record, first branch + centre, default roles, settings defaults, first tenant-admin invite, IRD tracker rows | 00 G1 ("Selling to Multiple clients") | 04 D1 |
| S15 | Tenant suspend / reactivate / terminate (status only; data retained) | 00 G1 | B15 |
| S16 | IRD Annex 1/2/3/7 status tracker (statuses, dates, reference numbers, documents) per tenant + platform-level Annex 1; readiness indicator | 00 G5 ("Need IRD-approved billing? Yes") | 04 L3, L4, B6 |
| S17 | Audit-log viewer (from `audit.audit_log`) and access-log viewer (from `audit.access_log`), auth-event viewer, filters | — | 04 D11; REQ-SEC-096; IRD cl.6(ञ) audit-trail report (04 L26) |
| S18 | Audit/access/auth-event export: privileged, MFA, quota-limited, range-limited, logged, notified | — | 02 failure mode #10; REQ-SEC-045/100/133 |
| S19 | Support-access sessions (the LIMS provider staff acting in a tenant): reason, time-box, optional tenant approval, banner, audit | — | 02-CV §6; REQ-SEC-063 |
| S20 | Platform console: separate route group, platform staff with TOTP + IP allowlist; platform staff management | — | 04 A4; REQ-SEC-063 |
| S21 | Dead-letter list / replay / discard | — | 02-CV §7.5; routes.yaml `staff.platform.dead_letter` |
| S22 | `IdentityPort` implementation passing the 03 §4.6 contract suite | — | 03 §4.6 |
| S23 | Quarterly access review record per tenant | — | REQ-SEC-140 |
| S24 | User manual pages + in-app help for every C2 screen | 00 §3 item 9 (training) | 01 §2 note |

## 5. Out of scope

| Item | Owner / reason |
|---|---|
| DDL of `core` and `audit` tables, RLS helpers, triggers | C0 (01 §3). C2 specifies requirements (05-SCHEMA §3, CRs) |
| JWT signature verification, request-context plumbing, rate-limit engine, idempotency hook, BFF cookie plumbing, API proxy | C0 core (01 §3) — C2 supplies session logic behind them (CR-C2-005, CR-C2-009) |
| nginx `limit_req` per-IP, GoTrue/SMTP deployment config, secrets store, network isolation of GoTrue | C1 |
| Report template layouts, signatures *placement*, watermark, renderer | C6 (00 D7) |
| Referring doctors, affiliated hospitals, credit parties | C3 (00 E2 second half) |
| Patient OTP / report links / portal sessions | C6 (04 A9/A10) |
| Device tokens for bridge agents | C7 (04 A13) |
| Patient-app, partner-user and phlebotomy-app screens and flows | C16, C13, C17 (Phase 2/3). C2 owns the session kinds `partner`, `patient`, `staff_mobile` and their identity endpoints and `IdentityPort` methods (08 R10, §4.14; CR-C13-003, CR-C16-004, CR-C17-004 accepted-modified) |
| SaaS subscription billing of labs | DROP (01 §2) |
| HR/payroll | DROP (04 §12) |
| Writing IRD Annex content, legal text or templates | not built; tracking only (B6) |
| Online HIBP breached-password API, CAPTCHA services, foreign SSO | foreign touchpoints, B11 — not used |
| WebAuthn / hardware security keys | UNVERIFIED in GoTrue (see §10) — deferred, TOTP is the Phase 1 mechanism |

## 6. User stories and acceptance criteria

Conventions: every AC is a test (05-DoD §2). "Alpha"/"Beta" = synthetic tenants `tenant_a`/`tenant_b` (02-CV §11.2). Error codes are from 03 §8 unless marked (CR).

### Epic A — Authentication and sessions

**US-A1 Staff password login.** As a staff user I log in with email + password so that I can work.
- AC-A1.1 Given an active Alpha user without an MFA-required role and a correct password, When they submit the login form, Then the BFF sets cookie `__Host-lims_sid` with `HttpOnly; Secure; SameSite=Lax; Path=/`, no JWT is present in any browser-readable storage or response body, and the user lands on the shell home.
- AC-A1.2 Given a wrong password or an unknown email, When submitted, Then the response is `401 auth.login_failed` with identical body and a response-time difference ≤ 50 ms p95 between the two cases [CONV] (no account oracle).
- AC-A1.3 Given an Alpha user whose membership is locked and a correct password, When submitted, Then `403 auth.account_locked`, no session row is `active`, and the GoTrue session just created is signed out by job.
- AC-A1.4 Given a user of a suspended tenant, When submitted with a correct password, Then `403 identity.tenant_suspended`.
- AC-A1.5 Given 10 attempts for one account within 60 minutes, When the 11th arrives, Then `429 common.rate_limited` with `Retry-After`, and GoTrue is not called (04 §4).
- AC-A1.6 Given 5 consecutive failures for an account, When the next attempt arrives (right or wrong password), Then the API returns `401 auth.step_up_required` without verifying the password, until the account's failure window drops below 5, a password reset completes, or an admin unlocks (§3.3 of 03-APP-FLOW).
- AC-A1.6a Given 60 staff of one lab behind one public IP who all log in successfully within one minute, Then every login succeeds (no per-IP rejection; successful logins are never counted — 08 Addendum A1).
- AC-A1.6b Given 10 failed logins (any accounts) from one client IP within 10 minutes, When further attempts arrive from that IP, Then at most 5 attempts/min are processed for 30 minutes (excess → `429 common.rate_limited`), an `identity.auth_events` row `login_ip_throttled` is written (and survives the error responses, `ctx.commitOnError()` — 08 A19 P-42), the worker task `identity.notify_ip_throttle` creates an admin notice in every targeted tenant (tenants resolved from the failure window's e-mail HMACs, 08 A25 D-217) and the LIMS provider on-call is alerted. The IP is `ctx.clientIp`, the client IP seen by the public edge (08 A25 P-61), never the BFF's or nginx's.
- AC-A1.7 Given any login outcome, Then one `identity.auth_events` row is written with event type, IP, user agent, request id and (for unknown accounts) only an HMAC of the email (REQ-SEC-074); on a failure (4xx) the row is committed through `ctx.commitOnError()` (08 A19 P-42).

**US-A2 MFA challenge.** As a user with TOTP enrolled I enter a 6-digit code after my password.
- AC-A2.1 Given a correct password for a user with a verified TOTP factor, When submitted, Then the session is in state `mfa_pending` and every business API call with it is rejected (`403 auth.mfa_required`).
- AC-A2.2 Given `mfa_pending`, When a valid TOTP code is submitted, Then the session becomes `active` with `aal = aal2`.
- AC-A2.3 Given `mfa_pending`, When 5 invalid codes are submitted, Then the session is `revoked` (reason `mfa_failed`), `401 auth.mfa_invalid` is returned for each failure, the account failure counter is incremented each time, and each increment of `mfa_failed_attempts` survives its 401 (`ctx.commitOnError()`, 08 A19 P-42).

**US-A3 MFA enrolment.** As a user with an MFA-required role I must enrol TOTP before first PHI access (REQ-SEC-076).
- AC-A3.1 Given a user whose roles require MFA and who has no verified factor, When they log in, Then the session state is `mfa_enrolment_required` and any call other than the enrolment endpoints returns `403 identity.mfa_enrolment_required`.
- AC-A3.2 Given enrolment started, When the correct code from the authenticator is submitted, Then the factor is `verified`, the session becomes `active` at `aal2`, and an `mfa_enrolled` auth event is written.
- AC-A3.3 Given any user, When they open "My account → Security", Then they can enrol TOTP voluntarily.

**US-A4 Idle and absolute timeout.**
- AC-A4.1 Given tenant setting `idle_timeout_minutes = 15` and a session with no user-initiated request for 15 minutes (+≤60 s touch granularity), When the next request arrives, Then the BFF redirects to `/auth/session-expired` and the API rejects the session's JWT with `401 auth.session_expired`.
- AC-A4.2 Given a status-board page that polls every 30 s (background requests), When no user input occurs for the idle period, Then the session still expires (background requests do not extend idle).
- AC-A4.3 Given `absolute_session_hours = 12`, When 12 hours have passed since login, Then the session expires regardless of activity.
- AC-A4.4 Given an attempt to set `idle_timeout_minutes` to 10 or 45, Then `422 identity.setting_out_of_range`.

**US-A5 Logout and session revoke.**
- AC-A5.1 Given an active session, When the user logs out, Then the session row is `revoked` (reason `logout`), the cookie is cleared, and a later reuse of the old cookie or of the old access JWT is rejected (`401`).
- AC-A5.2 Given a user with two sessions, When they revoke the other one from "My sessions", Then that session's next request is rejected within one request (no wait for JWT expiry).
- AC-A5.3 Given a tenant admin with `identity.session.revoke`, When they revoke a staff user's session, Then the same applies and an access-log `session.revoke` entry is written.
- AC-A5.4 Given a revoke of the caller's own current session via the admin screen, Then `409 identity.self_action_forbidden` (CR) — use Logout instead.

**US-A6 Password policy and change.**
- AC-A6.1 Given a new password of 11 characters, Then `422 auth.password_policy_violation`.
- AC-A6.2 Given a password whose UTF-8 encoding exceeds 72 bytes, Then `422 auth.password_policy_violation` (bcrypt limit, REQ-SEC-060).
- AC-A6.3 Given a password whose SHA-1 is in the local breached list, Then `422 auth.password_breached` and no network call leaves Nepal (B11).
- AC-A6.4 Given a successful self password change, Then all of the user's other sessions are revoked (reason `password_change`) (REQ-SEC-065).

**US-A7 Forgot password.**
- AC-A7.1 Given any email (existing or not), When "forgot password" is submitted, Then the response is `202` with identical body and timing class; only for an existing active account is a recovery email enqueued.
- AC-A7.2 Given a recovery link older than 1 hour or already used, When opened, Then `400 auth.reset_token_invalid` with the same body as an unknown token (04 A12).
- AC-A7.3 Given a valid link, When a compliant new password is set, Then all other sessions are revoked, the account failure counter is cleared, and a `password_reset_completed` auth event is written.

**US-A8 Invitation acceptance.**
- AC-A8.1 Given an invitation email link, When opened within its validity, Then the user sets a password (policy applies) and, if their roles require MFA, must enrol TOTP before reaching the shell.
- AC-A8.2 Given an expired or used invitation, Then `400 auth.invite_invalid`.

### Epic B — Users, roles, centre scope (tenant admin)

**US-B1 Invite a user.**
- AC-B1.1 Given a tenant admin at `aal2`, When they invite `test.user.0042@example.test` with role `front_desk` and centres [A1], Then a membership in state `invited` exists, an invitation email job is enqueued, and an `audit_log` row records the change (C0 trigger).
- AC-B1.2 Given the same request replayed with the same `Idempotency-Key`, Then the original response is replayed with `Idempotent-Replayed: true` and no second membership exists.
- AC-B1.3 Given an email that already has an account (any tenant), Then `409 identity.user_exists` with the generic message "This email cannot be invited" (03-APP-FLOW §4.2 note on residual oracle).
- AC-B1.4 Given a tenant admin at `aal1` (MFA not completed), Then `403 auth.mfa_required` (privileged permission, 04 A4).
- AC-B1.5 Given a request body containing `tenant_id` or `permissions`, Then `400 common.validation_failed` (`common.unknown_field`) (REQ-SEC-080).

**US-B2 Roles.**
- AC-B2.1 Given a custom role containing any `privileged: true` permission, When saved, Then the role is stored with `mfa_required = true` regardless of the submitted flag.
- AC-B2.2 Given an attempt to add any `platform.*` permission or an actor-only permission (registry `roles: []`), Then `400 common.validation_failed` with `errors[].code = common.field_invalid` at `/permissions/<i>` (08 A13 P-1). (An unknown role id in `setUserRoles` returns `422 identity.role_unknown`.)
- AC-B2.3 Given the only active membership holding `identity.role.manage`, When an admin removes that role from it, deactivates it, or locks it, Then `409 identity.last_admin_protected`.
- AC-B2.4 Given a role change for a user, Then all that user's sessions are revoked (reason `role_change`) and the change appears in the audit log (REQ-SEC-065, REQ-SEC-096).

**US-B3 Centre scope.**
- AC-B3.1 Given a membership scoped to centre A1, When that user calls any module endpoint for an A2 object, Then the owning module returns `404 common.not_found` (RLS) and `IdentityPort.assertRole(..., {centreId: A2})` throws `auth.forbidden`.
- AC-B3.2 Given `all_centres = true`, Then `assertRole` passes for any centre of the tenant and for none of tenant Beta.
- AC-B3.3 Given assignment to an inactive centre, Then `409 identity.centre_inactive`.

**US-B4 Lock / unlock / deactivate.**
- AC-B4.1 Given an active user, When an admin locks them with a reason, Then within one request all their sessions fail (`403 auth.account_locked`), the lock appears in the audit log, and a GoTrue sign-out job runs.
- AC-B4.2 Given a locked user, When unlocked, Then they can log in again; their account failure counter is cleared.
- AC-B4.3 Given an admin trying to lock or deactivate themselves, Then `409 identity.self_action_forbidden` (CR).
- AC-B4.4 Given a deactivated membership, Then login returns `403 identity.membership_inactive` after a correct password, and the user no longer appears in assignable-user pickers of other modules (`ctx.core` filters `is_active`).

**US-B5 MFA reset.** Given a user who lost their phone, When an admin resets MFA, Then all factors are removed (GoTrue + mirror), all sessions revoked, and the next login requires enrolment if the role requires MFA.

**US-B6 Signatory profile.** Given a pathologist membership, When an admin sets title "MD Pathology", registration no "NMC-SYN-0001" and uploads a PNG signature, Then `IdentityPort.getActor` for that membership returns `signature { displayTitle, registrationNo, signatureImageRef }`, the image is stored privately under `{tenant_id}/signatures/…`, and an SVG upload is rejected `415 common.unsupported_media_type`.

### Epic C — Branches, centres, settings

**US-C1 Branches and centres.**
- AC-C1.1 Given an admin with `identity.centre.manage`, When creating centre code `C000000002` under branch `0001`, Then it is created; a duplicate code in the same tenant returns `409 identity.code_duplicate` (CR); the same code in Beta is allowed.
- AC-C1.2 Given a centre referenced by any record, When deactivated, Then it stays readable (master data never deleted, 02-CV §5.6) and is hidden from new-registration pickers.
- AC-C1.3 There is no limit on the number of users, branches or centres per tenant (00 §3 item 1).

**US-C2 Settings ranges.** Given the settings form, When values outside 04 ranges are submitted (idle ∉ 15–30, absolute ∉ 1–12, link TTL ∉ 30–90, retention clinical < 5, audit < 5, raw instrument < 1), Then `422 identity.setting_out_of_range` with the field pointer; within range, Then `IdentityPort.getTenantSettings` returns the new values within ≤ 30 s on every API instance [CONV cache TTL]. A `timezone` other than `Asia/Kathmandu` → `422 identity.setting_out_of_range` at `/timezone` (v1 rule, 08 A13 P-15).

**US-C3 Numbering patterns.**
- AC-C3.1 Given an invoice pattern without `{fy}` or `{fyl}`, Then `400 common.validation_failed` (counter resets every fiscal year — 04 L16; 03 §9.3).
- AC-C3.2 Given a registration pattern without `{branch}`, Then `400 common.validation_failed` (counter scope tenant + branch, 03 §9.3; C4 grammar applied by C2, 08 A13 D-23(1)).
- AC-C3.3 Given a tenant with `billing_live_on` set, When the invoice or credit-note pattern is changed, Then the new pattern is stored as *pending* with effect from the next Shrawan 1 and the current pattern stays in effect (DECISION, avoids a mid-year series change — 04 L7/L8, B6).

**US-C4 Branding.** Given a PNG logo ≤ 2 MB [CONV], When uploaded, Then it is magic-byte checked, re-encoded, malware-scanned and stored; `getTenantSettings(['branding'])` (CR-C2-008) returns `branding.logoAssetId`, and the content is read through `IdentityPort.readBrandingAsset` (08 §4.12, R21); until the malware scan has passed, the content read returns `422 common.upload_quarantined` (08 A17 P-19); previous assets remain readable for re-rendering old reports (REQ-ARCH-036).

**US-C5 Feature flags.**
- AC-C5.1 Given a new tenant, Then every B11 flag is off and the B13 `referral_incentive_report` flag is off (07-BLOCKERS B11/B13 defaults).
- AC-C5.2 Given a tenant admin, When they try to enable a B11 flag, Then `403 auth.forbidden` (platform-only flag).
- AC-C5.3 Given a platform superadmin enabling a B11 flag without a founder-approval reference, Then `400 common.validation_failed` at `/approval_ref` (08 A13 P-1).
- AC-C5.4 Given the B13 flag toggled by a tenant admin, Then `getTenantSettings(['referralIncentiveReportEnabled'])` reflects it.

### Epic D — Audit, access log, export

**US-D1 Audit list.** Given an admin with `audit.log.read`, When filtering by date range (≤ 31 days [CONV]), table, actor and action, Then a cursor-paginated list of metadata (no old/new values) is returned, newest first, containing zero rows of tenant Beta.
**US-D2 Audit detail.** Given an audit entry id, When opened, Then old/new values and changed columns are shown, and an `access_log` row `audit_entry.view` (entity `audit_entry`) is written for the viewer.
**US-D3 Access log + auth events.** Same filtering for `audit.access_log` and `identity.auth_events`.
**US-D4 Export (insider risk).**
- AC-D4.1 Given a user without `audit.log.export` (CR), Then `403 auth.forbidden`.
- AC-D4.2 Given a valid request, Then an export job is queued (`Idempotency-Key` required), metadata-only columns are exported (no old/new values, DECISION), every other active tenant admin sees an in-app notice, and `lims_identity_audit_exports_total` increments.
- AC-D4.3 Given a range > 31 days or an estimated row count > 500,000 [CONV], Then `422 identity.export_too_large` (CR).
- AC-D4.4 Given the 6th export by one user in 24 h or the 21st in a tenant [CONV], Then `429 common.rate_limited`.
- AC-D4.5 Given a ready export, When downloaded a 4th time or after 24 h [CONV], Then `404 common.not_found`; each download writes an `access_log` `audit_export.download` entry.
- AC-D4.6 Every CSV text cell passes `@lims/shared-ts/spreadsheet` `neutraliseFormula` (08 A13 P-9): cells beginning with `=`, `+`, `-`, `@`, tab, CR or `'` are prefixed with `'`, and `restoreNeutralised(neutraliseFormula(s)) === s`.

### Epic E — Platform console

**US-E1 Provision tenant.**
- AC-E1.1 Given a platform superadmin at `aal2` from an allowlisted IP, When they submit tenant code `synthetic_gamma`, legal name, first branch, first centre and first admin email, Then in one transaction: `core.tenants` (status `provisioning` — C0 value, 08 Addendum A3.3), branch, centre, the default roles of `contracts/permissions.yaml` `roles:` (03 §11; currently 10), `identity.tenant_settings` with defaults, all feature flags at defaults, IRD rows for annex_2/3/7 (`not_started`), and an invitation are created; the response is replayable by `Idempotency-Key`.
- AC-E1.2 Given a duplicate tenant code, Then `409 identity.code_duplicate` (CR).
- AC-E1.3 Given the tenant has an accepted tenant admin, ≥1 active branch and ≥1 active centre, When activated, Then status `active`; otherwise `409 identity.tenant_not_ready` (CR).

**US-E2 Suspend.** Given an active tenant, When suspended with reason, Then every staff session of that tenant fails on the next request (`403 identity.tenant_suspended`) and logins are refused.

**US-E3 IRD Annex tracker.**
- AC-E3.1 Given an Annex 3 record in `in_preparation`, When transitioned to `submitted` without `submitted_on`, Then `400 common.validation_failed` (08 A13 P-1).
- AC-E3.2 Given `submitted → completed` with `reference_no` and `completed_on`, Then saved; an `ird_annex_events` history row is appended.
- AC-E3.3 Given `not_started → completed` directly, Then `409 identity.annex_invalid_transition` (CR).
- AC-E3.4 Given tenant annex_2, annex_3, annex_7 `completed` and the platform annex_1 record for the current software listing `completed`, Then `getTenantSettings(['ird'])` returns `ird.annexReadiness = 'complete'` (CR-C2-008); otherwise `'incomplete'`. C2 never blocks billing itself; C4 decides how to use the flag.
- AC-E3.5 No screen or API emits legal text about the Annexes beyond the 04 L3/L4 descriptions and the BLOCKED B6 notice.

**US-E4 Support session.**
- AC-E4.1 Given platform support opens a support session for Alpha with reason and ticket ref, scope `read_only`, 30 minutes, and Alpha's `support_access_mode = notify`, Then the session is `active`, Alpha's admins see a banner and the event in the audit/access log, and the support user's API calls carry `support_session_id`.
- AC-E4.2 Given an active `read_only` support session, When the support user calls `inviteUser`, Then `403 auth.forbidden`.
- AC-E4.3 Given any support session, When the support user calls any non-identity module permission (e.g. `lab.result.read`), Then `403 auth.forbidden` (support permission allowlist, 03-APP-FLOW §8).
- AC-E4.4 Given `support_access_mode = approval_required`, Then the session stays `requested` until an Alpha tenant admin approves; denial or 24 h without approval ends it.
- AC-E4.5 Given expiry time reached, Then the next call returns `403 identity.support_session_required`.
- AC-E4.6 Given a platform user without an active support session calling a tenant endpoint, Then `403 identity.support_session_required`.

**US-E5 Dead letters.** Given an open dead letter, When a platform superadmin replays it, Then the job is re-enqueued with the same identifier and payload, state `replayed`, `resolved_by/at` set, and an auth/audit entry recorded; discard requires a reason, stored in `core.dead_letters.resolution_note` through `ctx.core.deadLetters.discard` (08 A8.4, A8.6); replay accepts an optional note (1–500 chars), stored the same way through `ctx.core.deadLetters.replay` (08 A9.3). The list filters by state, tenant, task and dead-at range (08 A9.2); the detail comes from `ctx.core.deadLetters.get` and an unknown id → `404 common.not_found` (08 A9.1). List and detail show `version` for If-Match and never the job payload (08 A8.5).

**US-E6 Platform staff.** Given a platform login from an IP outside the staff member's allowlist, Then `403 identity.platform_ip_denied` (CR) and an alert fires.

### Epic F — IdentityPort (contract, 03 §4.6)

**US-F1** The real implementation passes cases (1)–(12) of 03-IC §4.6 verbatim (incl. A4.2 `getStaffNotificationContact` cases (11)–(12)), plus C2 cases C2-1…C2-10 (02-TRD §7): C2-1 support-session actor limited to the allowlist; C2-2 session revoked mid-request-chain → next request `auth.session_expired`; C2-3 settings change visible within the cache TTL; C2-4 system actor holds exactly its worker-manifest permissions (CR-C2-013); C2-5 `getTenantSettings` never returns another tenant's values; C2-6 `updatePartnerMembership` without `expectedVersion` succeeds, with a stale one → `common.version_conflict` (08 A19 D-100); C2-7/C2-8 `readBrandingAsset` by a user actor → content, with a signature asset id → `common.not_found` (08 A13 D-26); C2-9 `readSignatureImage` for a system actor holding `identity.signatory.read` (08 A21.2); C2-10 non-staff `getTenantSettings` limited to `timezone`/`calendarDisplay` (08 A19 D-119).

### Epic G — Access review

**US-G1** Given a tenant admin, When they open Access review, Then they see every active membership with roles, centre scope, MFA status and last login, can export nothing from that screen, and can record "review completed" with notes; a banner appears when the last review is older than 90 days (REQ-SEC-140 quarterly).

## 7. Success metrics

| Metric | Target | Basis |
|---|---|---|
| Cross-tenant / cross-centre probe failures on C2 endpoints and tables | 0 (CI gate) | REQ-SEC-040, 05-DoD §1.5 |
| Privileged-role holders with verified TOTP before first PHI access | 100 % (enforced, not measured) | REQ-SEC-076 |
| Time from "staff left" to account disabled, tool path | ≤ 3 clicks, effect ≤ 1 request | REQ-SEC-140 |
| Login p95 (BFF → API → GoTrue) | ≤ 1.5 s [CONV] | 02-TRD §11 |
| Claims resolution + `assertRole` overhead per API request | p95 ≤ 5 ms [CONV] (03 §4.6: assertRole ≤ 2 ms, privileged ≤ 10 ms) | 03 §4.6 |
| Tenant provisioning by a platform admin | ≤ 10 minutes end-to-end [CONV] | — |
| Audit exports that did not raise a tenant notice | 0 | REQ-SEC-133 |

## 8. Phase

Phase 1 (04 §12: "roles, audit, masters"). Session kinds `partner`, `patient`, `staff_mobile`, their identity operations (`loginPartner`, `resolvePatientSession`, `logoutPatientSession`, `openMobileSession`, `refreshMobileSession`, `logoutMobileSession`) and the nine `IdentityPort` additions (seven of 08 §4.14, `getStaffNotificationContact` of A4.2, `readSignatureImage` of A21.2) are specified now (08 R10) and delivered with the consuming chunks' phases (C13 Phase 2, C16/C17 Phase 2–3).

## 9. Dependencies (contracts only)

| Dependency | Kind | What C2 needs | Until delivered |
|---|---|---|---|
| C0 core auth (JWT verify, context, `set_config`) | core | claims-resolver extension point, platform context (CR-C2-004/005) | C2 unit-tests resolver in isolation |
| C0 core (08 A25) | core/DDL | `ctx.db.identityAuthTx` + `tx.bindTenant` (D-212), `ctx.clientIp` from the trusted edge (P-61), platform idempotency store with `tenant_id` NULL (D-213), `withTenantScope` allowlist incl. support-session and dead-letter-view operations (D-214), `tg_row_audit` skips NULL-tenant rows (D-215), `core.users.email_hmac` (D-217) | C2 builds against the C0 fakes |
| C0 `ctx.core` repository, `core.*` DDL | DDL/core | columns in 05-SCHEMA §3 (CR-C2-003) | test DB from C0 seed + local migration copy in tests only |
| C0 `audit.*` tables, `ctx.audit.access` | DDL/core | columns + indexes (CR-C2-010) | fake `ctx.audit` |
| C0 rate-limit hooks (Redis/UNLOGGED fallback, 04 S11) | core | per-key sliding window API | in-memory fake |
| C0 storage adapter + upload pipeline | core | CR-C2-011/012 | fake storage |
| C0 BFF session plumbing | web core | CR-C2-009 | C2 uses MSW mock |
| `contracts/permissions.yaml`, `errors.yaml` | contracts | CR-C2-006/007 | local constants in tests |
| GoTrue (self-hosted, version pinned by C0/C1) | service | admin + password + MFA + recovery operations behind `GoTrueGateway` | in-module fake `GoTrueGateway` |
| C1 | infra | nginx per-IP login limit, GoTrue not publicly routed, SMTP relay for GoTrue (REQ-ARCH-018), token-URL log exclusion | — |

C2 **consumes no events and no ports** of other chunks, and **produces no events** (03 §3.25 lists none for identity). Other modules read core tables via `ctx.core` (03 §6 global note).

## 10. Blocked and unverified items, and the default built meanwhile

| Item | Status | Default built |
|---|---|---|
| B6 IRD submission checklist, Annex 7 template, cl.7 interpretation | BLOCKED | Tracker stores statuses, dates, reference numbers and uploaded documents only; UI shows "Requirements pending IRD clarification (B6)" |
| B11 foreign touchpoints (online HIBP, LLM API, CDN, WhatsApp PDF attachment) | BLOCKED (founder) | Flags exist, default off, platform-only, require founder-approval reference; HIBP not implemented (local list only) |
| B13 referral-incentive compliance | BLOCKED (client) | Tenant flag default off; report hidden |
| B15 legal retention | BLOCKED (counsel) | `retention_*` settings with floors 5/5/1 years (04 I8) |
| B17 / D16 "stored separately" | BLOCKED (IRD) | No C2 billing tables; tenant provisioning creates nothing in `billing` |
| Self-hosted GoTrue admin/MFA/recovery endpoint shapes for the pinned version | UNVERIFIED | All calls behind `GoTrueGateway`; task T1 verifies against pinned source and records the mapping in 02-TRD §8 |
| GoTrue custom access-token hook on self-hosted | not used (08 R10) | Claims are always resolved server-side by the identity `claimsResolver` (02-CV §6 as rewritten; 02-TRD §6). Only `session_id`/`aal`/`alg` of the pinned GoTrue are checked (C0 SP-1); a missing `session_id` blocks T1 |
| `aal` / `session_id` JWT claims | UNVERIFIED for the pinned version — proven by C0 SP-1 / C2 T1 (08 R10.6); hosted supabase.com docs (fetched 2026-11-05, not a research/04 source) describe them | T1 integration test asserts `aal2` after TOTP verify and a `session_id` claim |
| Refresh-token rotation/reuse detection self-hosted config (04 A6) | UNVERIFIED | Refresh serialised per session row lock; reuse failure → session revoked |
| GoTrue email-link TTL ≤ 1 h configurable (04 A12) | UNVERIFIED — C2 T1 verification and **release precondition** (08 A25 D-219, A25.2) | No LIMS-side fallback (the earlier issue-timestamp fallback had no storage and is deleted). If T1 refutes it, a CR adds `identity.recovery_requests` (class E) before release |
| Patient session kind: GoTrue user without e-mail, and an admin path that issues a session/access JWT for a credential-less user (08 A25 D-218) | UNVERIFIED — C2 T1 items, release precondition for the patient kind (A25.2) | Patient session kind blocked until T1 confirms; C16 builds against the fake resolver. If T1 refutes both, a CR to 08 R10 (LIMS-issued patient access JWT) goes to the lead and founder |
| WebAuthn / hardware key for platform superadmin (04 A4 "hardware key or TOTP") | UNVERIFIED (MFA docs page lists app authenticator and phone only) | TOTP + IP allowlist |
| Breached-password list source and licence (REQ-SEC-061) | UNVERIFIED | Import format and loader built; list file supplied by founder/C1 |
| PAN format | UNVERIFIED | Pattern configurable, default 9 digits flagged UNVERIFIED |
| Abbreviated-invoice limit (04 L9) | UNVERIFIED | Optional field, unset by default, UI label "UNVERIFIED — confirm with auditor" |
| Westgard default mode | pending C9 PRD (03 §4.6) | `classic` provisional [CONV], changeable by CR from C9 |

## 11. Open questions (to founder/client, non-blocking)

| # | Question | Default meanwhile |
|---|---|---|
| Q1 | Client's actual role model (who verifies, who approves, who cancels invoices) | 03 §11 default roles |
| Q2 | Should support access default to `approval_required` for all tenants? | `notify` [CONV] |
| Q3 | Default idle timeout 15 vs 30 min for reception PCs | 15 min [CONV] (strictest within 04 A8) |
| Q4 | Breached-password list source | none loaded until supplied; check is skipped with a warning metric (never silently "pass") |
| Q5 | May a person deactivated at one lab be invited by another lab with the same e-mail? (client question **C-07** in 08 §5.2; 08 A25 D-220) | **No in v1**: `inviteUser` keeps returning `409 identity.user_exists` for any existing `core.users` row in any tenant (03-APP-FLOW §4.2) |
