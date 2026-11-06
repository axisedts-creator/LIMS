# C2 — Identity, Access & Administration — 05 Schema (specification for C0-0B)

Status: DECISION draft, 2026-11-05. C0 writes all DDL (01 §0); this file is the spec. Conventions: 02-CV §5 (classes, mandatory columns, composite FKs, no ENUM types, RLS template, naming). PHI classes P0–P3 from 03 §1; **S** = secret/credential material (02-CV §9.2 "Credentials").

## 1. Scope

| Schema | Tables | Owner of DDL | Owner of logic |
|---|---|---|---|
| `identity` | 18 tables in §4 (16 with ENABLE + FORCE RLS + 2 global `g_*`) | C0 (from this spec) | C2 |
| `core` | tenants, branches, collection_centres, users, memberships, membership_centres, membership_branches, membership_roles, roles, role_permissions, dead_letters (C0 platform table) | C0 | C2 (admin logic), all modules read via `ctx.core` |
| `audit` | audit_log, access_log | C0 | C0 triggers/API; C2 viewer |
| `app` | helper + DEFINER functions in §6 | C0 | C2 specifies |

No identity table is centre-scoped (no `centre_id`); all tenant tables use `__tenant` policies, each with the staff-or-system guard (08 A17 P-16). Several tables hold **platform rows** (`tenant_id IS NULL`) visible only through `__platform` policies (§5.3); the one exception is the referenced platform Annex 1 row (§5.2, 08 A25 D-216). `db/meta/tables.yaml`: `identity.sessions` and `identity.mfa_factors` are `shared_with: [partner]` (their partner access is only the `__own` / `__own_user` policies of §5.2; 08 A19 D-101, A17 P-16).

## 2. Global rules for `identity`

- Owner `lims_owner`; `ENABLE` + `FORCE ROW LEVEL SECURITY` on every table except `g_*` (02-CV §5.8, listed in `db/tests/rls_exempt.txt`).
- `tenant_id` leads every index/unique constraint on tenant tables, **except** the globally-unique secret/identity lookups requested in CR-C2-017 (`sessions.token_sha256`, `sessions.gotrue_session_id`, `core.memberships(user_id)` for staff) and CR-C2-018 (partial `sessions.previous_token_sha256 WHERE previous_token_sha256 IS NOT NULL`, 08 Addendum A3.1). Rationale: these are looked up before a tenant is known, only through inventoried DEFINER functions, and the values are random secrets or one-tenant-per-user identities, so a unique violation is not a cross-tenant oracle reachable by clients.
- UUIDv7 ids generated in app code (04 D9); `user_id` / GoTrue ids are any-version UUIDs (03 §2.1 note).
- No DELETE grant to `lims_app` on any identity table. Expiry/purge runs through `lims_owner`-owned maintenance functions (§6.6; 02-CV §5.11).
- Money: `abbreviated_invoice_limit_paisa bigint` (02-CV §4.9).

## 3. Requirements on C0-owned `core` and `audit` tables (CR-C2-003, CR-C2-010)

C2 does not define these tables. §3.1 is a **mirror of C0 05-SCHEMA §10 — C0 wins on conflict** (08 Addendum A3.3; C0 owns `core.*` DDL, 01 §3). C2 code reads and writes `core.*` only through CoreRepository / ports as already specified. The columns C2 lifecycle logic needs (CR-C2-003 remainder) are merged into C0 05-SCHEMA §10 by 08 Addendum A3.4 and appear in the §3.1 mirror below; no C2-side `core` column proposal remains.

### 3.1 `core.*` — mirror of C0 05-SCHEMA §10 — C0 wins on conflict (CR-C2-003; 08 Addendum A3.3, A3.4)

"std M" = `version integer NOT NULL DEFAULT 1`, `is_active boolean NOT NULL DEFAULT true`, `created_at timestamptz NOT NULL DEFAULT now()`, `created_by uuid NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`, `updated_by uuid NOT NULL` (as written in C0 §10; `is_active` is a plain column there, **except on `core.memberships`**, where it is `GENERATED ALWAYS AS (status = 'active') STORED` and is never written — 08 A3.4). "std M (memberships)" = `version integer NOT NULL DEFAULT 1`, `is_active boolean GENERATED ALWAYS AS (status = 'active') STORED`, `created_at`, `created_by`, `updated_at`, `updated_by` as in std M. "link std" = `created_at timestamptz NOT NULL DEFAULT now()`, `created_by uuid NOT NULL`.

| Table | Columns (type, null, default) — C0 §10 | Keys / constraints / indexes — C0 §10 | Class |
|---|---|---|---|
| `core.tenants` | id uuid NOT NULL; tenant_code text NOT NULL; legal_name text NOT NULL; display_name text NOT NULL; status text NOT NULL DEFAULT `'provisioning'`; timezone text NOT NULL DEFAULT `'Asia/Kathmandu'`; status_reason text NULL; activated_at timestamptz NULL; suspended_at timestamptz NULL; offboarded_at timestamptz NULL; billing_live_on date NULL; std M | PK (id); `tenants__tenant_code__ck` `tenant_code ~ '^[a-z][a-z0-9_]{2,31}$'`; `tenants__names__ck` legal_name 1–200, display_name 1–120; `tenants__status__ck` status IN (`provisioning`,`active`,`suspended`,`offboarded`); `tenants__timezone__ck` 1–64 chars; `tenants__status_reason__ck` status_reason ≤ 500; UNIQUE INDEX `tenants__tenant_code__uq (tenant_code)` (global) | M (root) |
| `core.branches` | id uuid NOT NULL; tenant_id uuid NOT NULL; branch_code text NOT NULL; name text NOT NULL; address_text text NULL; phone_display text NULL; is_processing_lab boolean NOT NULL DEFAULT true; std M | PK (id); UNIQUE (tenant_id, id); FK tenant_id → tenants(id); `branches__branch_code__ck` `^[A-Za-z0-9-]{1,16}$`; `branches__text__ck` name 1–120, address_text ≤ 500, phone_display ≤ 40; UNIQUE INDEX (tenant_id, branch_code); INDEX (tenant_id, is_active) | M |
| `core.collection_centres` | id uuid NOT NULL; tenant_id uuid NOT NULL; branch_id uuid NOT NULL; centre_code text NOT NULL; name text NOT NULL; centre_kind text NOT NULL; address_text text NULL; phone_display text NULL; std M | PK (id); UNIQUE (tenant_id, id); FK tenant_id → tenants(id); FK (tenant_id, branch_id) → branches(tenant_id, id); `collection_centres__centre_code__ck` `^[A-Za-z0-9-]{1,16}$`; `collection_centres__kind__ck` centre_kind IN (`own`,`franchise`,`home_collection`); `collection_centres__text__ck` name 1–120, address_text ≤ 500, phone_display ≤ 40; UNIQUE INDEX (tenant_id, centre_code); INDEX (tenant_id, branch_id, is_active) | M |
| `core.users` | tenant_id uuid NOT NULL; id uuid NOT NULL (= GoTrue `sub`, any UUID version, no FK into `auth`); display_name text NOT NULL; staff_code text NULL; email_normalized text NULL; email_hmac bytea NULL (HMAC-SHA-256 of `email_normalized` with `LIMS_IDENTITY_EMAIL_HMAC_KEY`, written by C2 on user create and e-mail change; read only by `app.identity_tenants_for_email_hmacs` — 08 A25 D-217); phone_e164 text NULL; last_login_at timestamptz NULL; std M | PK (tenant_id, id); FK tenant_id → tenants(id); `users__text__ck` display_name 1–120, staff_code ≤ 32; `users__email_normalized__ck` email_normalized ≤ 254; `users__email_hmac__ck` `octet_length(email_hmac) = 32` (NULL passes; D-217); `users__phone_e164__ck` `phone_e164 ~ '^\+[1-9][0-9]{7,14}$'`; UNIQUE INDEX `users__tenant_id_email_normalized__uq (tenant_id, email_normalized)` | M |
| `core.memberships` | id uuid NOT NULL; tenant_id uuid NOT NULL; user_id uuid NOT NULL; actor_type text NOT NULL (no default); all_centres boolean NOT NULL DEFAULT false; status text NOT NULL DEFAULT `'active'`; invited_at timestamptz NULL; accepted_at timestamptz NULL; deactivated_at timestamptz NULL; deactivated_by uuid NULL; deactivation_reason_code text NULL; locked_at timestamptz NULL; locked_by uuid NULL; lock_reason_code text NULL; lock_reason_text text NULL; last_login_at timestamptz NULL; partner_role text NULL (08 A28.3: present iff `actor_type = 'partner'`, IN (`partner_admin`,`partner_member`); written by C2 in `provisionPartnerMembership` / `updatePartnerMembership(set_role)`, read by `app.identity_resolve_session`); signatory_display_title text NULL; signatory_registration_no text NULL; signature_image_ref text NULL (storage object path); std M (memberships) — `is_active` generated from `status`. **No `is_locked` column: locked = `locked_at IS NOT NULL`** (API `is_locked` / `ActorProfile.isLocked` are wire names computed from it, 08 A6.1) | PK (id); UNIQUE (tenant_id, id); FK (tenant_id, user_id) → users(tenant_id, id); `memberships__actor_type__ck` IN (`user`,`patient`,`partner`); `memberships__all_centres_user_only__ck` `actor_type = 'user' OR NOT all_centres` (08 R3); `memberships__lock__ck` `(locked_at IS NULL) = (locked_by IS NULL)`; `memberships__status__ck` status IN (`invited`,`active`,`deactivated`); `memberships__lock_reason__ck` lock_reason_code IN (`left_organisation`,`security_concern`,`policy_violation`,`other`); `memberships__deactivation_reason__ck` deactivation_reason_code IN (same four codes; 08 A6.3); `memberships__partner_role_presence__ck` `(actor_type = 'partner') = (partner_role IS NOT NULL)`, `memberships__partner_role__ck` `partner_role IN ('partner_admin','partner_member')` (08 A28.3); `memberships__text__ck` lock_reason_code ≤ 64, lock_reason_text ≤ 500, signatory_display_title ≤ 200, signatory_registration_no ≤ 40, signature_image_ref ≤ 512; partial UNIQUE INDEX `memberships__tenant_id_user_id_actor_type__p_uq (tenant_id, user_id, actor_type) WHERE status IN ('invited','active')`; partial UNIQUE INDEX `memberships__user_id__p_uq (user_id) WHERE actor_type = 'user' AND status IN ('invited','active')` (index-rule exception, 08 R27; CR-C2-017; predicate 08 A3.4) | M |
| `core.membership_centres` | tenant_id uuid NOT NULL; membership_id uuid NOT NULL; centre_id uuid NOT NULL; link std | PK (tenant_id, membership_id, centre_id); FK (tenant_id, membership_id) → memberships; FK (tenant_id, centre_id) → collection_centres; trigger `membership_centres__scope_user_only` (`app.tg_scope_user_only()`, SQLSTATE 23514 `scope_user_only`) | M (link) |
| `core.membership_branches` | tenant_id uuid NOT NULL; membership_id uuid NOT NULL; branch_id uuid NOT NULL; link std | PK (tenant_id, membership_id, branch_id); FK (tenant_id, membership_id) → memberships; FK (tenant_id, branch_id) → branches; trigger `membership_branches__scope_user_only`; explicit branch grants = `ActorProfile.branchIds`, application-level only, no RLS policy reads it (08 R3) | M (link) |
| `core.g_permissions` | code text NOT NULL; module text NOT NULL; privileged boolean NOT NULL; phase text NOT NULL; description text NULL; is_active boolean NOT NULL DEFAULT true; created_at timestamptz NOT NULL DEFAULT now() | PK (code); `g_permissions__code__ck` `^[a-z_]+\.[a-z_]+\.[a-z_]+$`; `g_permissions__phase__ck` IN (`1`,`1.5`,`2`,`3`) | G |
| `core.roles` | id uuid NOT NULL; tenant_id uuid NOT NULL; role_code text NOT NULL; display_name text NOT NULL; description text NULL; is_system_default boolean NOT NULL DEFAULT false; mfa_required boolean NOT NULL DEFAULT false; std M | PK (id); UNIQUE (tenant_id, id); FK tenant_id → tenants(id); `roles__role_code__ck` `^[a-z][a-z0-9_]{1,39}$`; `roles__text__ck` display_name 1–80, description ≤ 300; UNIQUE INDEX (tenant_id, role_code) | M |
| `core.role_permissions` | tenant_id uuid NOT NULL; role_id uuid NOT NULL; permission_code text NOT NULL; link std | PK (tenant_id, role_id, permission_code); FK (tenant_id, role_id) → roles; FK permission_code → g_permissions(code); `role_permissions__no_platform__ck` `permission_code NOT LIKE 'platform.%'`; INDEX `role_permissions__tenant_id_permission_code__idx (tenant_id, permission_code)` | M (link) |
| `core.membership_roles` | tenant_id uuid NOT NULL; membership_id uuid NOT NULL; role_id uuid NOT NULL; link std | PK (tenant_id, membership_id, role_id); FK (tenant_id, membership_id) → memberships; FK (tenant_id, role_id) → roles; INDEX `membership_roles__tenant_id_role_id__idx (tenant_id, role_id)` | M (link) |
| `core.dead_letters` (03 §12) | id uuid NOT NULL; tenant_id uuid NULL (platform tasks only); task_identifier text NOT NULL; job_payload jsonb NOT NULL; last_error_code text NOT NULL; last_error_message_redacted text NOT NULL; attempts integer NOT NULL; first_failed_at timestamptz NOT NULL; dead_at timestamptz NOT NULL; state text NOT NULL DEFAULT `'open'`; resolved_by uuid NULL; resolved_at timestamptz NULL; resolution_note text NULL (discard reason / optional replay note, 08 A8.4); version integer NOT NULL DEFAULT 1 (If-Match on replay/discard); created_at timestamptz NOT NULL DEFAULT now(); created_by uuid NOT NULL | PK (id); FK tenant_id → tenants(id); `dead_letters__state__ck` IN (`open`,`replayed`,`discarded`); `dead_letters__resolved__ck`; `dead_letters__msg__ck` ≤ 2000; `dead_letters__resolution_note__ck` `char_length(resolution_note) BETWEEN 1 AND 500` (08 A8.4); INDEX (state, dead_at); INDEX (tenant_id, state, dead_at); trigger `dead_letters__transition` (only `state`, `resolved_by`, `resolved_at`, `resolution_note`, `version` may change); `__select__platform`, `__update__platform` policies, tenant rows only (`tenant_id IS NOT NULL AND (SELECT app.is_platform_actor())`, 08 A10.4; NULL-tenant rows only through the C0 `app.dl_*` DEFINERs) (§5.3; C0 writes them, for `ctx.core.deadLetters` under platform claims — 08 A8.6). C2 never reads or writes this table with its own SQL: only through `ctx.core.deadLetters` (08 A8.6) | E |

API field names in 02-TRD (e.g. `code`, `name`, `kind`, `phone` on branch/centre/role bodies) are wire names; the repository maps them to the C0 columns above (`branch_code`/`centre_code`/`role_code`, `display_name`, `centre_kind`, `phone_display`). C2's API length limits that are tighter than the DDL (address ≤ 300, phone ≤ 30, signatory title ≤ 80) stay (08 §4.11 note).

**Lifecycle writes (08 A3.4).** C2 sets `core.memberships.status` (`invited` → `active` → `deactivated`, 03-APP-FLOW §2.2) and never writes `is_active`. Lock is orthogonal to status: `lockUser` sets `locked_at`/`locked_by`/`lock_reason_code`/`lock_reason_text`, `unlockUser` sets `locked_at` and `locked_by` to NULL (`memberships__lock__ck`); C2 logic and DEFINER SQL test `locked_at IS NOT NULL`. `deactivateUser` sets `deactivated_at`/`deactivated_by`/`deactivation_reason_code` (codes as `lock_reason_code`); `reactivateUser` sets `status = 'active'` and clears those three columns to NULL — history stays in `audit.audit_log` (08 A6.3); for a member who never accepted (M6, `status = 'invited'`) it also clears those three columns (08 A8.2). `terminateTenant` sets each membership it moves to `deactivated` with `deactivated_at = now()`, `deactivated_by` = the platform actor, `deactivation_reason_code = 'other'`; the reason text lives in `core.tenants.status_reason` (08 A8.3). The `core.tenants` end-state timestamp is `offboarded_at` (status `offboarded`); the `reason_text` of `suspendTenant`/`terminateTenant` is stored in `core.tenants.status_reason` (08 A6.3). The admin UI shows `core.memberships.last_login_at` (per tenant); `core.users.last_login_at` is internal (08 A6.3).

RLS for core tables (C0 writes; C2 requires): tenant tables `__tenant` for SELECT/INSERT/UPDATE, each with `(SELECT app.is_staff_or_system())` in USING and WITH CHECK (08 A17 P-16, A23.3; C0 05-SCHEMA §10); `core.tenants` SELECT `id = app.current_tenant_id()` + the guard; platform policies per §5.3; no DELETE policies (link tables: DELETE allowed for `lims_app` under `__tenant` because removing a role/centre link is a master-data association change, 02-CV §4.1 DELETE rule — C0 confirms; audited by trigger).

Audit triggers (C0 generic JSONB trigger, 04 D11) required on: all `core` tables above, and `identity.tenant_settings`, `identity.feature_flags`, `identity.invitations`, `identity.support_sessions`, `identity.ird_annex_records`, `identity.branding_assets`, `identity.access_reviews`, `identity.mfa_factors`. **Not** on `identity.sessions` (high churn, ciphertext; lifecycle captured in `identity.auth_events`). **Not** on `identity.platform_staff`, `identity.platform_events` or any other platform-only table (08 A12.5): `audit.audit_log.tenant_id` is NOT NULL, so their changes are recorded in `identity.platform_events` by the C2 service or DEFINER (§4.17). For `core.tenants` the C0 trigger uses the row's own `id` as `tenant_id` when no tenant claim is present (platform context; C0 05-SCHEMA §4.4, 08 A12.5). **NULL-tenant rows of the mixed tables (08 A25 D-215):** `app.tg_row_audit` writes **no** `audit_log` row (and does not raise) when the audited row's `tenant_id` is NULL and the table is not `core.tenants`. C2 therefore records those changes in `identity.platform_events` (§4.17): a platform-staff invitation (`identity.invitations`, `tenant_id` NULL) → `platform_staff_invited`; a platform-staff MFA factor (`identity.mfa_factors`) → `platform_mfa_enrolled` on verify, `platform_mfa_reset` on reset; an Annex 1 record (`identity.ird_annex_records`) → `annex_1_changed` on create, update and transition. Tenant rows of the same tables keep their normal `audit_log` rows (§11 test 27).

**Audit inside maintenance DEFINERs (08 A28.5, C0).** `identity.invitations` and `identity.support_sessions` are audited and expired by the no-claims maintenance DEFINERs `app.identity_expire_invitations()` / `app.identity_expire_support_sessions()`. C0's `app.tg_row_audit` audits such rows with `actor_type = 'system'`, `actor_id` NULL, `detail = {"maintenance": <function name>}` and the row's `tenant_id`; it raises `audit_context_missing` only when neither claims nor `app.maintenance` are present (found on the scratch run 2026-11-06; decided by A28.5; §11 test 33).

**Session helper (08 A20.2).** `app.current_lims_session_id()` (`nullif(claims ->> 'lims_session_id', '')::uuid`, INVOKER) is **C0 DDL** (C0 05-SCHEMA §4.3/§10, created with `app.is_platform_actor()` before any policy references it, `GRANT EXECUTE … TO lims_app, lims_api, lims_worker`). The `__own` policies of §5.2 call it; C2 no longer creates it (§5.1).

### 3.2 `audit.*` — mirror of C0 05-SCHEMA §10 — C0 wins on conflict (CR-C2-010; 08 A3.3)

C2 reads these tables (viewer, export) and never writes them except through `ctx.audit.access` and C0's trigger. Column names below are C0's.

| Table | Columns — C0 §10 | Keys / indexes — C0 §10 | Indexes C2 asks C0 to add (hand-off; 02-TRD §5.9 filters) |
|---|---|---|---|
| `audit.audit_log` (A) | id uuid NOT NULL; tenant_id uuid NOT NULL; centre_id uuid NULL; schema_name text NOT NULL; table_name text NOT NULL; row_id uuid NULL; action text NOT NULL (`audit_log__action__ck` IN `INSERT`,`UPDATE`,`DELETE`); changed_columns text[] NOT NULL DEFAULT '{}'; old_values jsonb NULL; new_values jsonb NULL; actor_id uuid NOT NULL; actor_type text NOT NULL; membership_id uuid NULL; support_session_id uuid NULL; request_id uuid NULL; client_ip inet NULL; user_agent text NULL (≤ 512, `audit_log__ua__ck`); occurred_at timestamptz NOT NULL DEFAULT now(); created_at timestamptz NOT NULL DEFAULT now(); created_by uuid NOT NULL | PK `(tenant_id, occurred_at, id)`; `audit_log__tenant_id_id__idx (tenant_id, id)`; `audit_log__tenant_id_table_row__idx (tenant_id, schema_name, table_name, row_id, occurred_at DESC)`; `audit_log__tenant_id_actor__idx (tenant_id, actor_id, occurred_at DESC)` | `(tenant_id, request_id)`; partial `(tenant_id, support_session_id, occurred_at DESC) WHERE support_session_id IS NOT NULL` |
| `audit.access_log` (A) | id uuid NOT NULL; tenant_id uuid NOT NULL (FK `core.tenants`); centre_id uuid NULL; actor_id uuid NOT NULL; actor_type text NOT NULL; membership_id uuid NULL; support_session_id uuid NULL; action text NOT NULL (FK `audit.g_cs_access_actions(code)`, `<entity>.<verb>` — 08 §4.4); entity_type text NOT NULL (1–40); entity_id uuid NULL; purpose_code text NULL (≤ 64); outcome text NOT NULL (`access_log__outcome__ck` IN `allowed`,`denied`); detail jsonb NOT NULL DEFAULT '{}' (≤ 4096 bytes; non-PHI keys only); request_id uuid NULL; client_ip inet NULL; user_agent text NULL (≤ 512); occurred_at timestamptz NOT NULL DEFAULT now(); created_at; created_by uuid NOT NULL | PK `(tenant_id, occurred_at, id)`; `(tenant_id, id)`; `(tenant_id, entity_type, entity_id, occurred_at DESC)`; `(tenant_id, actor_id, occurred_at DESC)`; `(tenant_id, action, occurred_at DESC)` | same two as `audit_log` |

RLS (C0 §10 wins): `audit_log__select__tenant` / `access_log__select__tenant` `USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))`; `access_log__insert__tenant` with the same predicate and the actor-specific `access_log__insert__{partner,portal,patient}` (08 A23.3); `audit_log` INSERT only through C0's trigger (`audit_log__insert__owner_only`); no UPDATE/DELETE. **Mismatch for the final sweep (not edited here):** CR-C2-010 requested the centre clause `AND (centre_id IS NULL OR (SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))` (cast per 08 A16.1) on both SELECT policies, so that centre-scoped admins and support sessions (whose `has_all_centres()` is false and centre ids empty) see only rows with `centre_id IS NULL` or in scope (07-SECURITY C-1, consistent with 02-TRD §7.4); C0 §10 does not carry it. Until it does, the C2 repository adds the same clause to its own `WHERE` [CONV: defence in depth only; the RLS gap is reported].
`support_session_id` is filled by the trigger from claims `support_session_id` (02-CV §5.10 claims).

## 4. `identity` tables

Column tables list: name · type · null · default · constraint · class(PHI). Mandatory columns per class (02-CV §5.2) are included in DDL (§10.1) and abbreviated here as "std".

### 4.1 `identity.sessions` — class E (BFF session records)

| Column | Type | Null | Default | Constraint / note | PHI |
|---|---|---|---|---|---|
| id | uuid | N | — | PK; = claims `lims_session_id` | P1 |
| tenant_id | uuid | Y | — | NULL ⇔ kind = platform | P1 |
| kind | text | N | — | `tenant_staff`, `platform`, `partner`, `patient`, `staff_mobile` (08 R10) | P0 |
| user_id | uuid | N | — | GoTrue sub | P1 |
| membership_id | uuid | Y | — | NOT NULL for every kind except `platform` | P1 |
| platform_staff_id | uuid | Y | — | NOT NULL when platform | P1 |
| gotrue_session_id | uuid | N | — | UNIQUE (CR-C2-017) | S |
| token_sha256 | bytea | N | — | length 32; UNIQUE (CR-C2-017); BFF cookie token, or the opaque app session token (patient, staff_mobile; rotated on every refresh) | S |
| previous_token_sha256 | bytea | Y | — | length 32 when set (`CHECK (previous_token_sha256 IS NULL OR octet_length(previous_token_sha256) = 32)`); partial UNIQUE WHERE NOT NULL (CR-C2-018 exception, 08 Addendum A3.1). On rotation (patient, staff_mobile) the old `token_sha256` moves here; only one previous token is kept. Read only by `app.identity_session_by_token`; a presented token matching it → session revoked (`token_reuse`) + auth event `session_token_reused` | S |
| state | text | N | — | `password_setup`, `mfa_pending`, `mfa_enrolment_required`, `active`, `revoked`, `expired` | P0 |
| aal | text | N | `'aal1'` | `aal1`, `aal2` | P0 |
| refresh_token_enc, access_token_enc | bytea | N | — | AES-256-GCM: 12-byte nonce ‖ ciphertext ‖ 16-byte tag | S |
| enc_key_id | text | N | — | ≤16 | P0 |
| access_expires_at | timestamptz | N | — | | P0 |
| idle_timeout_minutes | integer | N | — | 15–30 for tenant_staff/platform/partner; patient 1,440–43,200 (1–30 d, default 14 d); staff_mobile 60–720: the service sets it to the configured absolute lifetime in minutes (`LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS` × 60; no idle timeout, 04 A16) [CONV lower bound 1 h] | P0 |
| last_seen_at | timestamptz | N | now() | | P1 |
| idle_expires_at, absolute_expires_at | timestamptz | N | — | | P0 |
| mfa_failed_attempts | integer | N | 0 | 0–5 | P0 |
| support_session_id | uuid | Y | — | only platform sessions; FK identity.support_sessions(id) | P1 |
| client_ip | inet | Y | — | | P2 (personal) |
| user_agent | text | Y | — | ≤512 | P2 |
| revoked_at, revoked_by | timestamptz, uuid | Y | — | | P1 |
| app_instance_id, app_platform | uuid, text | Y | — | required ⇔ kind ∈ (patient, staff_mobile); platform `android`/`ios` | P1 |
| revoke_reason | text | Y | — | `logout`, `admin_revoke`, `self_revoke`, `password_change`, `role_change`, `lock`, `deactivate`, `tenant_suspended`, `mfa_failed`, `mfa_reset`, `refresh_failed`, `superseded`, `token_reuse` (08 R10 reuse detection) | P0 |
| expires_at | timestamptz | N | — | purge time = max(absolute_expires_at, coalesce(revoked_at, absolute_expires_at)) + 30 days | P0 |
| std | version, created_at, created_by, updated_at, updated_by | | | | |

Indexes: `sessions__tenant_id_membership_id_state__idx (tenant_id, membership_id, state)`; `sessions__tenant_id_state_last_seen_at__p_idx (tenant_id, last_seen_at DESC) WHERE state IN ('mfa_pending','mfa_enrolment_required','active','password_setup')`; `sessions__platform_staff_id__p_idx (platform_staff_id, state) WHERE kind = 'platform'`; `sessions__expires_at__idx (expires_at)`; UNIQUE token_sha256, gotrue_session_id; partial UNIQUE `sessions__previous_token_sha256__p_uq (previous_token_sha256) WHERE previous_token_sha256 IS NOT NULL` (CR-C2-018 exception, 08 Addendum A3.1; used only by the DEFINER `app.identity_session_by_token`).

### 4.2 `identity.mfa_factors` — class M (mirror of GoTrue factors)

| Column | Type | Null | Note | PHI |
|---|---|---|---|---|
| id | uuid | N | PK (our id) | P1 |
| tenant_id | uuid | Y | NULL for platform staff | P1 |
| user_id | uuid | N | | P1 |
| gotrue_factor_id | uuid | N | UNIQUE (tenant_id, gotrue_factor_id) | P1 |
| factor_type | text | N | `totp` | P0 |
| status | text | N | `unverified`, `verified`, `removed` | P0 |
| friendly_name | text | Y | ≤40 | P0 |
| verified_at, removed_at | timestamptz | Y | | P0 |
| removed_by | uuid | Y | | P1 |
| removal_reason | text | Y | `self`, `admin_reset`, `re_enrol` | P0 |
| std | version, is_active, created_*, updated_* | | | |

Index `mfa_factors__tenant_id_user_id_status__idx`. Never stores TOTP secrets. A NULL-tenant (platform staff) factor change gets no `audit_log` row; C2 writes `platform_events` `platform_mfa_enrolled` / `platform_mfa_reset` (08 A25 D-215, §3.1).

### 4.3 `identity.auth_events` — class A

| Column | Type | Null | Note | PHI |
|---|---|---|---|---|
| id | uuid | N | PK | P1 |
| tenant_id | uuid | Y | NULL for unknown accounts and platform staff | P1 |
| user_id, membership_id, platform_staff_id, session_id | uuid | Y | | P1 |
| event_type | text | N | CHECK list §4.3.1 | P0 |
| reason_code | text | Y | errors.yaml code or revoke reason | P0 |
| email_hmac | bytea | Y | HMAC-SHA-256(normalised email) — only for failures without a known user | P1 (pseudonymous) |
| client_ip | inet | Y | | P2 |
| user_agent | text | Y | ≤512 | P2 |
| request_id | uuid | Y | | P0 |
| occurred_at | timestamptz | N | | P0 |
| created_at, created_by | | | created_by = user id or identity system actor | |

4.3.1 `event_type` values: `login_failed`, `login_password_ok`, `login_succeeded`, `login_step_up_required`, `login_rate_limited`, `login_blocked_locked`, `login_blocked_inactive`, `login_blocked_tenant_suspended`, `login_blocked_ip`, `mfa_verified`, `mfa_challenge_failed`, `mfa_enrolled`, `mfa_factor_removed`, `mfa_reset`, `password_changed`, `password_reset_requested`, `recovery_link_opened`, `password_reset_completed`, `invite_sent`, `invite_link_opened`, `invite_accepted`, `session_revoked`, `session_expired_idle`, `session_expired_absolute`, `logout`, `refresh_failed`, `account_locked`, `account_unlocked`, `membership_deactivated`, `membership_reactivated`, `login_ip_throttled` (per-client-IP failure threshold reached — 08 Addendum A1; tenant-less row, `client_ip` set, `detail`-free; targeted tenants get an admin notice), `session_token_reused` (rotated app session token presented again → session revoked, 08 R10).
Indexes: `auth_events__tenant_id_occurred_at__idx (tenant_id, occurred_at DESC, id DESC)`; `auth_events__tenant_id_membership_id_occurred_at__idx`; `auth_events__tenant_id_event_type_occurred_at__idx`; `auth_events__occurred_at__idx (occurred_at DESC, id DESC)` for the platform-wide sign-in list `listPlatformAuthEvents` (PL-8; index-rule exception: platform-only cross-tenant read under `__platform`, listed in `db/meta/index-exceptions.yaml`; review C2 m#54).

### 4.4 `identity.invitations` — class M (state + PII redaction)

| Column | Type | Null | Note | PHI |
|---|---|---|---|---|
| id | uuid | N | PK | P1 |
| tenant_id | uuid | Y | NULL ⇔ platform staff invite | P1 |
| user_id | uuid | N | GoTrue user id | P1 |
| membership_id | uuid | Y | tenant invites | P1 |
| platform_staff_id | uuid | Y | platform invites | P1 |
| email | text | Y | ≤254; set to NULL by redaction 30 days after terminal state | P2 |
| status | text | N | `pending`, `sent`, `accepted`, `expired`, `revoked`, `failed` | P0 |
| attempt_no | integer | N | DEFAULT 1 | P0 |
| issued_at | timestamptz | Y | last link issue time (job) | P0 |
| expires_at | timestamptz | N | | P0 |
| accepted_at | timestamptz | Y | | P0 |
| last_error_code | text | Y | | P0 |
| invited_by | uuid | N | actor id | P1 |
| std | version, created_*, updated_* | | | |

Indexes: `invitations__tenant_id_membership_id__idx`, `invitations__tenant_id_status_expires_at__idx`.

### 4.5 `identity.platform_staff` — class M, platform-only rows (no tenant_id)

| Column | Type | Null | Note | PHI |
|---|---|---|---|---|
| id | uuid | N | PK | P1 |
| user_id | uuid | N | UNIQUE | P1 |
| email_normalized | text | N | ≤254 | P2 |
| display_name | text | N | ≤120 | P2 |
| role_code | text | N | `platform_superadmin`, `platform_support` (03 §11 platform_roles) | P0 |
| allowed_cidrs | cidr[] | N | DEFAULT '{}' (empty = only global list applies) | P2 |
| last_login_at | timestamptz | Y | | P1 |
| is_active | boolean | N | DEFAULT true | P0 |
| std | version, created_*, updated_* | | | |

RLS: `__platform` policies for `lims_app`, plus the owner policies of §5.4 for the DEFINERs that read it (`platform_staff__select__owner_only TO lims_owner USING (true)`, used by `app.is_platform_actor()` — a C0 function since 08 A15.6; 08 A10.5). Platform-level changes are recorded in `identity.platform_events` (§4.17) because `audit.audit_log.tenant_id` is NOT NULL; `app.tg_row_audit` is not attached to this table (08 A12.5).

### 4.6 `identity.tenant_settings` — class M (one row per tenant)

| Column | Type | Default | Range / rule | Editable by | Maps to `TenantSettings` | PHI |
|---|---|---|---|---|---|---|
| tenant_id | uuid PK | — | | — | — | P1 |
| calendar_display | text | `'AD'` | AD, BS, AD_BS, BS_AD (02-CV §13; 04 D12) | tenant, platform | calendarDisplay | P0 |
| timezone | text | `'Asia/Kathmandu'` | **only `'Asia/Kathmandu'` in v1** (08 A13 P-15; `tenant_settings__timezone__ck`; API → `422 identity.setting_out_of_range` at `/timezone`) | tenant, platform | timezone | P0 |
| idle_timeout_minutes | integer | 15 [CONV] | 15–30 (04 A8) | tenant, platform | idleTimeoutMinutes | P0 |
| absolute_session_hours | integer | 12 | 1–12 (04 A8 ≤12; lower bound [CONV]) | tenant, platform | absoluteSessionHours | P0 |
| password_min_length | integer | 12 | 12–64 (04 A3 floor) | tenant, platform | (internal) | P0 |
| support_access_mode | text | `'notify'` [CONV] | notify, approval_required | tenant, platform | (internal) | P0 |
| report_link_ttl_days | integer | 30 [CONV] | 30–90 (04 A10) | tenant, platform | reportLinkTtlDays | P0 |
| release_requires_payment | boolean | true [CONV] (00 D1 ticked) | | tenant, platform | releaseRequiresPayment | P0 |
| partial_release_allowed | boolean | false [CONV] | | tenant, platform | partialReleaseAllowed | P0 |
| letterhead_default | text | `'with'` | with, without | tenant, platform | letterheadDefault | P0 |
| numbering_prefix | text | `''` | `^[A-Z0-9]{0,8}$` | tenant, platform | used for `{prefix}` | P0 |
| patient_code_pattern | text | `'{prefix}{seq:8}'` | §6.1 of 03-APP-FLOW | tenant, platform | numbering.patientCodePattern | P0 |
| registration_no_pattern | text | `'{branch}{prefix}{seq:6}'` | must contain `{branch}` (C4 grammar applied by C2, 08 A13 D-23(1)) | tenant, platform | numbering.registrationNoPattern | P0 |
| barcode_pattern | text | `'{prefix}{yy}{seq:8}'` (08 A13 D-8: client format `E1100001677`) | `[A-Z0-9]` literals, ≤20 rendered | tenant, platform | numbering.barcodePattern | P0 |
| invoice_no_pattern | text | `'{fy}-{seq:6}'` | must contain `{fy}`/`{fyl}` | tenant (until billing live), platform | numbering.invoiceNoPattern | P0 |
| credit_note_no_pattern | text | `'CN-{fy}-{seq:6}'` | same | same | numbering.creditNoteNoPattern | P0 |
| receipt_no_pattern | text | `'RC-{fy}-{seq:6}'` | same | tenant, platform | numbering.receiptNoPattern (CR-C2-008) | P0 |
| barcode_prefix | text NULL | — | `^[A-Z0-9]{0,4}$` | tenant, platform | numbering.barcodePrefix (CR-C5-009) | P0 |
| accession_no_pattern | text | `'{prefix}{yy}-{seq:4}'` | C11 grammar (CR-C11-005) | tenant, platform | numbering.accessionNoPattern | P0 |
| accession_prefix_histology, accession_prefix_cytology, accession_prefix_ihc, accession_prefix_molecular | text | `'S'`, `'C'`, `'I'`, `'M'` | `^[A-Z0-9]{0,4}$` | tenant, platform | numbering.accessionPrefixes.* | P0 |
| pending_invoice_no_pattern, pending_credit_note_no_pattern | text NULL | — | | system | — | P0 |
| pending_effective_fy_bs | text NULL | — | `^[0-9]{4}/[0-9]{2}$` (e.g. `2083/84`) | system | — | P0 |
| whatsapp_enabled, sms_enabled, email_enabled | boolean | false [CONV] | | tenant, platform | channels.* | P0 |
| sms_sender_id | text NULL | — | `^[A-Za-z0-9]{1,11}$` [CONV] | tenant, platform | channels.smsSenderId | P0 |
| retention_clinical_years | integer | 5 | ≥5, ≤50 (04 I8, B15) | tenant, platform | retentionYears, retention.clinicalYears | P0 |
| retention_audit_years | integer | 5 | ≥5, ≤50 | tenant, platform | retention.auditYears | P0 |
| retention_raw_instrument_years | integer | 1 | ≥1, ≤50 | tenant, platform | retention.rawInstrumentYears | P0 |
| auto_verification_enabled | boolean | false | (04 R2 Phase 2) | tenant, platform | autoVerificationEnabled | P0 |
| westgard_mode | text | `'classic'` (provisional, pending C9 PRD) | classic, modern (04 L23) | tenant, platform | westgardMode | P0 |
| ird_pan | text NULL | — | `LIMS_IDENTITY_PAN_PATTERN` (UNVERIFIED) | platform | ird.pan | P0 (business id) |
| cbms_realtime_required | boolean | false | 04 L6/L26 | tenant, platform | ird.cbmsRealtimeRequired | P0 |
| abbreviated_invoice_limit_paisa | bigint NULL | — | ≥0 (04 L9 UNVERIFIED) | tenant, platform | ird.abbreviatedInvoiceLimitPaisa | P0 |
| ird_annex_1_record_id | uuid NULL | — | FK identity.ird_annex_records(id) where tenant_id IS NULL | platform | (readiness) | P0 |
| legal_name_snapshot | text | from core.tenants | ≤200 | platform (via updateTenant) | branding.legalName | P0 |
| display_name | text | from provisioning | 1–120 | tenant, platform | branding.displayName | P0 |
| address_lines | text[] | `'{}'` | ≤ 4 lines, each ≤ 120 | tenant, platform | branding.addressLines (08 §4.12) | P0 |
| phones | text[] | `'{}'` | ≤ 3 display strings, each ≤ 40 | tenant, platform | branding.phones | P0 |
| contact_email | text NULL | | ≤254 | tenant, platform | branding.contactEmail | P0 |
| website | text NULL | | ≤200, `^https://` | tenant, platform | branding.website | P0 |
| logo_asset_id, letterhead_header_asset_id, letterhead_footer_asset_id | uuid NULL | | FK (tenant_id, id) → branding_assets | tenant, platform | branding.logoAssetId / letterheadHeaderAssetId / letterheadFooterAssetId (asset ids, read via `IdentityPort.readBrandingAsset`; 08 R21) | P0 |
| receipt_footer_note | text NULL | | ≤ 200 | tenant, platform | branding.receiptFooterNote (CR-C4-009 merged) | P0 |
| accent_color | text NULL | | `^#[0-9A-Fa-f]{6}$` | tenant, platform | branding.accentColor (CR-C0-009 merged) | P0 |
| std | version, created_*, updated_* | | | | | |

`referralIncentiveReportEnabled` = `feature_flags['referral_incentive_report']`; `ird.annexReadiness` computed (03-APP-FLOW §2.5).

### 4.7 `identity.feature_flags` — class M

| Column | Type | Null | Note |
|---|---|---|---|
| tenant_id | uuid | N | PK part |
| flag_code | text | N | PK part; FK identity.g_feature_flags(code) |
| is_enabled | boolean | N | |
| approval_ref | text | Y | ≤200; CHECK: required when enabled and flag requires founder approval (enforced in app + trigger §10.1) |
| version, created_*, updated_* | | | |

### 4.8 `identity.g_feature_flags` — class G (global registry, seeded by migration)

Columns: code text PK `^[a-z][a-z0-9_]{2,63}$`; description text; scope text CHECK (tenant, platform); settable_by text CHECK (tenant, platform); requires_founder_approval boolean; default_enabled boolean; blocker_ref text NULL; is_active boolean; created_at.

Seed (§8): see table there.

### 4.9 `identity.g_breached_passwords` — class G

Columns: sha1 bytea PK (CHECK length = 20); list_version text NOT NULL; created_at. Loaded only by the owner-role functions `app.identity_load_breached_batch(p_hashes bytea[], p_version text)` and `app.identity_finish_breached_import(p_version text)` (§6). Read by `lims_app` through `app.identity_is_breached(p_sha1 bytea) RETURNS boolean` (INVOKER, `lims_app` has SELECT; DDL §10.3) — simple PK lookup.

### 4.10 `identity.branding_assets` — class M (immutable content; `is_active` toggles)

| Column | Type | Null | Note | PHI |
|---|---|---|---|---|
| id | uuid | N | PK | P1 |
| tenant_id | uuid | N | | P1 |
| kind | text | N | logo, letterhead_header, letterhead_footer, signature | P0 |
| membership_id | uuid | Y | required ⇔ kind = signature; FK (tenant_id, membership_id) → core.memberships | P1 |
| bucket | text | N | `'identity-assets'` (08 R26) | P0 |
| object_path | text | N | `{tenant_id}/branding/{id}.{ext}` or `{tenant_id}/signatures/{membership_id}/{id}.{ext}`; CHECK starts with tenant_id::text | P0 (signature images: P2 — "signature image" is a direct identifier, 02-CV §9.2) |
| content_type | text | N | image/png, image/jpeg | P0 |
| size_bytes | integer | N | ≤ 2 MB (signature ≤ 1 MB) | P0 |
| width_px, height_px | integer | N | ≤4000 | P0 |
| sha256 | bytea | N | length 32 | P0 |
| is_active | boolean | N | | P0 |
| scan_state | text | N | DEFAULT `'pending'`; `pending`, `clean`, `quarantined` (08 A17 P-19): from `ctx.uploads.accept` (`clean` → `clean`; `pending`/`unavailable` → `pending` + job `identity.rescan_upload`; `infected` → upload rejected `422 common.upload_quarantined`, or `quarantined` when a re-scan finds it); content is served only when `clean` | P0 |
| std | version, created_*, updated_* | | | |

Mutable columns (trigger `app.enforce_mutable_columns`): `is_active, scan_state, updated_at, updated_by, version`.
Index: `branding_assets__tenant_id_kind_is_active__idx`, `branding_assets__tenant_id_membership_id__p_idx WHERE membership_id IS NOT NULL`.

### 4.11 `identity.support_sessions` — class E/M (state) — target-tenant rows

| Column | Type | Null | Note |
|---|---|---|---|
| id | uuid | N | PK; claims `support_session_id` |
| tenant_id | uuid | N | target tenant |
| platform_staff_id | uuid | N | FK identity.platform_staff(id) |
| scope | text | N | read_only, admin |
| reason_text | text | N | 10–500 (platform UI warns: no patient details) |
| ticket_ref | text | N | 1–60 |
| duration_minutes | integer | N | 5–60 |
| status | text | N | requested, approved, denied, active, ended, expired, revoked |
| requested_at | timestamptz | N | |
| decided_at | timestamptz | Y | |
| decided_by_membership_id | uuid | Y | FK (tenant_id, …) → core.memberships |
| decision_note | text | Y | ≤500 |
| started_at, expires_at, ended_at | timestamptz | Y | |
| ended_by | uuid | Y | |
| end_reason | text | Y | ended_by_staff, expired, revoked_by_tenant, superseded, platform_logout, denied (= DDL `support_sessions__end_reason__ck`) |
| std | version, created_*, updated_* | | |

Indexes: `support_sessions__tenant_id_status_requested_at__idx`, `support_sessions__tenant_id_expires_at__p_idx WHERE status = 'active'`, `support_sessions__platform_staff_id_status__idx (platform_staff_id, status)` (platform list; CR-C2-017 not needed — platform policy path).

### 4.12 `identity.ird_annex_records` — class M (state)

| Column | Type | Null | Note |
|---|---|---|---|
| id | uuid | N | PK |
| tenant_id | uuid | Y | NULL ⇔ annex_code = annex_1 (platform-level) |
| annex_code | text | N | annex_1, annex_2, annex_3, annex_7 (04 L3/L4) |
| status | text | N | not_started, in_preparation, submitted, completed, rejected, superseded |
| reference_no | text | Y | ≤100 |
| office_name | text | Y | ≤200 (tax office, Annex 3) |
| counterparty_name | text | Y | ≤200 (DC operator, Annex 7) |
| software_version | text | Y | ≤40 (Annex 1) |
| submitted_on, completed_on | date | Y | A.D. dates (B.S. display only) |
| notes | text | Y | ≤2000; no PHI |
| supersedes_id | uuid | Y | previous record |
| std | version, is_active, created_*, updated_* | | |

Constraints: CHECK `(annex_code = 'annex_1') = (tenant_id IS NULL)`; CHECK `status NOT IN ('submitted','completed','rejected') OR submitted_on IS NOT NULL` (= DDL `ird_annex_records__submitted__ck`); CHECK `status <> 'completed' OR (completed_on IS NOT NULL AND reference_no IS NOT NULL)`; partial UNIQUE `(tenant_id, annex_code) WHERE status <> 'superseded' AND tenant_id IS NOT NULL` (one current record per tenant+annex).
Indexes: `ird_annex_records__tenant_id_annex_code__idx`, `ird_annex_records__annex_code_status__p_idx WHERE tenant_id IS NULL`.

### 4.13 `identity.ird_annex_events` — class A
Columns: id, tenant_id NULL, record_id (FK), from_status, to_status, note ≤1000, actor_id, occurred_at, created_at, created_by. Index `(record_id, occurred_at)`; `(tenant_id, occurred_at DESC)`.

### 4.14 `identity.ird_annex_documents` — class M (immutable content; only `scan_state` changes) [CONV: was class A; P-19 needs one updatable column and 08 A17 P-18(a) forbids updates of class A rows]
Columns: id, tenant_id NULL, record_id, bucket (`identity-assets`; platform-level documents under `platform/ird/…`, readable only in platform context — 08 R26), object_path (`{tenant_id or 'platform'}/ird/{record_id}/{id}.{ext}`), original_filename ≤200 (metadata only, 02-CV §10.2), content_type (application/pdf, image/png, image/jpeg), size_bytes ≤ 15 MB, sha256, scan_state (`pending`, `clean`, `quarantined`; DEFAULT `'pending'`; P-19 — re-scanned on download in platform context, 02-TRD §5.10), uploaded_by, created_at, created_by. Index `(record_id, created_at)`. Trigger `app.enforce_mutable_columns('scan_state')`: nothing else may change.

### 4.15 `identity.audit_exports` — class E

| Column | Type | Null | Note |
|---|---|---|---|
| id | uuid | N | PK |
| tenant_id | uuid | N | |
| requested_by_membership_id | uuid | N | FK composite → core.memberships |
| source | text | N | audit_log, access_log, auth_events |
| filters | jsonb | N | validated filter object (ids, codes, dates only — no PHI) |
| range_from, range_to | timestamptz | N | span ≤ 31 days (CHECK `range_to > range_from AND range_to - range_from <= interval '31 days'`) |
| status | text | N | queued, building, ready, failed, expired |
| row_count | integer | Y | ≤ 500000 |
| object_path | text | Y | `{tenant_id}/{yyyy}/{mm}/{id}.csv` (bucket `identity-exports`, 08 R26) |
| sha256 | bytea | Y | |
| size_bytes | bigint | Y | |
| downloads_remaining | integer | N | DEFAULT 3 |
| ready_at, expires_at, last_downloaded_at | timestamptz | Y | |
| error_code | text | Y | |
| std | version, created_*, updated_* | | |

Indexes: `audit_exports__tenant_id_created_at__idx (tenant_id, created_at DESC)`, `audit_exports__tenant_id_requested_by_membership_id_created_at__idx` (quota count), `audit_exports__status_expires_at__p_idx WHERE status = 'ready'` (purge; maintenance function). Rows with status `expired` or `failed` are deleted 1 year after `created_at` by `app.identity_expire_audit_exports()` (§9; 08 A17 P-18(c) cross-tenant purge).

### 4.16 `identity.access_reviews` — class A
Columns: id, tenant_id, reviewed_by_membership_id, memberships_reviewed int ≥0, notes ≤2000, reviewed_at, created_at, created_by. Index `(tenant_id, reviewed_at DESC)`.

### 4.17 `identity.platform_events` — class A, platform-only (tenant_id always NULL)
Columns: id, event_type (`platform_staff_invited`, `platform_staff_changed`, `platform_staff_deactivated`, `platform_mfa_enrolled` (08 A25 D-215), `platform_mfa_reset`, `platform_session_revoked`, `annex_1_changed`, `ird_document_downloaded` [CONV; 02-TRD §5.10], `dead_letter_viewed`, `dead_letter_replayed`, `dead_letter_discarded`, `bootstrap_admin_created`, `tenant_provisioned`, `tenant_status_changed`, `feature_flag_changed`, `support_session_changed`), target_type text, target_id uuid, target_tenant_id uuid NULL, detail jsonb (non-PHI), actor_platform_staff_id, request_id, client_ip, occurred_at, created_at, created_by. Index `(occurred_at DESC)`, `(target_tenant_id, occurred_at DESC)`.

### 4.18 `identity.admin_notices` — class E (in-app notices to tenant admins)
Columns: id, tenant_id, kind (`support_session_requested`, `support_session_started`, `audit_export_created`, `access_review_due`, `login_ip_throttled` — 08 Addendum A1), subject_type (`support_session`, `audit_export`, `access_review`, `auth_event`), subject_id (NULL only for kind `login_ip_throttled`, `admin_notices__subject__ck`; the throttle's auth event is tenant-less and not readable by the tenant — 08 A25 D-217), created_for_membership_id NULL (NULL = all admins), dismissed_by uuid[] DEFAULT '{}', expires_at, version, created_at, created_by, updated_at, updated_by. Index `(tenant_id, created_at DESC)`. No PHI in any column. (02-TRD endpoint for listing/dismissing: `listAdminNotices` GET `/notices`, `dismissAdminNotice` POST `/notices/{notice_id}/dismiss`, permission `identity.user.read` — added to the spec with this table.)

## 5. RLS policies

### 5.1 Helpers used (C0; new ones in CR-C2-004/005)

`app.current_tenant_id()`, `app.current_actor_id()`, `app.current_claims()` (02-CV §5.8); `app.is_platform_actor()` (CR-C2-004) — **C0 DDL** since 08 A15.6 (C0 05-SCHEMA §10, context helpers, created before any policy that references it, `GRANT EXECUTE … TO lims_app`; C0 §4.3 inventory). Its contract: `true` exactly when the claims carry `scope = 'platform'`, `aal = 'aal2'` and a `platform_staff_id` whose `identity.platform_staff` row is active and has `user_id` = claims `sub`; otherwise `false`. It reads `identity.platform_staff` through `platform_staff__select__owner_only` (§5.4, §10.1). C2 keeps its contract tests (§11 tests 3 and 21). `app.current_lims_session_id()` (used by the `__own` policies below) is also **C0 DDL** since 08 A20.2 (C0 05-SCHEMA §10, INVOKER, `nullif(app.current_claims() ->> 'lims_session_id', '')::uuid`, EXECUTE `lims_app`, `lims_api`, `lims_worker`); C2 no longer creates it. `app.is_staff_or_system()` (C0, INVOKER: `actor_type IN ('user','system','device')`) is the P-16 guard.

### 5.2 Tenant policies (template `__tenant`, 02-CV §5.8 without the centre clause)

**`pred_t` = `tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())`** — in USING and WITH CHECK of **every** `__tenant` policy below (08 A17 P-16; R10 item 5). Partner, patient and portal claims carry a `tenant_id` but never pass the guard; the only non-staff access to an identity table is the `__own` / `__own_user` policies of `sessions` and `mfa_factors` (both `shared_with: [partner]` in `db/meta/tables.yaml`; 08 A19 D-101) — §11 test 26. DDL: the generator block in §10.1 (one statement per table and command).

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| sessions | `__tenant` + `__own` + `__own_user` | `__tenant` (08 A25 D-212; `__own` kept but unused by the pre-auth paths) | `__tenant` + `__own` + `__own_user` | none |
| mfa_factors | `__tenant` + `__own` | `__own` + `__tenant` | `__own` + `__tenant` | none |
| auth_events | `__tenant` | `__tenant` (tenant_id = current) | none | none |
| invitations | `__tenant` | `__tenant` | `__tenant` | none |
| tenant_settings | `__tenant` | `__tenant` (provisioning via withTenantScope) | `__tenant` | none |
| feature_flags | `__tenant` | `__tenant` | `__tenant` | none |
| branding_assets | `__tenant` | `__tenant` | `__tenant` (is_active, scan_state only, trigger) | none |
| support_sessions | `__tenant` | none (platform only) | `__tenant` (approve/deny/revoke) | none |
| ird_annex_records | `__tenant` (read-only for tenant) + `__tenant_platform_ref` (08 A25 D-216) | none | none | none |
| ird_annex_events, ird_annex_documents | `__tenant` | none | none | none |
| audit_exports | `__tenant` | `__tenant` | `__tenant` | none |
| access_reviews | `__tenant` | `__tenant` | none | none |
| admin_notices | `__tenant` | `__tenant` | `__tenant` | none |
| platform_staff, platform_events | none | none | none | none |

`__own` policies (the caller's own current session; no guard — partner sessions use them):
```sql
-- USING / WITH CHECK
id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
  AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id())
-- for mfa_factors: user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id())
```
`__own_user` (all sessions of the calling user in the calling tenant — `listOwnSessions` / `revokeOwnSession` for a partner, 08 A19 D-101; no guard): `user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id())`. SELECT is the reviewer's `sessions__select__own_user`; the UPDATE twin `sessions__update__own_user` is added because `revokeOwnSession` updates another of the user's own sessions [CONV].

`ird_annex_records__select__tenant_platform_ref` (08 A25 D-216; verbatim): `FOR SELECT TO lims_app USING (tenant_id IS NULL AND annex_code = 'annex_1' AND id = (SELECT ts.ird_annex_1_record_id FROM identity.tenant_settings ts WHERE ts.tenant_id = (SELECT app.current_tenant_id())) AND (SELECT app.is_staff_or_system()))` — tenant claims see exactly the Annex 1 row their settings reference, no other platform row (§11 test 2).

**Admitting policy of each pre-auth / session write (08 A25 D-212).** The §5.1 operations of 02-TRD run in `ctx.db.identityAuthTx`: claims `{sub: <identity system actor>, actor_type: 'system'}`, no `tenant_id`, until the handler calls `tx.bindTenant(tenantId)` once; then claims are `{…, tenant_id}` and `pred_t` admits the identity system actor (`is_staff_or_system()` is true for `system`).

| Write | Before `bindTenant` (no tenant) | After `bindTenant(tenant)` |
|---|---|---|
| Lookups (`app.identity_login_context`, `app.identity_session_by_token`, `app.identity_resolve_session`, `app.identity_user_exists`) | DEFINER, owner policies of §5.4 | — |
| `identity.auth_events` | tenant-less rows only, through `app.identity_record_auth_event` (`auth_events__insert__owner_only`) — failures of unknown accounts, `login_rate_limited`, `login_ip_throttled`, `password_reset_requested`, platform-staff events | `auth_events__insert__tenant` |
| `identity.sessions` INSERT (`loginStaff`, `loginPartner`, `openMobileSession`, `confirmEmailToken`) | — | `sessions__insert__tenant` |
| `identity.sessions` UPDATE (touch, refresh/rotation, `mfa_failed_attempts`, state, revoke, logout; `verifyMfaChallenge`, `resolveSession`, `logoutSession`, `refreshMobileSession`, `logoutMobileSession`, `resolvePatientSession`, `logoutPatientSession`, `setPasswordFromSetup`) | — | `sessions__select__tenant` + `sessions__update__tenant` |
| `identity.mfa_factors` (`startMfaEnrolment`, `completeMfaEnrolment`) | — | `mfa_factors__{select,insert,update}__tenant` |
| `identity.invitations` (`setPasswordFromSetup` → `accepted`) | — | `invitations__{select,update}__tenant` |
| `core.memberships` (M2 `accepted_at`/`status`, `last_login_at`), `core.users.last_login_at` | — | C0 `memberships__*__tenant`, `users__*__tenant` (guarded `pred_t`) |
| job enqueue (`identity.gotrue_signout`, `identity.send_recovery`, `identity.notify_ip_throttle`) | platform tasks (no tenant) | tenant tasks (claims `tenant_id` = job tenant, A23.1) |

**Platform-staff writes (08 A28.1).** A platform staff login has no tenant to bind. During authentication (the §5.1 operations, inside `identityAuthTx`) every platform-row write goes through a C2 DEFINER of §6 — `app.identity_platform_auth_write_session_insert` (`loginStaff` / `confirmEmailToken`), `…_session_update` (`verifyMfaChallenge`, `resolveSession` touch/refresh/expiry/revoke, `logoutSession`, `setPasswordFromSetup`, support binding), `…_mfa_factor` (`startMfaEnrolment`, `completeMfaEnrolment`), `…_invitation_accept` (`setPasswordFromSetup`), `…_staff_login` (`platform_staff.last_login_at`). Each sets `app.pre_user_id` to the platform staff user that the preceding lookup DEFINER identified; the owner policies (§5.4) match `tenant_id IS NULL AND user_id = app.pre_user_id` (`platform_staff`: `user_id = app.pre_user_id`). Tenant-less auth events keep using `app.identity_record_auth_event`. After login, the platform-context operations of 02-TRD §5.10 (bearerJwt with platform claims) write platform rows under the `__platform` policies `USING / WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()))` (§5.3, §10.1).

**Patient-context port writes (08 A28.2).** `IdentityPort.provisionPatientMembership`, `openPatientSession` and `revokePatientSessions` run their writes inside `ctx.db.withTenantScope(ctx.tenantId, <identity system actor>)` (08 R10 item 4 as extended by A28.2), so they pass the guarded `__tenant` policies of this table; the patient actor never writes identity tables directly. Still gated by D-218 (T1).

### 5.3 Platform policies (`__platform`, `TO lims_app USING ((SELECT app.is_platform_actor()))`)

| Table | Commands |
|---|---|
| identity.sessions | SELECT, UPDATE **only rows `kind = 'platform'`** (`USING (kind = 'platform' AND (SELECT app.is_platform_actor()))`) |
| identity.mfa_factors | SELECT, INSERT, UPDATE rows with `tenant_id IS NULL` (`USING / WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()))`, 08 A28.1) |
| identity.auth_events | SELECT all rows (platform sign-in view, PL-8); INSERT none (tenant-less inserts via `app.identity_record_auth_event`) |
| identity.invitations | SELECT, INSERT, UPDATE rows with `tenant_id IS NULL` (same predicate, 08 A28.1) |
| identity.platform_staff | SELECT, INSERT, UPDATE |
| identity.platform_events | SELECT, INSERT |
| identity.tenant_settings, identity.feature_flags | SELECT, UPDATE (all tenants) |
| identity.support_sessions | SELECT, INSERT, UPDATE |
| identity.ird_annex_records, ird_annex_events, ird_annex_documents | SELECT, INSERT, UPDATE (events: INSERT only; documents: INSERT, and UPDATE of `scan_state` only — trigger, P-19) |
| core.tenants | SELECT, INSERT, UPDATE |
| core.dead_letters | SELECT, UPDATE **only rows `tenant_id IS NOT NULL`** (`USING (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()))`, 08 A10.4; NULL-tenant rows only through the C0 `app.dl_*` DEFINERs) — written by C0 and used only by `ctx.core.deadLetters` (runs under platform claims); C2 has no direct UPDATE path or repository SQL on this table (08 A8.6) |
| core.memberships, core.users, core.branches, core.collection_centres | SELECT (counts and admin lists in PL-3) |

Writes into a target tenant's tables during provisioning/support use `withTenantScope` (system claims of the identity module for that tenant), so they pass the normal `__tenant` policies — no `__platform` INSERT policies on tenant tables are needed beyond those listed.

### 5.4 Owner policies for the §6 DEFINER functions (`owner_only`, `TO lims_owner`; 08 A10.5, A12, A15)

FORCE RLS applies to `lims_owner`, the owner of every identity table and of the §6 functions. Each DEFINER that reads, updates or deletes a FORCE-RLS table therefore needs a `<table>__<cmd>__owner_only` policy with the narrowest USING clause the function needs (C0 05-SCHEMA §4.3 owner-policy rule). PostgreSQL 16 behaviour: an owner `DELETE … WHERE` also needs a SELECT policy admitting the existing row. An owner `UPDATE … WHERE` also needs a SELECT policy admitting both the existing and the new row. An `INSERT` without `RETURNING` needs only the INSERT policy. One policy per table and command; a policy serving several functions ORs their predicates. DDL in §10.1 (identity tables) and C0 05-SCHEMA §10 (`core` tables; mirrored in §10.2); tests §11 tests 21, 22, 24 and 25.

**Pre-tenant lookup GUCs (08 A12.1, A15.1, A15.2; 08 §4.7 rule).** A static policy cannot reference a function parameter, so the four pre-tenant lookups set transaction-local GUCs **inside the function body** with `set_config(name, value, true)` before each read, and their owner policies match on them. All values are text:

| GUC | Value set by the function | Set by | Owner policies that match on it |
|---|---|---|---|
| `app.pre_session_token_sha256` | `encode(p_token_sha256, 'hex')` (the presented 32-byte hash) | `app.identity_session_by_token` | `sessions__select__owner_only`: `token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex') OR previous_token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex')` |
| `app.pre_gotrue_session_id` | `p_gotrue_session_id` | `app.identity_resolve_session` | `sessions__select__owner_only`: `gotrue_session_id = nullif(current_setting('app.pre_gotrue_session_id', true), '')::uuid` |
| `app.pre_user_id` | the GoTrue `sub` (`p_sub` / `p_user_id`) | `app.identity_resolve_session`, `app.identity_login_context`, `app.identity_user_exists` (its input `p_user_id` already is the GoTrue user id = `sub`, so its signature is unchanged), the five `app.identity_platform_auth_write_*` (08 A28.1) | `memberships__select__owner_only` (C0): `user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid`; `users__select__owner_only` (C0): `id = nullif(current_setting('app.pre_user_id', true), '')::uuid` |
| `app.pre_support_session_id` | the session row's `support_session_id` (`''` when NULL), set after the session row is read and before `identity.support_sessions` is read (08 A15.1) | `app.identity_resolve_session` | `support_sessions__select__owner_only`: `id = nullif(current_setting('app.pre_support_session_id', true), '')::uuid` |
| `app.pre_tenant_id` | the chosen membership's / session's `tenant_id`, set **after** the membership is chosen (08 A8.1); for a `platform` session with an active, unexpired support session, that support session's `tenant_id` (08 A20.1); `''` when there is none | `app.identity_resolve_session` (the session's tenant, or the support tenant of a `platform` session), `app.identity_login_context` (the A8.1 membership's tenant) | with `t = nullif(current_setting('app.pre_tenant_id', true), '')::uuid` and `u = nullif(current_setting('app.pre_user_id', true), '')::uuid`: `tenants__select__owner_only` (C0): `id = t`; `roles__select__owner_only` (C0): `tenant_id = t`; `membership_roles__select__owner_only` (C0): `tenant_id = t` and the row's membership belongs to `u` (`EXISTS` on `core.memberships`, admitted by the `app.pre_user_id` policy); `mfa_factors__select__owner_only`: `user_id = u AND tenant_id IS NOT DISTINCT FROM t` (08 A15.2: a user with no membership — platform staff — leaves `t` NULL and matches their own tenant-less factors); `tenant_settings__select__owner_only`: `tenant_id = t`; `support_sessions__select__owner_only`: `tenant_id = t` |

Each function resets every GUC it set to `''` before it returns. The policies are `TO lims_owner` only, so a `lims_app` session (`lims_api`, `lims_worker`) that sets these GUCs itself gains nothing (§11 test 24).

**Maintenance GUC (08 A12.2, A15.3).** Every cross-tenant maintenance function of §6 — `app.identity_purge_sessions()`, `app.identity_expire_support_sessions()`, `app.identity_expire_invitations()`, `app.identity_expire_audit_exports()` and `app.identity_purge_auth_events()` (which also reads every tenant's retention setting) — is plpgsql, sets `set_config('app.maintenance', '<function name>', true)` first and resets it to `''` before returning. Its owner policies are `USING (current_setting('app.maintenance', true) = '<function name>' AND <narrow predicate>)` (UPDATE policies gate `WITH CHECK` the same way); no static owner policy for maintenance remains. Below, `m('<name>')` abbreviates `current_setting('app.maintenance', true) = '<name>'`.

| Function (§6) | FORCE-RLS table · command | Owner policy |
|---|---|---|
| `app.is_platform_actor()` (C0 DDL, 08 A15.6) | `identity.platform_staff` · SELECT | `platform_staff__select__owner_only USING (true)` (decided, 08 A10.5) |
| `app.identity_bootstrap_platform_admin(...)` | `identity.platform_staff` · SELECT; INSERT | SELECT: `platform_staff__select__owner_only`; INSERT: `platform_staff__insert__owner_only WITH CHECK (role_code = 'platform_superadmin')` |
| | `identity.platform_events` · INSERT | `platform_events__insert__owner_only WITH CHECK (event_type = 'bootstrap_admin_created')` |
| `app.identity_record_auth_event(jsonb)` | `identity.auth_events` · INSERT | `auth_events__insert__owner_only WITH CHECK (tenant_id IS NULL)` |
| `app.identity_purge_sessions()` | `identity.sessions` · SELECT, DELETE | `sessions__select__owner_only` (its `m('identity_purge_sessions') AND expires_at < now()` branch) and `sessions__delete__owner_only USING (m('identity_purge_sessions') AND expires_at < now())` (08 A15.3) |
| | `identity.admin_notices` · SELECT, DELETE | `admin_notices__select__owner_only` and `admin_notices__delete__owner_only` `USING (m('identity_purge_sessions') AND expires_at < now())` (08 A15.3) |
| `app.identity_expire_support_sessions()` | `identity.support_sessions` · UPDATE … WHERE … RETURNING | `support_sessions__update__owner_only USING (m('identity_expire_support_sessions') AND <due>) WITH CHECK (m('identity_expire_support_sessions') AND status = 'expired' AND end_reason = 'expired')`; `support_sessions__select__owner_only` (its `m('identity_expire_support_sessions') AND (<due> OR (status = 'expired' AND end_reason = 'expired'))` branch). `<due>` = the function's WHERE clause (08 A15.3) |
| `app.identity_expire_invitations()` | `identity.invitations` · UPDATE … WHERE … RETURNING (one statement, `SET status = CASE … END`, 08 A12.6) | `invitations__update__owner_only USING (m('identity_expire_invitations') AND (<e> OR <r>)) WITH CHECK (m('identity_expire_invitations') AND (status = 'expired' OR (email IS NULL AND status IN ('accepted','expired','revoked','failed'))))`; `invitations__select__owner_only USING (m('identity_expire_invitations') AND (<e> OR <r> OR status = 'expired' OR (email IS NULL AND status IN ('accepted','expired','revoked','failed'))))`. `<e>` (expire) and `<r>` (clear email 30 days after a terminal state) = the two branches of the function's WHERE clause (08 A15.3) |
| `app.identity_expire_audit_exports()` | `identity.audit_exports` · UPDATE … WHERE … RETURNING; DELETE … WHERE | `audit_exports__update__owner_only USING (m('identity_expire_audit_exports') AND <due>) WITH CHECK (m('identity_expire_audit_exports') AND status = 'expired')`; `audit_exports__delete__owner_only USING (m('identity_expire_audit_exports') AND <old>)`; `audit_exports__select__owner_only USING (m('identity_expire_audit_exports') AND (<due> OR status = 'expired' OR <old>))`. `<due>` = `status = 'ready' AND (expires_at <= now() OR downloads_remaining = 0)` (08 A15.3); `<old>` = `status IN ('expired','failed') AND created_at < now() - interval '1 year'` (§9; 08 A17 P-18(c); review C2 m#56) |
| `app.identity_purge_auth_events()` | `identity.auth_events` · SELECT, DELETE | `auth_events__select__owner_only` and `auth_events__delete__owner_only` `USING (current_setting('app.maintenance', true) = 'identity_purge_auth_events' AND occurred_at < now() - interval '5 years')` (08 A12.2). No deletable row is newer: `retention_audit_years` ≥ 5 (`tenant_settings__retention__ck`) and tenant-less rows are kept 5 years (§9) |
| | `identity.tenant_settings` · SELECT (every row: `tenant_id`, `retention_audit_years`) | `tenant_settings__select__owner_only` (its `current_setting('app.maintenance', true) = 'identity_purge_auth_events'` branch; every tenant's row is needed, so there is no narrower row predicate) (08 A12.2) |
| `app.identity_resolve_session(uuid, uuid)` | `identity.sessions` · SELECT | `sessions__select__owner_only` (`app.pre_gotrue_session_id` branch, 08 A12.1) |
| | `core.memberships` · SELECT | `memberships__select__owner_only` (C0; `app.pre_user_id` branch) |
| | `core.tenants` · SELECT | `tenants__select__owner_only` (C0; `app.pre_tenant_id` branch): the session's `tenant_id`, or — for a `platform` session — the tenant of its active, unexpired support session, read first through the `app.pre_support_session_id` branch (08 A20.1), so the second join (`st`, output `support_tenant_status`) is filled; the GUC is reset before return (§11 test 22) |
| | `identity.support_sessions` · SELECT | `support_sessions__select__owner_only` (`app.pre_support_session_id` branch: the session row's `support_session_id`, 08 A15.1; the `app.pre_tenant_id` branch remains for the session's `tenant_id`, 08 A12.1) |
| | `identity.platform_staff` · SELECT | `platform_staff__select__owner_only` (covered) |
| `app.identity_session_by_token(bytea)` | `identity.sessions` · SELECT | `sessions__select__owner_only` (`app.pre_session_token_sha256` branch: current or previous hash, 08 A12.1) |
| `app.identity_login_context(uuid)` | `core.memberships` · SELECT | `memberships__select__owner_only` (C0; `app.pre_user_id` branch) |
| | `core.membership_roles`, `core.roles`, `core.tenants` · SELECT | `membership_roles__select__owner_only`, `roles__select__owner_only`, `tenants__select__owner_only` (C0; `app.pre_tenant_id` branches) |
| | `identity.mfa_factors`, `identity.tenant_settings` · SELECT | `mfa_factors__select__owner_only` (`user_id = app.pre_user_id AND tenant_id IS NOT DISTINCT FROM app.pre_tenant_id`, so platform staff with no membership match their tenant-less factors, 08 A15.2), `tenant_settings__select__owner_only` (`app.pre_tenant_id` branch) |
| | `identity.platform_staff` · SELECT | `platform_staff__select__owner_only` (covered) |
| `app.identity_user_exists(uuid)` | `core.users` · SELECT | `users__select__owner_only` (C0; `app.pre_user_id`) |
| | `identity.platform_staff` · SELECT | `platform_staff__select__owner_only` (covered) |
| `app.identity_load_breached_batch(...)`, `app.identity_finish_breached_import(text)` | none (`identity.g_breached_passwords` is class G, no RLS) | — |
| `app.identity_platform_auth_write_session_insert(uuid, jsonb)`, `…_session_update(uuid, uuid, jsonb)` (08 A28.1) | `identity.sessions` · INSERT; SELECT … FOR UPDATE, UPDATE | `sessions__insert__owner_only` / `sessions__update__owner_only` `(tenant_id IS NULL AND kind = 'platform' AND user_id = app.pre_user_id)`; `sessions__select__owner_only` gains the same branch |
| `app.identity_platform_auth_write_mfa_factor(uuid, uuid, jsonb)` (08 A28.1) | `identity.mfa_factors` · INSERT; SELECT … FOR UPDATE, UPDATE | `mfa_factors__insert__owner_only` / `mfa_factors__update__owner_only` `(tenant_id IS NULL AND user_id = app.pre_user_id)`; SELECT: the existing A15.2 branch (`app.pre_tenant_id` = `''`) |
| `app.identity_platform_auth_write_invitation_accept(uuid, uuid)` (08 A28.1) | `identity.invitations` · UPDATE … WHERE | `invitations__update__owner_only` and `invitations__select__owner_only` gain the branch `(tenant_id IS NULL AND user_id = app.pre_user_id)` |
| `app.identity_platform_auth_write_staff_login(uuid)` (08 A28.1) | `identity.platform_staff` · UPDATE | `platform_staff__update__owner_only USING / WITH CHECK (user_id = app.pre_user_id)`; SELECT: `platform_staff__select__owner_only` |
| `app.identity_notify_ip_throttle_hmacs(inet, timestamptz)` (08 A28.4) | `identity.auth_events` · SELECT | `auth_events__select__owner_only` gains `m('identity_notify_ip_throttle') AND tenant_id IS NULL AND event_type = 'login_failed' AND email_hmac IS NOT NULL` |
| `app.identity_tenants_for_email_hmacs(bytea[])` (DDL C0 05-SCHEMA §10 = §10.3 below, identical text; 08 A25 D-217) | `core.users` · SELECT | `users__select__owner_only` (C0): branch `m('identity_tenants_for_email_hmacs') AND email_hmac IS NOT NULL`, ORed with the `app.pre_user_id` branch (§10.2) |

## 6. SECURITY DEFINER functions (C0 inventory, 04 D7; all `SET search_path = ''`, schema-qualified, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO lims_app`)

| Function | Purpose | Called by |
|---|---|---|
| `app.identity_resolve_session(p_gotrue_session_id uuid, p_sub uuid)` | claims resolution (02-TRD §6) | API core via identity claims resolver |
| `app.identity_session_by_token(p_token_sha256 bytea)` | BFF / app session-token lookup before claims exist; also matches `previous_token_sha256` and returns `token_reused = true` for a rotated-out app token (CR-C2-018, 08 Addendum A3.1) | identity auth service |
| `app.identity_login_context(p_user_id uuid)` | membership/platform/MFA facts after GoTrue password ok | identity auth service |
| `app.identity_user_exists(p_user_id uuid) RETURNS boolean` | invite collision check across tenants without revealing tenant; `p_user_id` = the GoTrue user id (`sub`) returned by `adminCreateUser` (08 A12.1) | identity user service |
| `app.identity_record_auth_event(p jsonb) RETURNS void` | insert `auth_events` with `tenant_id IS NULL` only | identity auth service |
| `app.identity_bootstrap_platform_admin(p_staff_id uuid, p_user_id uuid, p_email text, p_display_name text, p_event_id uuid) RETURNS void` | first platform superadmin, only when none active | CLI |
| `app.identity_load_breached_batch(p_hashes bytea[], p_version text) RETURNS integer` | import breached list (upsert one batch) | worker task `identity.import_breached_passwords` |
| `app.identity_finish_breached_import(p_version text) RETURNS integer` | after the last batch: delete rows of older `list_version` (08 A19 P-41(d)) | worker task `identity.import_breached_passwords` |
| `app.identity_purge_sessions()`, `app.identity_expire_support_sessions()`, `app.identity_expire_invitations()`, `app.identity_expire_audit_exports() RETURNS TABLE(object_path text)`, `app.identity_purge_auth_events()` | maintenance (02-CV §5.11); `identity_expire_audit_exports` also deletes `expired`/`failed` rows older than 1 year | worker cron |
| `app.identity_platform_auth_write_session_insert(p_user_id uuid, p_row jsonb) RETURNS void`, `app.identity_platform_auth_write_session_update(p_user_id uuid, p_session_id uuid, p_set jsonb) RETURNS integer`, `app.identity_platform_auth_write_mfa_factor(p_user_id uuid, p_factor_id uuid, p_row jsonb) RETURNS integer`, `app.identity_platform_auth_write_invitation_accept(p_user_id uuid, p_invitation_id uuid) RETURNS integer`, `app.identity_platform_auth_write_staff_login(p_user_id uuid) RETURNS integer` [CONV names, 08 A28.1] | platform-staff session / MFA-factor / invitation / last-login writes during authentication, before a platform session exists; `app.pre_user_id`-gated; whitelisted columns only | identity auth service (EXECUTE `lims_api` only) |
| `app.identity_notify_ip_throttle_hmacs(p_client_ip inet, p_since timestamptz) RETURNS SETOF bytea` [CONV name, 08 A28.4] | the failure window's e-mail HMACs (≤ 100) for one client IP; `app.maintenance = 'identity_notify_ip_throttle'` | worker task `identity.notify_ip_throttle` (EXECUTE `lims_worker` only) |
| `app.identity_tenants_for_email_hmacs(p_hmacs bytea[]) RETURNS SETOF uuid` | tenants whose staff were targeted by a throttled IP (≤ 100 values; `app.maintenance`-gated; 08 A25 D-217). DDL owner: C0 (05-SCHEMA §10), text identical to §10.3 (P-41) | worker task `identity.notify_ip_throttle` (EXECUTE `lims_worker` only) |

Not DEFINER: `app.identity_is_breached(p_sha1 bytea) RETURNS boolean` (INVOKER, `lims_app` holds SELECT on the G table; §10.3).

Inventory rows (08 §4.7 / 03-IC §13.3, P-41(d)): every function of this table — incl. the four maintenance functions (owner `lims_owner`, EXECUTE `lims_worker`, `app.maintenance = '<name>'`, 08 A15.3) and the two breached-list functions (owner `lims_owner`, EXECUTE `lims_worker`, G table) — needs a row there; adding the missing rows is a program-doc change (handed off, review C2 #28).

SQL bodies are in §10.3. The owner policies each one needs under FORCE RLS are in §5.4, DDL in §10.1 and C0 05-SCHEMA §10 (08 A10.5). The four pre-tenant lookups (`app.identity_resolve_session`, `app.identity_session_by_token`, `app.identity_login_context`, `app.identity_user_exists`) are plpgsql: they set the `app.pre_*` GUCs with `set_config(…, true)` before each read and reset them to `''` before returning (08 A12.1, A15.1); every maintenance function (`app.identity_purge_sessions`, `app.identity_expire_support_sessions`, `app.identity_expire_invitations`, `app.identity_expire_audit_exports`, `app.identity_purge_auth_events`) is plpgsql and does the same with `app.maintenance = '<function name>'` (08 A12.2, A15.3). They are `VOLATILE` because `set_config` changes session state.

## 7. Published views

03 §6 requires **no** `identity.v_pub_*` or `core.v_pub_*` views (core is read via `ctx.core`, 03 §6 global note). C2 publishes none.

## 8. Coded sets and seed data

| Data | Where | Content |
|---|---|---|
| Feature-flag registry | `identity.g_feature_flags` (migration seed) | `whatsapp_pdf_attachment` (tenant scope, settable_by platform, founder approval yes, default false, B11 — 04 R4); `smart_report_llm` (tenant, platform, yes, false, B11 — 04 R8); `breached_password_online_check` (platform, platform, yes, false, B11 — 04 A3; not implemented); `referral_incentive_report` (tenant, tenant, no, false, B13 — 04 L19); `smart_report` (tenant, tenant, no, false — CR-C14-005; default off, 08 R17) |
| Default roles | generated per tenant at provisioning from the default roles of `contracts/permissions.yaml` `roles:` (03 §11; currently 10, incl. `radiologist` — CR-C6-003) | not a static seed |
| Synthetic tenants | `packages/test-fixtures` (C0) | `tenant_a` "Synthetic Lab Alpha", `tenant_b` "Synthetic Lab Beta", ≥2 branches/centres each, one user per default role, one locked user, one invited user, one user without MFA in an MFA role, tenant settings with non-default values in Beta; platform staff: one superadmin, one support (02-CV §11.2) |
| Breached list | none in repo (source UNVERIFIED); tests use a synthetic list of SHA-1s of synthetic strings ("SyntheticLeak0001!" …) | |

## 9. Retention

| Table | Retention | Mechanism |
|---|---|---|
| sessions | until `expires_at` (absolute/revoke + 30 days [CONV]) | `app.identity_purge_sessions()` hourly |
| auth_events | tenant `retention_audit_years` (≥5, 04 I8/B15); tenant-less rows 5 years | `app.identity_purge_auth_events()` daily |
| invitations | rows kept; `email` set NULL 30 days after terminal state [CONV] | `app.identity_expire_invitations()` |
| support_sessions, ird_* , access_reviews, platform_events | ≥ `retention_audit_years` (no purge job in v1) | — |
| audit_exports | objects deleted at expiry (24 h / 3 downloads); rows in status `expired` / `failed` deleted 1 year after `created_at` (class E, 08 A17 P-18(c): cross-tenant purge through a `lims_owner` DEFINER gated on `app.maintenance`) | `app.identity_expire_audit_exports()` (hourly) |
| admin_notices | `expires_at` (30 days [CONV]) | purge in `identity_purge_sessions` run |
| branding_assets | forever while tenant data retained (reports must re-render, REQ-ARCH-036) | — |
| mfa_factors | rows kept (removed status) | — |
| g_breached_passwords | replaced per list version | import task deletes older `list_version` rows inside the owner function |

## 10. DDL

### 10.1 `identity` schema

```sql
CREATE SCHEMA IF NOT EXISTS identity AUTHORIZATION lims_owner;

-- 4.8 global registry -------------------------------------------------------
CREATE TABLE identity.g_feature_flags (
  code                      text        NOT NULL,
  description               text        NOT NULL,
  scope                     text        NOT NULL,
  settable_by               text        NOT NULL,
  requires_founder_approval boolean     NOT NULL,
  default_enabled           boolean     NOT NULL,
  blocker_ref               text,
  is_active                 boolean     NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_feature_flags__pk PRIMARY KEY (code),
  CONSTRAINT g_feature_flags__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT g_feature_flags__scope__ck CHECK (scope IN ('tenant','platform')),
  CONSTRAINT g_feature_flags__settable_by__ck CHECK (settable_by IN ('tenant','platform')),
  CONSTRAINT g_feature_flags__blocker_ref__ck CHECK (blocker_ref IS NULL OR blocker_ref ~ '^B[0-9]{1,2}$')
);
INSERT INTO identity.g_feature_flags (code, description, scope, settable_by, requires_founder_approval, default_enabled, blocker_ref) VALUES
 ('whatsapp_pdf_attachment','Send report PDF as WhatsApp attachment (needs patient consent)','tenant','platform',true,false,'B11'),
 ('smart_report_llm','Optional LLM fluency layer for smart reports','tenant','platform',true,false,'B11'),
 ('breached_password_online_check','Online breached-password range check (foreign call)','platform','platform',true,false,'B11'),
 ('referral_incentive_report','Show referral-incentive report (reporting only, never "commission")','tenant','tenant',false,false,'B13'),
 ('smart_report','Smart report (patient-friendly summary; per-summary pathologist approval)','tenant','tenant',false,false,NULL);   -- CR-C14-005; off by default (08 R17)

-- 4.9 breached passwords ------------------------------------------------------
CREATE TABLE identity.g_breached_passwords (
  sha1         bytea       NOT NULL,
  list_version text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_breached_passwords__pk PRIMARY KEY (sha1),
  CONSTRAINT g_breached_passwords__sha1_len__ck CHECK (octet_length(sha1) = 20)
);

-- 4.5 platform staff ------------------------------------------------------------
CREATE TABLE identity.platform_staff (
  id               uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  email_normalized text        NOT NULL,
  display_name     text        NOT NULL,
  role_code        text        NOT NULL,
  allowed_cidrs    cidr[]      NOT NULL DEFAULT '{}',
  last_login_at    timestamptz,
  is_active        boolean     NOT NULL DEFAULT true,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  CONSTRAINT platform_staff__pk PRIMARY KEY (id),
  CONSTRAINT platform_staff__user_id__uq UNIQUE (user_id),
  CONSTRAINT platform_staff__role_code__ck CHECK (role_code IN ('platform_superadmin','platform_support')),
  CONSTRAINT platform_staff__email__ck CHECK (char_length(email_normalized) BETWEEN 3 AND 254),
  CONSTRAINT platform_staff__display_name__ck CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT platform_staff__cidrs__ck CHECK (cardinality(allowed_cidrs) <= 20)
);

-- 4.11 support sessions ----------------------------------------------------------
CREATE TABLE identity.support_sessions (
  id                        uuid        NOT NULL,
  tenant_id                 uuid        NOT NULL,
  platform_staff_id         uuid        NOT NULL,
  scope                     text        NOT NULL,
  reason_text               text        NOT NULL,
  ticket_ref                text        NOT NULL,
  duration_minutes          integer     NOT NULL,
  status                    text        NOT NULL,
  requested_at              timestamptz NOT NULL DEFAULT now(),
  decided_at                timestamptz,
  decided_by_membership_id  uuid,
  decision_note             text,
  started_at                timestamptz,
  expires_at                timestamptz,
  ended_at                  timestamptz,
  ended_by                  uuid,
  end_reason                text,
  version                   integer     NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid        NOT NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        NOT NULL,
  CONSTRAINT support_sessions__pk PRIMARY KEY (id),
  CONSTRAINT support_sessions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT support_sessions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT support_sessions__staff__fk FOREIGN KEY (platform_staff_id) REFERENCES identity.platform_staff (id),
  CONSTRAINT support_sessions__decider__fk FOREIGN KEY (tenant_id, decided_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT support_sessions__scope__ck CHECK (scope IN ('read_only','admin')),
  CONSTRAINT support_sessions__status__ck CHECK (status IN ('requested','approved','denied','active','ended','expired','revoked')),
  CONSTRAINT support_sessions__reason__ck CHECK (char_length(reason_text) BETWEEN 10 AND 500),
  CONSTRAINT support_sessions__ticket__ck CHECK (char_length(ticket_ref) BETWEEN 1 AND 60),
  CONSTRAINT support_sessions__duration__ck CHECK (duration_minutes BETWEEN 5 AND 60),
  CONSTRAINT support_sessions__active_times__ck CHECK (status <> 'active' OR (started_at IS NOT NULL AND expires_at IS NOT NULL)),
  CONSTRAINT support_sessions__end_reason__ck CHECK (end_reason IS NULL OR end_reason IN
     ('ended_by_staff','expired','revoked_by_tenant','superseded','platform_logout','denied'))
);
CREATE INDEX support_sessions__tenant_id_status_requested_at__idx ON identity.support_sessions (tenant_id, status, requested_at DESC);
CREATE INDEX support_sessions__tenant_id_expires_at__p_idx ON identity.support_sessions (tenant_id, expires_at) WHERE status = 'active';
CREATE INDEX support_sessions__platform_staff_id_status__idx ON identity.support_sessions (platform_staff_id, status);

-- 4.1 sessions ------------------------------------------------------------------
CREATE TABLE identity.sessions (
  id                   uuid        NOT NULL,
  tenant_id            uuid,
  kind                 text        NOT NULL,
  user_id              uuid        NOT NULL,
  membership_id        uuid,
  platform_staff_id    uuid,
  gotrue_session_id    uuid        NOT NULL,
  token_sha256         bytea       NOT NULL,
  previous_token_sha256 bytea,                                                     -- CR-C2-018 (08 A3.1): rotated-out app token, one kept
  state                text        NOT NULL,
  aal                  text        NOT NULL DEFAULT 'aal1',
  refresh_token_enc    bytea       NOT NULL,
  access_token_enc     bytea       NOT NULL,
  enc_key_id           text        NOT NULL,
  access_expires_at    timestamptz NOT NULL,
  idle_timeout_minutes integer     NOT NULL,
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  mfa_failed_attempts  integer     NOT NULL DEFAULT 0,
  support_session_id   uuid,
  app_instance_id      uuid,                                                       -- patient / staff_mobile only (08 R10)
  app_platform         text,
  client_ip            inet,
  user_agent           text,
  revoked_at           timestamptz,
  revoked_by           uuid,
  revoke_reason        text,
  expires_at           timestamptz NOT NULL,
  version              integer     NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NOT NULL,
  CONSTRAINT sessions__pk PRIMARY KEY (id),
  CONSTRAINT sessions__token_sha256__uq UNIQUE (token_sha256),               -- CR-C2-017 exception
  CONSTRAINT sessions__gotrue_session_id__uq UNIQUE (gotrue_session_id),     -- CR-C2-017 exception
  CONSTRAINT sessions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT sessions__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT sessions__platform_staff__fk FOREIGN KEY (platform_staff_id) REFERENCES identity.platform_staff (id),
  CONSTRAINT sessions__support__fk FOREIGN KEY (support_session_id) REFERENCES identity.support_sessions (id),
  CONSTRAINT sessions__kind__ck CHECK (kind IN ('tenant_staff','platform','partner','patient','staff_mobile')),   -- 08 R10
  CONSTRAINT sessions__kind_shape__ck CHECK (
       (kind IN ('tenant_staff','partner','patient','staff_mobile')
          AND tenant_id IS NOT NULL AND membership_id IS NOT NULL AND platform_staff_id IS NULL AND support_session_id IS NULL)
    OR (kind = 'platform'     AND tenant_id IS NULL     AND membership_id IS NULL     AND platform_staff_id IS NOT NULL)),
  CONSTRAINT sessions__app__ck CHECK ((kind IN ('patient','staff_mobile')) = (app_instance_id IS NOT NULL AND app_platform IS NOT NULL)
                                      AND (app_platform IS NULL OR app_platform IN ('android','ios'))),
  CONSTRAINT sessions__patient_aal__ck CHECK (kind <> 'patient' OR aal = 'aal1'),
  CONSTRAINT sessions__state__ck CHECK (state IN ('password_setup','mfa_pending','mfa_enrolment_required','active','revoked','expired')),
  CONSTRAINT sessions__aal__ck CHECK (aal IN ('aal1','aal2')),
  CONSTRAINT sessions__token_len__ck CHECK (octet_length(token_sha256) = 32),
  CONSTRAINT sessions__previous_token_len__ck CHECK (previous_token_sha256 IS NULL OR octet_length(previous_token_sha256) = 32),   -- CR-C2-018
  CONSTRAINT sessions__idle__ck CHECK (
       (kind IN ('tenant_staff','platform','partner') AND idle_timeout_minutes BETWEEN 15 AND 30)    -- 04 A8
    OR (kind = 'patient'      AND idle_timeout_minutes BETWEEN 1440 AND 43200)                       -- 1–30 d (08 R10)
    OR (kind = 'staff_mobile' AND idle_timeout_minutes BETWEEN 60 AND 720)),                           -- no idle timeout: service sets = configured absolute (04 A16)
  CONSTRAINT sessions__absolute__ck CHECK (
       (kind <> 'patient' AND absolute_expires_at <= created_at + interval '12 hours')               -- 04 A8
    OR (kind = 'patient'  AND absolute_expires_at <= created_at + interval '90 days')),              -- tenant-configurable 1–90 d (08 R10)
  CONSTRAINT sessions__mfa_attempts__ck CHECK (mfa_failed_attempts BETWEEN 0 AND 5),
  CONSTRAINT sessions__ua__ck CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  CONSTRAINT sessions__revoke__ck CHECK ((state = 'revoked') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  CONSTRAINT sessions__revoke_reason__ck CHECK (revoke_reason IS NULL OR revoke_reason IN
     ('logout','admin_revoke','self_revoke','password_change','role_change','lock','deactivate','tenant_suspended',
      'mfa_failed','mfa_reset','refresh_failed','superseded','token_reuse'))
);
CREATE INDEX sessions__tenant_id_membership_id_state__idx ON identity.sessions (tenant_id, membership_id, state);
CREATE INDEX sessions__tenant_id_last_seen_at__p_idx ON identity.sessions (tenant_id, last_seen_at DESC)
  WHERE state IN ('password_setup','mfa_pending','mfa_enrolment_required','active');
CREATE INDEX sessions__platform_staff_id_state__p_idx ON identity.sessions (platform_staff_id, state) WHERE kind = 'platform';
CREATE INDEX sessions__expires_at__idx ON identity.sessions (expires_at);
CREATE UNIQUE INDEX sessions__previous_token_sha256__p_uq ON identity.sessions (previous_token_sha256)
  WHERE previous_token_sha256 IS NOT NULL;                                         -- CR-C2-018 exception (index-exceptions.yaml; 08 A3.1)

-- 4.2 mfa factors ------------------------------------------------------------------
CREATE TABLE identity.mfa_factors (
  id               uuid        NOT NULL,
  tenant_id        uuid,
  user_id          uuid        NOT NULL,
  gotrue_factor_id uuid        NOT NULL,
  factor_type      text        NOT NULL DEFAULT 'totp',
  status           text        NOT NULL,
  friendly_name    text,
  verified_at      timestamptz,
  removed_at       timestamptz,
  removed_by       uuid,
  removal_reason   text,
  is_active        boolean     NOT NULL DEFAULT true,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  CONSTRAINT mfa_factors__pk PRIMARY KEY (id),
  CONSTRAINT mfa_factors__tenant_id_gotrue_factor_id__uq UNIQUE NULLS NOT DISTINCT (tenant_id, gotrue_factor_id),
  CONSTRAINT mfa_factors__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT mfa_factors__type__ck CHECK (factor_type IN ('totp')),
  CONSTRAINT mfa_factors__status__ck CHECK (status IN ('unverified','verified','removed')),
  CONSTRAINT mfa_factors__name__ck CHECK (friendly_name IS NULL OR char_length(friendly_name) <= 40),
  CONSTRAINT mfa_factors__removal__ck CHECK (removal_reason IS NULL OR removal_reason IN ('self','admin_reset','re_enrol'))
);
CREATE INDEX mfa_factors__tenant_id_user_id_status__idx ON identity.mfa_factors (tenant_id, user_id, status);

-- 4.3 auth events (append-only) --------------------------------------------------
CREATE TABLE identity.auth_events (
  id                uuid        NOT NULL,
  tenant_id         uuid,
  user_id           uuid,
  membership_id     uuid,
  platform_staff_id uuid,
  session_id        uuid,
  event_type        text        NOT NULL,
  reason_code       text,
  email_hmac        bytea,
  client_ip         inet,
  user_agent        text,
  request_id        uuid,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  CONSTRAINT auth_events__pk PRIMARY KEY (id),
  CONSTRAINT auth_events__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT auth_events__type__ck CHECK (event_type IN (
    'login_failed','login_password_ok','login_succeeded','login_step_up_required','login_rate_limited',
    'login_blocked_locked','login_blocked_inactive','login_blocked_tenant_suspended','login_blocked_ip',
    'mfa_verified','mfa_challenge_failed','mfa_enrolled','mfa_factor_removed','mfa_reset',
    'password_changed','password_reset_requested','recovery_link_opened','password_reset_completed',
    'invite_sent','invite_link_opened','invite_accepted','session_revoked','session_expired_idle',
    'session_expired_absolute','logout','refresh_failed','account_locked','account_unlocked',
    'membership_deactivated','membership_reactivated','login_ip_throttled','session_token_reused')),
  CONSTRAINT auth_events__hmac_len__ck CHECK (email_hmac IS NULL OR octet_length(email_hmac) = 32),
  CONSTRAINT auth_events__ua__ck CHECK (user_agent IS NULL OR char_length(user_agent) <= 512)
);
CREATE INDEX auth_events__tenant_id_occurred_at__idx ON identity.auth_events (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX auth_events__tenant_id_membership_id_occurred_at__idx ON identity.auth_events (tenant_id, membership_id, occurred_at DESC);
CREATE INDEX auth_events__tenant_id_event_type_occurred_at__idx ON identity.auth_events (tenant_id, event_type, occurred_at DESC);
CREATE INDEX auth_events__occurred_at__idx ON identity.auth_events (occurred_at DESC, id DESC);   -- index-rule exception: platform-wide PL-8 list (index-exceptions.yaml)

-- 4.4 invitations -----------------------------------------------------------------------
CREATE TABLE identity.invitations (
  id                uuid        NOT NULL,
  tenant_id         uuid,
  user_id           uuid        NOT NULL,
  membership_id     uuid,
  platform_staff_id uuid,
  email             text,
  status            text        NOT NULL,
  attempt_no        integer     NOT NULL DEFAULT 1,
  issued_at         timestamptz,
  expires_at        timestamptz NOT NULL,
  accepted_at       timestamptz,
  last_error_code   text,
  invited_by        uuid        NOT NULL,
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        NOT NULL,
  CONSTRAINT invitations__pk PRIMARY KEY (id),
  CONSTRAINT invitations__tenant_id_id__uq UNIQUE NULLS NOT DISTINCT (tenant_id, id),
  CONSTRAINT invitations__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT invitations__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT invitations__staff__fk FOREIGN KEY (platform_staff_id) REFERENCES identity.platform_staff (id),
  CONSTRAINT invitations__shape__ck CHECK (
       (tenant_id IS NOT NULL AND membership_id IS NOT NULL AND platform_staff_id IS NULL)
    OR (tenant_id IS NULL AND membership_id IS NULL AND platform_staff_id IS NOT NULL)),
  CONSTRAINT invitations__status__ck CHECK (status IN ('pending','sent','accepted','expired','revoked','failed')),
  CONSTRAINT invitations__email__ck CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT invitations__email_present__ck CHECK (email IS NOT NULL OR status IN ('accepted','expired','revoked','failed'))
);
CREATE INDEX invitations__tenant_id_membership_id__idx ON identity.invitations (tenant_id, membership_id);
CREATE INDEX invitations__tenant_id_status_expires_at__idx ON identity.invitations (tenant_id, status, expires_at);

-- 4.10 branding assets ---------------------------------------------------------------------
CREATE TABLE identity.branding_assets (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  kind          text        NOT NULL,
  membership_id uuid,
  bucket        text        NOT NULL DEFAULT 'identity-assets',
  object_path   text        NOT NULL,
  content_type  text        NOT NULL,
  size_bytes    integer     NOT NULL,
  width_px      integer     NOT NULL,
  height_px     integer     NOT NULL,
  sha256        bytea       NOT NULL,
  is_active     boolean     NOT NULL DEFAULT true,
  scan_state    text        NOT NULL DEFAULT 'pending',                         -- 08 A17 P-19
  version       integer     NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT branding_assets__pk PRIMARY KEY (id),
  CONSTRAINT branding_assets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT branding_assets__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT branding_assets__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT branding_assets__kind__ck CHECK (kind IN ('logo','letterhead_header','letterhead_footer','signature')),
  CONSTRAINT branding_assets__sig_member__ck CHECK ((kind = 'signature') = (membership_id IS NOT NULL)),
  CONSTRAINT branding_assets__bucket__ck CHECK (bucket = 'identity-assets'),          -- 08 R26
  CONSTRAINT branding_assets__path__ck CHECK (split_part(object_path, '/', 1) = tenant_id::text),
  CONSTRAINT branding_assets__ctype__ck CHECK (content_type IN ('image/png','image/jpeg')),
  CONSTRAINT branding_assets__size__ck CHECK (size_bytes BETWEEN 1 AND 2097152
                                              AND (kind <> 'signature' OR size_bytes <= 1048576)),
  CONSTRAINT branding_assets__dims__ck CHECK (width_px BETWEEN 1 AND 4000 AND height_px BETWEEN 1 AND 4000),
  CONSTRAINT branding_assets__sha__ck CHECK (octet_length(sha256) = 32),
  CONSTRAINT branding_assets__scan_state__ck CHECK (scan_state IN ('pending','clean','quarantined'))
);
CREATE INDEX branding_assets__tenant_id_kind_is_active__idx ON identity.branding_assets (tenant_id, kind, is_active);
CREATE INDEX branding_assets__tenant_id_membership_id__p_idx ON identity.branding_assets (tenant_id, membership_id) WHERE membership_id IS NOT NULL;
CREATE TRIGGER branding_assets__mutable_columns BEFORE UPDATE ON identity.branding_assets
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('is_active','scan_state','updated_at','updated_by','version');

-- 4.12–4.14 IRD annex tracker -------------------------------------------------------------
CREATE TABLE identity.ird_annex_records (
  id                uuid        NOT NULL,
  tenant_id         uuid,
  annex_code        text        NOT NULL,
  status            text        NOT NULL DEFAULT 'not_started',
  reference_no      text,
  office_name       text,
  counterparty_name text,
  software_version  text,
  submitted_on      date,
  completed_on      date,
  notes             text,
  supersedes_id     uuid,
  is_active         boolean     NOT NULL DEFAULT true,
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        NOT NULL,
  CONSTRAINT ird_annex_records__pk PRIMARY KEY (id),
  CONSTRAINT ird_annex_records__tenant_id_id__uq UNIQUE NULLS NOT DISTINCT (tenant_id, id),
  CONSTRAINT ird_annex_records__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT ird_annex_records__supersedes__fk FOREIGN KEY (supersedes_id) REFERENCES identity.ird_annex_records (id),
  CONSTRAINT ird_annex_records__code__ck CHECK (annex_code IN ('annex_1','annex_2','annex_3','annex_7')),
  CONSTRAINT ird_annex_records__platform_level__ck CHECK ((annex_code = 'annex_1') = (tenant_id IS NULL)),
  CONSTRAINT ird_annex_records__status__ck CHECK (status IN ('not_started','in_preparation','submitted','completed','rejected','superseded')),
  CONSTRAINT ird_annex_records__submitted__ck CHECK (status NOT IN ('submitted','completed','rejected') OR submitted_on IS NOT NULL),
  CONSTRAINT ird_annex_records__completed__ck CHECK (status <> 'completed' OR (completed_on IS NOT NULL AND reference_no IS NOT NULL)),
  CONSTRAINT ird_annex_records__dates__ck CHECK (completed_on IS NULL OR submitted_on IS NULL OR completed_on >= submitted_on),
  CONSTRAINT ird_annex_records__lengths__ck CHECK (
        coalesce(char_length(reference_no),0) <= 100 AND coalesce(char_length(office_name),0) <= 200
    AND coalesce(char_length(counterparty_name),0) <= 200 AND coalesce(char_length(software_version),0) <= 40
    AND coalesce(char_length(notes),0) <= 2000)
);
CREATE UNIQUE INDEX ird_annex_records__tenant_id_annex_code__p_uq ON identity.ird_annex_records (tenant_id, annex_code)
  WHERE status <> 'superseded' AND tenant_id IS NOT NULL;
CREATE INDEX ird_annex_records__annex_code_status__p_idx ON identity.ird_annex_records (annex_code, status, created_at DESC)
  WHERE tenant_id IS NULL;

CREATE TABLE identity.ird_annex_events (
  id          uuid        NOT NULL,
  tenant_id   uuid,
  record_id   uuid        NOT NULL,
  from_status text,
  to_status   text        NOT NULL,
  note        text,
  actor_id    uuid        NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  CONSTRAINT ird_annex_events__pk PRIMARY KEY (id),
  CONSTRAINT ird_annex_events__record__fk FOREIGN KEY (tenant_id, record_id) REFERENCES identity.ird_annex_records (tenant_id, id),
  CONSTRAINT ird_annex_events__record_id__fk FOREIGN KEY (record_id) REFERENCES identity.ird_annex_records (id),  -- enforces platform rows (tenant_id NULL, MATCH SIMPLE)
  CONSTRAINT ird_annex_events__note__ck CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE INDEX ird_annex_events__record_id_occurred_at__idx ON identity.ird_annex_events (record_id, occurred_at);
CREATE INDEX ird_annex_events__tenant_id_occurred_at__idx ON identity.ird_annex_events (tenant_id, occurred_at DESC);

CREATE TABLE identity.ird_annex_documents (
  id                uuid        NOT NULL,
  tenant_id         uuid,
  record_id         uuid        NOT NULL,
  bucket            text        NOT NULL DEFAULT 'identity-assets',
  object_path       text        NOT NULL,
  original_filename text        NOT NULL,
  content_type      text        NOT NULL,
  size_bytes        integer     NOT NULL,
  sha256            bytea       NOT NULL,
  scan_state        text        NOT NULL DEFAULT 'pending',                     -- 08 A17 P-19
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  CONSTRAINT ird_annex_documents__pk PRIMARY KEY (id),
  CONSTRAINT ird_annex_documents__record__fk FOREIGN KEY (tenant_id, record_id) REFERENCES identity.ird_annex_records (tenant_id, id),
  CONSTRAINT ird_annex_documents__record_id__fk FOREIGN KEY (record_id) REFERENCES identity.ird_annex_records (id),
  CONSTRAINT ird_annex_documents__path__ck CHECK (split_part(object_path,'/',1) = coalesce(tenant_id::text, 'platform')),
  CONSTRAINT ird_annex_documents__ctype__ck CHECK (content_type IN ('application/pdf','image/png','image/jpeg')),
  CONSTRAINT ird_annex_documents__size__ck CHECK (size_bytes BETWEEN 1 AND 15728640),
  CONSTRAINT ird_annex_documents__name__ck CHECK (char_length(original_filename) BETWEEN 1 AND 200),
  CONSTRAINT ird_annex_documents__sha__ck CHECK (octet_length(sha256) = 32),
  CONSTRAINT ird_annex_documents__scan_state__ck CHECK (scan_state IN ('pending','clean','quarantined'))
);
CREATE INDEX ird_annex_documents__record_id_created_at__idx ON identity.ird_annex_documents (record_id, created_at);
CREATE TRIGGER ird_annex_documents__mutable_columns BEFORE UPDATE ON identity.ird_annex_documents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('scan_state');          -- only the P-19 scan outcome may change

-- 4.6 tenant settings ----------------------------------------------------------------------------
CREATE TABLE identity.tenant_settings (
  tenant_id                       uuid        NOT NULL,
  calendar_display                text        NOT NULL DEFAULT 'AD',
  timezone                        text        NOT NULL DEFAULT 'Asia/Kathmandu',
  idle_timeout_minutes            integer     NOT NULL DEFAULT 15,
  absolute_session_hours          integer     NOT NULL DEFAULT 12,
  password_min_length             integer     NOT NULL DEFAULT 12,
  support_access_mode             text        NOT NULL DEFAULT 'notify',
  report_link_ttl_days            integer     NOT NULL DEFAULT 30,
  release_requires_payment        boolean     NOT NULL DEFAULT true,
  partial_release_allowed         boolean     NOT NULL DEFAULT false,
  letterhead_default              text        NOT NULL DEFAULT 'with',
  numbering_prefix                text        NOT NULL DEFAULT '',
  patient_code_pattern            text        NOT NULL DEFAULT '{prefix}{seq:8}',
  registration_no_pattern         text        NOT NULL DEFAULT '{branch}{prefix}{seq:6}',
  barcode_pattern                 text        NOT NULL DEFAULT '{prefix}{yy}{seq:8}',                -- 08 A13 D-8
  invoice_no_pattern              text        NOT NULL DEFAULT '{fy}-{seq:6}',
  credit_note_no_pattern          text        NOT NULL DEFAULT 'CN-{fy}-{seq:6}',
  receipt_no_pattern              text        NOT NULL DEFAULT 'RC-{fy}-{seq:6}',
  barcode_prefix                  text,
  accession_no_pattern            text        NOT NULL DEFAULT '{prefix}{yy}-{seq:4}',
  accession_prefix_histology      text        NOT NULL DEFAULT 'S',
  accession_prefix_cytology       text        NOT NULL DEFAULT 'C',
  accession_prefix_ihc            text        NOT NULL DEFAULT 'I',
  accession_prefix_molecular      text        NOT NULL DEFAULT 'M',
  pending_invoice_no_pattern      text,
  pending_credit_note_no_pattern  text,
  pending_effective_fy_bs         text,
  whatsapp_enabled                boolean     NOT NULL DEFAULT false,
  sms_enabled                     boolean     NOT NULL DEFAULT false,
  email_enabled                   boolean     NOT NULL DEFAULT false,
  sms_sender_id                   text,
  retention_clinical_years        integer     NOT NULL DEFAULT 5,
  retention_audit_years           integer     NOT NULL DEFAULT 5,
  retention_raw_instrument_years  integer     NOT NULL DEFAULT 1,
  auto_verification_enabled       boolean     NOT NULL DEFAULT false,
  westgard_mode                   text        NOT NULL DEFAULT 'classic',
  ird_pan                         text,
  cbms_realtime_required          boolean     NOT NULL DEFAULT false,
  abbreviated_invoice_limit_paisa bigint,
  ird_annex_1_record_id           uuid,
  legal_name_snapshot             text        NOT NULL,
  display_name                    text        NOT NULL,
  address_lines                   text[]      NOT NULL DEFAULT '{}',
  phones                          text[]      NOT NULL DEFAULT '{}',
  contact_email                   text,
  website                         text,
  logo_asset_id                   uuid,
  letterhead_header_asset_id      uuid,
  letterhead_footer_asset_id      uuid,
  receipt_footer_note             text,
  accent_color                    text,
  version                         integer     NOT NULL DEFAULT 1,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid        NOT NULL,
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid        NOT NULL,
  CONSTRAINT tenant_settings__pk PRIMARY KEY (tenant_id),
  CONSTRAINT tenant_settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT tenant_settings__logo__fk FOREIGN KEY (tenant_id, logo_asset_id) REFERENCES identity.branding_assets (tenant_id, id),
  CONSTRAINT tenant_settings__lh_header__fk FOREIGN KEY (tenant_id, letterhead_header_asset_id) REFERENCES identity.branding_assets (tenant_id, id),
  CONSTRAINT tenant_settings__lh_footer__fk FOREIGN KEY (tenant_id, letterhead_footer_asset_id) REFERENCES identity.branding_assets (tenant_id, id),
  CONSTRAINT tenant_settings__annex1__fk FOREIGN KEY (ird_annex_1_record_id) REFERENCES identity.ird_annex_records (id),
  CONSTRAINT tenant_settings__calendar__ck CHECK (calendar_display IN ('AD','BS','AD_BS','BS_AD')),
  CONSTRAINT tenant_settings__timezone__ck CHECK (timezone = 'Asia/Kathmandu'),                -- v1 only (08 A13 P-15)
  CONSTRAINT tenant_settings__idle__ck CHECK (idle_timeout_minutes BETWEEN 15 AND 30),            -- 04 A8
  CONSTRAINT tenant_settings__absolute__ck CHECK (absolute_session_hours BETWEEN 1 AND 12),        -- 04 A8
  CONSTRAINT tenant_settings__pwlen__ck CHECK (password_min_length BETWEEN 12 AND 64),            -- 04 A3
  CONSTRAINT tenant_settings__support_mode__ck CHECK (support_access_mode IN ('notify','approval_required')),
  CONSTRAINT tenant_settings__link_ttl__ck CHECK (report_link_ttl_days BETWEEN 30 AND 90),        -- 04 A10
  CONSTRAINT tenant_settings__letterhead__ck CHECK (letterhead_default IN ('with','without')),
  CONSTRAINT tenant_settings__prefix__ck CHECK (numbering_prefix ~ '^[A-Z0-9]{0,8}$'),
  CONSTRAINT tenant_settings__patterns_len__ck CHECK (
        char_length(patient_code_pattern) <= 40 AND char_length(registration_no_pattern) <= 40
    AND char_length(barcode_pattern) <= 40 AND char_length(invoice_no_pattern) <= 40
    AND char_length(credit_note_no_pattern) <= 40 AND char_length(receipt_no_pattern) <= 40
    AND char_length(accession_no_pattern) <= 40),
  CONSTRAINT tenant_settings__prefixes4__ck CHECK (
        (barcode_prefix IS NULL OR barcode_prefix ~ '^[A-Z0-9]{0,4}$')
    AND accession_prefix_histology ~ '^[A-Z0-9]{0,4}$' AND accession_prefix_cytology ~ '^[A-Z0-9]{0,4}$'
    AND accession_prefix_ihc ~ '^[A-Z0-9]{0,4}$' AND accession_prefix_molecular ~ '^[A-Z0-9]{0,4}$'),   -- CR-C5-009, CR-C11-005
  CONSTRAINT tenant_settings__fiscal_patterns__ck CHECK (
        invoice_no_pattern ~ '\{fyl?\}' AND credit_note_no_pattern ~ '\{fyl?\}' AND receipt_no_pattern ~ '\{fyl?\}'
    AND (pending_invoice_no_pattern IS NULL OR pending_invoice_no_pattern ~ '\{fyl?\}')
    AND (pending_credit_note_no_pattern IS NULL OR pending_credit_note_no_pattern ~ '\{fyl?\}')),
  CONSTRAINT tenant_settings__registration_branch__ck CHECK (registration_no_pattern LIKE '%{branch}%'),
  CONSTRAINT tenant_settings__pending_fy__ck CHECK (
        (pending_effective_fy_bs IS NULL) = (pending_invoice_no_pattern IS NULL AND pending_credit_note_no_pattern IS NULL)
    AND (pending_effective_fy_bs IS NULL OR pending_effective_fy_bs ~ '^[0-9]{4}/[0-9]{2}$')),
  CONSTRAINT tenant_settings__sender__ck CHECK (sms_sender_id IS NULL OR sms_sender_id ~ '^[A-Za-z0-9]{1,11}$'),
  CONSTRAINT tenant_settings__retention__ck CHECK (
        retention_clinical_years BETWEEN 5 AND 50 AND retention_audit_years BETWEEN 5 AND 50
    AND retention_raw_instrument_years BETWEEN 1 AND 50),                                          -- 04 I8 floors, B15
  CONSTRAINT tenant_settings__westgard__ck CHECK (westgard_mode IN ('classic','modern')),
  CONSTRAINT tenant_settings__abbrev__ck CHECK (abbreviated_invoice_limit_paisa IS NULL OR abbreviated_invoice_limit_paisa >= 0),
  CONSTRAINT tenant_settings__names__ck CHECK (char_length(legal_name_snapshot) BETWEEN 1 AND 200 AND char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT tenant_settings__contact__ck CHECK (
        cardinality(address_lines) <= 4 AND cardinality(phones) <= 3                                    -- 08 §4.12 (element lengths ≤120 / ≤40 validated by C2 and the trigger below)
    AND coalesce(char_length(contact_email),0) <= 254 AND (website IS NULL OR (website ~ '^https://' AND char_length(website) <= 200))
    AND coalesce(char_length(receipt_footer_note),0) <= 200
    AND (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$'))
);

CREATE FUNCTION identity.tenant_settings__check_arrays() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.address_lines) l WHERE char_length(l) > 120)
     OR EXISTS (SELECT 1 FROM unnest(NEW.phones) p WHERE char_length(p) > 40) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'branding_line_too_long';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_settings__check_arrays BEFORE INSERT OR UPDATE ON identity.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION identity.tenant_settings__check_arrays();

-- 4.7 feature flags -----------------------------------------------------------------------------------
CREATE TABLE identity.feature_flags (
  tenant_id    uuid        NOT NULL,
  flag_code    text        NOT NULL,
  is_enabled   boolean     NOT NULL,
  approval_ref text,
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        NOT NULL,
  CONSTRAINT feature_flags__pk PRIMARY KEY (tenant_id, flag_code),
  CONSTRAINT feature_flags__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT feature_flags__flag__fk FOREIGN KEY (flag_code) REFERENCES identity.g_feature_flags (code),
  CONSTRAINT feature_flags__approval_len__ck CHECK (approval_ref IS NULL OR char_length(approval_ref) BETWEEN 3 AND 200)
);
CREATE FUNCTION identity.feature_flags__check_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.is_enabled AND NEW.approval_ref IS NULL AND EXISTS (
       SELECT 1 FROM identity.g_feature_flags g WHERE g.code = NEW.flag_code AND g.requires_founder_approval) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'feature_flag_requires_approval';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feature_flags__check_approval BEFORE INSERT OR UPDATE ON identity.feature_flags
  FOR EACH ROW EXECUTE FUNCTION identity.feature_flags__check_approval();

-- 4.15 audit exports ----------------------------------------------------------------------------------
CREATE TABLE identity.audit_exports (
  id                          uuid        NOT NULL,
  tenant_id                   uuid        NOT NULL,
  requested_by_membership_id  uuid        NOT NULL,
  source                      text        NOT NULL,
  filters                     jsonb       NOT NULL,
  range_from                  timestamptz NOT NULL,
  range_to                    timestamptz NOT NULL,
  status                      text        NOT NULL DEFAULT 'queued',
  row_count                   integer,
  object_path                 text,
  sha256                      bytea,
  size_bytes                  bigint,
  downloads_remaining         integer     NOT NULL DEFAULT 3,
  ready_at                    timestamptz,
  expires_at                  timestamptz,
  last_downloaded_at          timestamptz,
  error_code                  text,
  version                     integer     NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  uuid        NOT NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid        NOT NULL,
  CONSTRAINT audit_exports__pk PRIMARY KEY (id),
  CONSTRAINT audit_exports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT audit_exports__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT audit_exports__requester__fk FOREIGN KEY (tenant_id, requested_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT audit_exports__source__ck CHECK (source IN ('audit_log','access_log','auth_events')),
  CONSTRAINT audit_exports__status__ck CHECK (status IN ('queued','building','ready','failed','expired')),
  CONSTRAINT audit_exports__range__ck CHECK (range_to > range_from AND range_to - range_from <= interval '31 days'),
  CONSTRAINT audit_exports__rows__ck CHECK (row_count IS NULL OR row_count BETWEEN 0 AND 500000),
  CONSTRAINT audit_exports__downloads__ck CHECK (downloads_remaining BETWEEN 0 AND 3),
  CONSTRAINT audit_exports__ready__ck CHECK (status <> 'ready' OR (object_path IS NOT NULL AND sha256 IS NOT NULL AND expires_at IS NOT NULL)),
  CONSTRAINT audit_exports__path__ck CHECK (object_path IS NULL OR split_part(object_path,'/',1) = tenant_id::text)
);
CREATE INDEX audit_exports__tenant_id_created_at__idx ON identity.audit_exports (tenant_id, created_at DESC);
CREATE INDEX audit_exports__tenant_id_requester_created_at__idx ON identity.audit_exports (tenant_id, requested_by_membership_id, created_at DESC);
CREATE INDEX audit_exports__status_expires_at__p_idx ON identity.audit_exports (expires_at) WHERE status = 'ready';

-- 4.16 access reviews ---------------------------------------------------------------------------------
CREATE TABLE identity.access_reviews (
  id                         uuid        NOT NULL,
  tenant_id                  uuid        NOT NULL,
  reviewed_by_membership_id  uuid        NOT NULL,
  memberships_reviewed       integer     NOT NULL,
  notes                      text,
  reviewed_at                timestamptz NOT NULL DEFAULT now(),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid        NOT NULL,
  CONSTRAINT access_reviews__pk PRIMARY KEY (id),
  CONSTRAINT access_reviews__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT access_reviews__reviewer__fk FOREIGN KEY (tenant_id, reviewed_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT access_reviews__count__ck CHECK (memberships_reviewed >= 0),
  CONSTRAINT access_reviews__notes__ck CHECK (notes IS NULL OR char_length(notes) <= 2000)
);
CREATE INDEX access_reviews__tenant_id_reviewed_at__idx ON identity.access_reviews (tenant_id, reviewed_at DESC);

-- 4.17 platform events --------------------------------------------------------------------------------
CREATE TABLE identity.platform_events (
  id                      uuid        NOT NULL,
  event_type              text        NOT NULL,
  target_type             text        NOT NULL,
  target_id               uuid,
  target_tenant_id        uuid,
  detail                  jsonb       NOT NULL DEFAULT '{}',
  actor_platform_staff_id uuid,
  request_id              uuid,
  client_ip               inet,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid        NOT NULL,
  CONSTRAINT platform_events__pk PRIMARY KEY (id),
  CONSTRAINT platform_events__type__ck CHECK (event_type IN (
    'platform_staff_invited','platform_staff_changed','platform_staff_deactivated','platform_mfa_enrolled','platform_mfa_reset',   -- + platform_mfa_enrolled (08 A25 D-215)
    'platform_session_revoked','annex_1_changed','ird_document_downloaded','dead_letter_viewed','dead_letter_replayed','dead_letter_discarded',   -- + ird_document_downloaded [CONV]
    'bootstrap_admin_created','tenant_provisioned','tenant_status_changed','feature_flag_changed','support_session_changed')),
  CONSTRAINT platform_events__target_type__ck CHECK (char_length(target_type) BETWEEN 1 AND 40)
);
CREATE INDEX platform_events__occurred_at__idx ON identity.platform_events (occurred_at DESC);
CREATE INDEX platform_events__target_tenant_id_occurred_at__idx ON identity.platform_events (target_tenant_id, occurred_at DESC);

-- 4.18 admin notices ----------------------------------------------------------------------------------
CREATE TABLE identity.admin_notices (
  id                         uuid        NOT NULL,
  tenant_id                  uuid        NOT NULL,
  kind                       text        NOT NULL,
  subject_type               text        NOT NULL,
  subject_id                 uuid,                                              -- NULL only for login_ip_throttled (08 A25 D-217)
  created_for_membership_id  uuid,
  dismissed_by               uuid[]      NOT NULL DEFAULT '{}',
  expires_at                 timestamptz NOT NULL,
  version                    integer     NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid        NOT NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid        NOT NULL,
  CONSTRAINT admin_notices__pk PRIMARY KEY (id),
  CONSTRAINT admin_notices__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT admin_notices__for__fk FOREIGN KEY (tenant_id, created_for_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT admin_notices__kind__ck CHECK (kind IN ('support_session_requested','support_session_started','audit_export_created','access_review_due',
                                                   'login_ip_throttled')),                             -- 08 Addendum A1
  CONSTRAINT admin_notices__subject__ck CHECK (subject_type IN ('support_session','audit_export','access_review','auth_event')
                                               AND (subject_id IS NOT NULL OR kind = 'login_ip_throttled'))
);
CREATE INDEX admin_notices__tenant_id_created_at__idx ON identity.admin_notices (tenant_id, created_at DESC);

-- RLS: enable + force on every non-g table --------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','mfa_factors','auth_events','invitations','platform_staff','tenant_settings',
    'feature_flags','branding_assets','support_sessions','ird_annex_records','ird_annex_events','ird_annex_documents',
    'audit_exports','access_reviews','platform_events','admin_notices'] LOOP
    EXECUTE format('ALTER TABLE identity.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE identity.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Tenant policies (§5.2): one generator, so the P-16 guard is in the predicate that is actually transcribed (08 A17 P-16).
-- pred_t = tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) — USING and WITH CHECK of EVERY __tenant policy.
DO $$
DECLARE
  pred_t constant text := 'tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())';
  r record; c text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('sessions',            ARRAY['select','insert','update']),   -- insert: pre-auth paths after bindTenant (08 A25 D-212)
      ('mfa_factors',         ARRAY['select','insert','update']),
      ('auth_events',         ARRAY['select','insert']),
      ('invitations',         ARRAY['select','insert','update']),
      ('tenant_settings',     ARRAY['select','insert','update']),
      ('feature_flags',       ARRAY['select','insert','update']),
      ('branding_assets',     ARRAY['select','insert','update']),
      ('support_sessions',    ARRAY['select','update']),
      ('ird_annex_records',   ARRAY['select']),
      ('ird_annex_events',    ARRAY['select']),
      ('ird_annex_documents', ARRAY['select']),
      ('audit_exports',       ARRAY['select','insert','update']),
      ('access_reviews',      ARRAY['select','insert']),
      ('admin_notices',       ARRAY['select','insert','update'])) AS v(t, cmds) LOOP
    FOREACH c IN ARRAY r.cmds LOOP
      EXECUTE format('CREATE POLICY %I ON identity.%I FOR %s TO lims_app %s', r.t || '__' || c || '__tenant', r.t, upper(c),
        CASE c WHEN 'select' THEN format('USING (%s)', pred_t)
               WHEN 'insert' THEN format('WITH CHECK (%s)', pred_t)
               ELSE format('USING (%s) WITH CHECK (%s)', pred_t, pred_t) END);
    END LOOP;
  END LOOP;
END $$;
-- 08 A25 D-216: tenant claims read exactly the platform Annex 1 row their settings reference (verbatim from D-216)
CREATE POLICY ird_annex_records__select__tenant_platform_ref ON identity.ird_annex_records FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND annex_code = 'annex_1'
         AND id = (SELECT ts.ird_annex_1_record_id FROM identity.tenant_settings ts WHERE ts.tenant_id = (SELECT app.current_tenant_id()))
         AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_settings__select__platform ON identity.tenant_settings FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY tenant_settings__update__platform ON identity.tenant_settings FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));

CREATE POLICY sessions__select__own ON identity.sessions FOR SELECT TO lims_app
  USING (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
         AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__insert__own ON identity.sessions FOR INSERT TO lims_app
  WITH CHECK (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
              AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__update__own ON identity.sessions FOR UPDATE TO lims_app
  USING (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
         AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()))
  WITH CHECK (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
         AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
-- __own_user: every session of the calling user in the calling tenant (partner self-service, 08 A19 D-101; no guard — shared_with: [partner])
CREATE POLICY sessions__select__own_user ON identity.sessions FOR SELECT TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY sessions__update__own_user ON identity.sessions FOR UPDATE TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
-- mfa_factors __own (user's own factors, tenant or tenant-less; partner self-service):
CREATE POLICY mfa_factors__select__own ON identity.mfa_factors FOR SELECT TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY mfa_factors__insert__own ON identity.mfa_factors FOR INSERT TO lims_app
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY mfa_factors__update__own ON identity.mfa_factors FOR UPDATE TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()))
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__select__platform ON identity.sessions FOR SELECT TO lims_app
  USING (kind = 'platform' AND tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY sessions__update__platform ON identity.sessions FOR UPDATE TO lims_app
  USING (kind = 'platform' AND tenant_id IS NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (kind = 'platform' AND tenant_id IS NULL AND (SELECT app.is_platform_actor()));
-- 08 A28.1: platform rows after login (platform-context operations, 02-TRD §5.10)
DO $$ DECLARE t text; c text; pred constant text := 'tenant_id IS NULL AND (SELECT app.is_platform_actor())'; BEGIN
  FOREACH t IN ARRAY ARRAY['mfa_factors','invitations'] LOOP
    FOREACH c IN ARRAY ARRAY['select','insert','update'] LOOP
      EXECUTE format('CREATE POLICY %I ON identity.%I FOR %s TO lims_app %s', t || '__' || c || '__platform', t, upper(c),
        CASE c WHEN 'select' THEN format('USING (%s)', pred) WHEN 'insert' THEN format('WITH CHECK (%s)', pred)
               ELSE format('USING (%s) WITH CHECK (%s)', pred, pred) END);
    END LOOP;
  END LOOP; END $$;

-- Owner policies for the §6 DEFINER functions (§5.4; 08 A10.5, A12, A15). FORCE RLS applies to lims_owner; each policy admits only
-- what the named function reads or writes. Parameter-bound lookups match on the transaction-local app.pre_* GUCs that the function
-- sets with set_config(…, true) and resets to '' before returning (08 A12.1, A15.1); every cross-tenant maintenance branch is gated
-- on app.maintenance = '<function name>' (08 A12.2, A15.3: no static maintenance policy). All are TO lims_owner only: a lims_app
-- session that sets these GUCs gains nothing (§11 test 24).
-- The core.* owner policies (memberships, users, tenants, roles, membership_roles) are C0's (C0 05-SCHEMA §10; mirrored in §10.2).
-- app.is_platform_actor(), app.identity_bootstrap_platform_admin(), and the platform_staff joins of §10.3 (decided, 08 A10.5):
CREATE POLICY platform_staff__select__owner_only ON identity.platform_staff FOR SELECT TO lims_owner
  USING (true);                                                   -- only allowlisted USING (true) (C0 02-TRD §4.2)
-- app.identity_bootstrap_platform_admin():
CREATE POLICY platform_staff__insert__owner_only ON identity.platform_staff FOR INSERT TO lims_owner
  WITH CHECK (role_code = 'platform_superadmin');
CREATE POLICY platform_events__insert__owner_only ON identity.platform_events FOR INSERT TO lims_owner
  WITH CHECK (event_type = 'bootstrap_admin_created');
-- app.identity_record_auth_event():
CREATE POLICY auth_events__insert__owner_only ON identity.auth_events FOR INSERT TO lims_owner
  WITH CHECK (tenant_id IS NULL);
-- app.identity_purge_auth_events() (08 A12.2: app.maintenance; every deletable row is older than 5 years — retention_audit_years >= 5,
-- tenant-less rows 5 years, §9):
CREATE POLICY auth_events__select__owner_only ON identity.auth_events FOR SELECT TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_purge_auth_events' AND occurred_at < now() - interval '5 years')
      OR (current_setting('app.maintenance', true) = 'identity_notify_ip_throttle'                  -- 08 A28.4
          AND tenant_id IS NULL AND event_type = 'login_failed' AND email_hmac IS NOT NULL));
CREATE POLICY auth_events__delete__owner_only ON identity.auth_events FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_purge_auth_events' AND occurred_at < now() - interval '5 years');
-- identity.tenant_settings: app.identity_login_context() (the chosen membership's tenant, 08 A12.1) and
-- app.identity_purge_auth_events() (every tenant's retention_audit_years; no narrower row predicate exists, 08 A12.2):
CREATE POLICY tenant_settings__select__owner_only ON identity.tenant_settings FOR SELECT TO lims_owner
  USING (tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid
      OR current_setting('app.maintenance', true) = 'identity_purge_auth_events');
-- identity.sessions: app.identity_purge_sessions() (expiry, gated on app.maintenance, 08 A15.3), app.identity_session_by_token()
-- (current or previous hash) and app.identity_resolve_session() (GoTrue session id) — one SELECT owner policy, predicates ORed (08 A12.1):
CREATE POLICY sessions__select__owner_only ON identity.sessions FOR SELECT TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now())
      OR token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex')
      OR previous_token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex')
      OR gotrue_session_id = nullif(current_setting('app.pre_gotrue_session_id', true), '')::uuid
      OR (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));      -- 08 A28.1
-- app.identity_platform_auth_write_session_insert / _session_update (08 A28.1):
CREATE POLICY sessions__insert__owner_only ON identity.sessions FOR INSERT TO lims_owner
  WITH CHECK (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
CREATE POLICY sessions__update__owner_only ON identity.sessions FOR UPDATE TO lims_owner
  USING (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid)
  WITH CHECK (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
CREATE POLICY sessions__delete__owner_only ON identity.sessions FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now());
-- identity.admin_notices: app.identity_purge_sessions() (08 A15.3):
CREATE POLICY admin_notices__select__owner_only ON identity.admin_notices FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now());
CREATE POLICY admin_notices__delete__owner_only ON identity.admin_notices FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now());
-- identity.mfa_factors: app.identity_login_context() — the user, and the chosen membership's tenant or, with no membership
-- (app.pre_tenant_id = '' → NULL), the user's tenant-less factors (platform staff; 08 A12.1, A15.2):
CREATE POLICY mfa_factors__select__owner_only ON identity.mfa_factors FOR SELECT TO lims_owner
  USING (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid
         AND tenant_id IS NOT DISTINCT FROM nullif(current_setting('app.pre_tenant_id', true), '')::uuid);
-- app.identity_platform_auth_write_mfa_factor (08 A28.1):
CREATE POLICY mfa_factors__insert__owner_only ON identity.mfa_factors FOR INSERT TO lims_owner
  WITH CHECK (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
CREATE POLICY mfa_factors__update__owner_only ON identity.mfa_factors FOR UPDATE TO lims_owner
  USING (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid) WITH CHECK (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
-- app.identity_platform_auth_write_staff_login (08 A28.1):
CREATE POLICY platform_staff__update__owner_only ON identity.platform_staff FOR UPDATE TO lims_owner
  USING (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
-- identity.support_sessions: app.identity_expire_support_sessions() (UPDATE … WHERE: SELECT policy must admit the old and the new
-- row; gated on app.maintenance, 08 A15.3) and app.identity_resolve_session() (the session row's support_session_id, 08 A15.1;
-- the session's tenant, 08 A12.1):
CREATE POLICY support_sessions__select__owner_only ON identity.support_sessions FOR SELECT TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_expire_support_sessions'
          AND ((status = 'requested' AND requested_at < now() - interval '24 hours')
            OR (status = 'approved'  AND decided_at   < now() - interval '60 minutes')
            OR (status = 'active'    AND expires_at   <= now())
            OR (status = 'expired'   AND end_reason = 'expired')))
      OR id = nullif(current_setting('app.pre_support_session_id', true), '')::uuid
      OR tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid);
CREATE POLICY support_sessions__update__owner_only ON identity.support_sessions FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_expire_support_sessions'
         AND ((status = 'requested' AND requested_at < now() - interval '24 hours')
           OR (status = 'approved'  AND decided_at   < now() - interval '60 minutes')
           OR (status = 'active'    AND expires_at   <= now())))
  WITH CHECK (current_setting('app.maintenance', true) = 'identity_expire_support_sessions'
              AND status = 'expired' AND end_reason = 'expired');
-- app.identity_expire_invitations() (one UPDATE, 08 A12.6; <e>: expire; <r>: clear email 30 days after a terminal state; 08 A15.3):
CREATE POLICY invitations__select__owner_only ON identity.invitations FOR SELECT TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_expire_invitations'
         AND ((status IN ('pending','sent') AND expires_at < now())
           OR (email IS NOT NULL AND status IN ('accepted','expired','revoked','failed') AND updated_at < now() - interval '30 days')
           OR status = 'expired'
           OR (email IS NULL AND status IN ('accepted','expired','revoked','failed'))))
      OR (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));                                  -- 08 A28.1 invitation_accept
CREATE POLICY invitations__update__owner_only ON identity.invitations FOR UPDATE TO lims_owner
  USING ((current_setting('app.maintenance', true) = 'identity_expire_invitations'
          AND ((status IN ('pending','sent') AND expires_at < now())
            OR (email IS NOT NULL AND status IN ('accepted','expired','revoked','failed') AND updated_at < now() - interval '30 days')))
      OR (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid))
  WITH CHECK ((current_setting('app.maintenance', true) = 'identity_expire_invitations'
               AND (status = 'expired' OR (email IS NULL AND status IN ('accepted','expired','revoked','failed'))))
           OR (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));
-- app.identity_expire_audit_exports() (08 A15.3):
CREATE POLICY audit_exports__select__owner_only ON identity.audit_exports FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_expire_audit_exports'
         AND ((status = 'ready' AND (expires_at <= now() OR downloads_remaining = 0)) OR status = 'expired'
           OR (status IN ('expired','failed') AND created_at < now() - interval '1 year')));
CREATE POLICY audit_exports__delete__owner_only ON identity.audit_exports FOR DELETE TO lims_owner      -- 1-year row purge (08 A17 P-18(c))
  USING (current_setting('app.maintenance', true) = 'identity_expire_audit_exports'
         AND status IN ('expired','failed') AND created_at < now() - interval '1 year');
CREATE POLICY audit_exports__update__owner_only ON identity.audit_exports FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_expire_audit_exports'
         AND status = 'ready' AND (expires_at <= now() OR downloads_remaining = 0))
  WITH CHECK (current_setting('app.maintenance', true) = 'identity_expire_audit_exports' AND status = 'expired');

-- Grants (02-CV §5.9; classes §4) -----------------------------------------------------------------------
GRANT USAGE ON SCHEMA identity TO lims_app;
GRANT SELECT ON identity.g_feature_flags, identity.g_breached_passwords TO lims_app;
GRANT SELECT, INSERT, UPDATE ON identity.sessions, identity.mfa_factors, identity.invitations, identity.platform_staff,
  identity.tenant_settings, identity.feature_flags, identity.branding_assets, identity.support_sessions,
  identity.ird_annex_records, identity.audit_exports, identity.admin_notices TO lims_app;
GRANT SELECT, INSERT ON identity.auth_events, identity.ird_annex_events, identity.ird_annex_documents,
  identity.access_reviews, identity.platform_events TO lims_app;
GRANT UPDATE (scan_state) ON identity.ird_annex_documents TO lims_app;   -- P-19 re-scan; trigger allows nothing else
-- no DELETE grants on any identity table (purge via §6 maintenance functions)
```

### 10.2 `core` DDL proposal — none; `__platform` policies on `core` tables

No `core` column/constraint/index proposal remains: the CR-C2-003 remainder is merged into C0 05-SCHEMA §10 (08 Addendum A3.4) and mirrored in §3.1. The `__platform` policies of §5.3 on `core.dead_letters` and `core.tenants` are below (C0 writes them in its migrations). The `core.dead_letters` policies serve `ctx.core.deadLetters`, which runs under platform claims; C2 itself holds no direct UPDATE on `core.dead_letters` and writes dead letters only through `ctx.core.deadLetters` (08 A8.6):

```sql
-- core.dead_letters: tenant rows only; NULL-tenant rows only through the C0 app.dl_* DEFINERs (08 A10.4). C0 05-SCHEMA §10 wins:
-- dead_letters__select__platform / dead_letters__update__platform are created by C0's §10 DDL (same predicates,
-- USING / WITH CHECK (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()))); this file does not create them again.
CREATE POLICY tenants__select__platform ON core.tenants FOR SELECT TO lims_app USING ((SELECT app.is_platform_actor()));
CREATE POLICY tenants__insert__platform ON core.tenants FOR INSERT TO lims_app WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY tenants__update__platform ON core.tenants FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));
```

Owner policies on `core` tables that the §6 pre-tenant lookups need (08 A12.1; §5.4). **Mirror of C0 05-SCHEMA §10 — C0 writes them and wins on conflict**; listed here so the §5.4 audit is complete:

| Policy (`TO lims_owner`, FOR SELECT) | USING | Serves |
|---|---|---|
| `memberships__select__owner_only` | `tenant_id = (SELECT app.current_tenant_id()) OR user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid` | C0 centre helpers (first branch); `app.identity_resolve_session`, `app.identity_login_context` (second) |
| `users__select__owner_only` | `id = nullif(current_setting('app.pre_user_id', true), '')::uuid OR (current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL)` | `app.identity_user_exists` (first branch); `app.identity_tenants_for_email_hmacs` (second, 08 A25 D-217) |
| `tenants__select__owner_only` | `id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid OR current_setting('app.maintenance', true) IN ('platform_list_tenants','cron_tenant_ids')` + further C0 branches (C0 05-SCHEMA §4.3: `tenant_code = app.pre_tenant_code`, 08 A19 D-121) | `app.identity_resolve_session` (incl. the support tenant of a `platform` session, 08 A20.1), `app.identity_login_context`; C0 `app.platform_list_tenants` (08 A12.3), `app.cron_tenant_ids` (08 A23.1) |
| `roles__select__owner_only` | `tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid` | `app.identity_login_context` |
| `membership_roles__select__owner_only` | `tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid AND EXISTS (SELECT 1 FROM core.memberships m WHERE m.tenant_id = membership_roles.tenant_id AND m.id = membership_roles.membership_id AND m.user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid)` | `app.identity_login_context` |

### 10.3 `app` functions (CR-C2-004/005; DEFINER inventory)

```sql
-- Pre-tenant lookups (08 A12.1). Each sets the transaction-local app.pre_* GUCs with set_config(name, value, true) before each
-- read, so the TO lims_owner policies of §5.4 / §10.1 / C0 §10 admit exactly the looked-up rows, and resets every GUC it set to ''
-- before returning. VOLATILE because set_config changes session state.
CREATE FUNCTION app.identity_resolve_session(p_gotrue_session_id uuid, p_sub uuid)
RETURNS TABLE (session_id uuid, kind text, state text, session_aal text, tenant_id uuid, tenant_status text,
               membership_id uuid, membership_status text, membership_locked boolean,   -- = m.locked_at IS NOT NULL (08 A3.4)
               partner_role text,                                                       -- = m.partner_role (08 A28.3; claims partner_role)
               platform_staff_id uuid, platform_role text, platform_allowed_cidrs cidr[],
               support_session_id uuid, support_tenant_id uuid, support_tenant_status text, support_scope text,
               support_expires_at timestamptz, idle_expires_at timestamptz, absolute_expires_at timestamptz,
               revoked_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_tenant_id          uuid;
  v_support_session_id uuid;
  v_support_tenant_id  uuid;
BEGIN
  PERFORM set_config('app.pre_gotrue_session_id', coalesce(p_gotrue_session_id::text, ''), true);   -- sessions__select__owner_only
  PERFORM set_config('app.pre_user_id', coalesce(p_sub::text, ''), true);                           -- memberships__select__owner_only
  SELECT s.tenant_id, s.support_session_id INTO v_tenant_id, v_support_session_id
    FROM identity.sessions s
   WHERE s.gotrue_session_id = p_gotrue_session_id AND s.user_id = p_sub;
  -- a platform session has tenant_id NULL; its support session is admitted by its id (support_sessions__select__owner_only, 08 A15.1)
  PERFORM set_config('app.pre_support_session_id', coalesce(v_support_session_id::text, ''), true);
  IF v_tenant_id IS NULL AND v_support_session_id IS NOT NULL THEN
    -- 08 A20.1: the active, unexpired support session names the tenant whose status is support_tenant_status
    SELECT ss.tenant_id INTO v_support_tenant_id
      FROM identity.support_sessions ss
     WHERE ss.id = v_support_session_id AND ss.status = 'active' AND ss.expires_at > now();
  END IF;
  -- the session's tenant (tenant kinds; 08 A12.1) or the support tenant (platform kind; 08 A20.1) admits core.tenants and
  -- identity.support_sessions; '' when there is none
  PERFORM set_config('app.pre_tenant_id', coalesce(v_tenant_id::text, v_support_tenant_id::text, ''), true);
  RETURN QUERY
  SELECT s.id, s.kind, s.state, s.aal, s.tenant_id, t.status,
         s.membership_id, m.status, (m.locked_at IS NOT NULL), m.partner_role,
         s.platform_staff_id, ps.role_code, ps.allowed_cidrs,
         ss.id, ss.tenant_id, st.status, ss.scope, ss.expires_at,
         s.idle_expires_at, s.absolute_expires_at, s.revoked_at
  FROM identity.sessions s
  LEFT JOIN core.tenants t            ON t.id = s.tenant_id
  LEFT JOIN core.memberships m        ON m.tenant_id = s.tenant_id AND m.id = s.membership_id
  LEFT JOIN identity.platform_staff ps ON ps.id = s.platform_staff_id AND ps.is_active
  LEFT JOIN identity.support_sessions ss ON ss.id = s.support_session_id AND ss.status = 'active' AND ss.expires_at > now()
  LEFT JOIN core.tenants st           ON st.id = ss.tenant_id
  WHERE s.gotrue_session_id = p_gotrue_session_id AND s.user_id = p_sub;
  PERFORM set_config('app.pre_gotrue_session_id', '', true);
  PERFORM set_config('app.pre_user_id', '', true);
  PERFORM set_config('app.pre_tenant_id', '', true);
  PERFORM set_config('app.pre_support_session_id', '', true);
  RETURN;
END $$;

CREATE FUNCTION app.identity_session_by_token(p_token_sha256 bytea)
RETURNS TABLE (session_id uuid, kind text, state text, tenant_id uuid, user_id uuid, membership_id uuid,
               platform_staff_id uuid, support_session_id uuid, token_reused boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.pre_session_token_sha256', coalesce(encode(p_token_sha256, 'hex'), ''), true);   -- 08 A12.1
  RETURN QUERY
  SELECT s.id, s.kind, s.state, s.tenant_id, s.user_id, s.membership_id, s.platform_staff_id, s.support_session_id, false
  FROM identity.sessions s
  WHERE s.token_sha256 = p_token_sha256 AND s.state NOT IN ('revoked','expired')
  UNION ALL
  -- CR-C2-018 (08 Addendum A3.1): rotated-out app token presented again. The caller (identity auth service) revokes the
  -- session (revoke_reason 'token_reuse') and writes auth event 'session_token_reused' in the same transaction.
  SELECT s.id, s.kind, s.state, s.tenant_id, s.user_id, s.membership_id, s.platform_staff_id, s.support_session_id, true
  FROM identity.sessions s
  WHERE s.previous_token_sha256 = p_token_sha256 AND s.state NOT IN ('revoked','expired');
  PERFORM set_config('app.pre_session_token_sha256', '', true);
  RETURN;
END $$;

CREATE FUNCTION app.identity_login_context(p_user_id uuid)
RETURNS TABLE (platform_staff_id uuid, platform_role text, platform_active boolean, platform_allowed_cidrs cidr[],
               membership_count integer, tenant_id uuid, tenant_status text, membership_id uuid,
               membership_status text, membership_locked boolean, mfa_required boolean, has_verified_factor boolean,   -- membership_locked = locked_at IS NOT NULL (08 A3.4)
               idle_timeout_minutes integer, absolute_session_hours integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_count integer;
  v_one   core.memberships%ROWTYPE;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- p_user_id = GoTrue sub (08 A12.1)
  -- 08 A6.6: only status = 'active' AND actor_type = 'user' count; deactivated never trigger identity_multi_membership
  SELECT count(*)::int INTO v_count
    FROM core.memberships m WHERE m.user_id = p_user_id AND m.actor_type = 'user' AND m.status = 'active';
  -- 08 A8.1: the active membership (at most one, R27/A3.4); if none is active, the most recently updated one
  SELECT m.* INTO v_one
    FROM core.memberships m WHERE m.user_id = p_user_id AND m.actor_type = 'user'
   ORDER BY (m.status = 'active') DESC, m.updated_at DESC LIMIT 1;
  -- set after the membership is chosen (08 A12.1); '' when the user has no user membership (platform staff only)
  PERFORM set_config('app.pre_tenant_id', coalesce(v_one.tenant_id::text, ''), true);
  RETURN QUERY
  SELECT ps.id, ps.role_code, ps.is_active, ps.allowed_cidrs,
         v_count,
         v_one.tenant_id, t.status, v_one.id, v_one.status, (v_one.locked_at IS NOT NULL),
         coalesce(ps.id IS NOT NULL, false) OR coalesce((
           SELECT bool_or(r.mfa_required) FROM core.membership_roles mr
           JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
           WHERE mr.tenant_id = v_one.tenant_id AND mr.membership_id = v_one.id), false),
         -- with no membership (platform staff) v_one.tenant_id is NULL and the tenant-less factors are admitted (08 A15.2)
         EXISTS (SELECT 1 FROM identity.mfa_factors f WHERE f.user_id = p_user_id AND f.status = 'verified'
                 AND f.tenant_id IS NOT DISTINCT FROM v_one.tenant_id),
         ts.idle_timeout_minutes, ts.absolute_session_hours
  FROM (SELECT 1) x
  LEFT JOIN core.tenants t ON t.id = v_one.tenant_id
  LEFT JOIN identity.tenant_settings ts ON ts.tenant_id = v_one.tenant_id
  LEFT JOIN identity.platform_staff ps ON ps.user_id = p_user_id;
  PERFORM set_config('app.pre_user_id', '', true);
  PERFORM set_config('app.pre_tenant_id', '', true);
  RETURN;
END $$;

CREATE FUNCTION app.identity_user_exists(p_user_id uuid) RETURNS boolean   -- p_user_id = GoTrue user id (sub), 08 A12.1
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_exists boolean;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- users__select__owner_only (C0)
  v_exists := EXISTS (SELECT 1 FROM core.users u WHERE u.id = p_user_id)
           OR EXISTS (SELECT 1 FROM identity.platform_staff ps WHERE ps.user_id = p_user_id);
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_exists;
END $$;

CREATE FUNCTION app.identity_record_auth_event(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p ? 'tenant_id' AND (p ->> 'tenant_id') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'tenant_events_use_rls_path';
  END IF;
  INSERT INTO identity.auth_events (id, tenant_id, user_id, platform_staff_id, session_id, event_type, reason_code,
                                    email_hmac, client_ip, user_agent, request_id, occurred_at, created_by)
  VALUES ((p ->> 'id')::uuid, NULL, nullif(p ->> 'user_id','')::uuid, nullif(p ->> 'platform_staff_id','')::uuid,
          nullif(p ->> 'session_id','')::uuid, p ->> 'event_type', p ->> 'reason_code',
          decode(nullif(p ->> 'email_hmac_hex',''), 'hex'), nullif(p ->> 'client_ip','')::inet,
          left(p ->> 'user_agent', 512), nullif(p ->> 'request_id','')::uuid, now(), (p ->> 'created_by')::uuid);
END $$;

CREATE FUNCTION app.identity_bootstrap_platform_admin(p_staff_id uuid, p_user_id uuid, p_email text,
                                                     p_display_name text, p_event_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('identity_bootstrap_platform_admin'));
  IF EXISTS (SELECT 1 FROM identity.platform_staff WHERE role_code = 'platform_superadmin' AND is_active) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'bootstrap_closed';
  END IF;
  INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, created_by, updated_by)
  VALUES (p_staff_id, p_user_id, lower(btrim(p_email)), p_display_name, 'platform_superadmin', p_user_id, p_user_id);
  INSERT INTO identity.platform_events (id, event_type, target_type, target_id, created_by)
  VALUES (p_event_id, 'bootstrap_admin_created', 'platform_staff', p_staff_id, p_user_id);
END $$;
```

Ids (`p_staff_id`, `p_event_id`) are UUIDv7 generated by the CLI (04 D9: ids generated in app code). Granted to `lims_api` only; the CLI runs once per environment (03-APP-FLOW §9.4).

Maintenance functions (owner-owned, inventoried; each body is one bounded statement wrapped in the `app.maintenance` set/reset of 08 A12.2 / A15.3, so they are plpgsql `VOLATILE`; `app.identity_expire_invitations` is one UPDATE, 08 A12.6):

```sql
CREATE FUNCTION app.identity_purge_sessions() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  -- 08 A15.3: admits sessions__{select,delete}__owner_only and admin_notices__{select,delete}__owner_only; reset before return
  PERFORM set_config('app.maintenance', 'identity_purge_sessions', true);
  WITH d AS (DELETE FROM identity.sessions WHERE expires_at < now() RETURNING 1),
       n AS (DELETE FROM identity.admin_notices WHERE expires_at < now() RETURNING 1)
  SELECT (SELECT count(*) FROM d)::int + (SELECT count(*) FROM n)::int INTO v_n;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_n;
END $$;
CREATE FUNCTION app.identity_expire_support_sessions() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  -- 08 A15.3: admits support_sessions__{select,update}__owner_only (maintenance branch); reset before return
  PERFORM set_config('app.maintenance', 'identity_expire_support_sessions', true);
  WITH u AS (
    UPDATE identity.support_sessions SET status = 'expired', end_reason = 'expired', ended_at = now(),
           updated_at = now(), version = version + 1
    WHERE (status = 'requested' AND requested_at < now() - interval '24 hours')
       OR (status = 'approved'  AND decided_at   < now() - interval '60 minutes')
       OR (status = 'active'    AND expires_at   <= now())
    RETURNING id)
  SELECT count(*)::int INTO v_n FROM u;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_n;
END $$;
CREATE FUNCTION app.identity_expire_invitations() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  -- 08 A15.3: admits invitations__{select,update}__owner_only; reset before return.
  -- 08 A12.6: one UPDATE (no two CTEs updating the same table). <e> expire pending/sent past expires_at; <r> clear email
  -- 30 days after a terminal state. The branches are disjoint (non-terminal vs terminal status); SET expressions read the old row.
  PERFORM set_config('app.maintenance', 'identity_expire_invitations', true);
  WITH u AS (
    UPDATE identity.invitations
       SET status     = CASE WHEN status IN ('pending','sent') AND expires_at < now() THEN 'expired' ELSE status END,
           email      = CASE WHEN email IS NOT NULL AND status IN ('accepted','expired','revoked','failed')
                                  AND updated_at < now() - interval '30 days' THEN NULL ELSE email END,
           updated_at = now(), version = version + 1
     WHERE (status IN ('pending','sent') AND expires_at < now())                                                         -- <e>
        OR (email IS NOT NULL AND status IN ('accepted','expired','revoked','failed') AND updated_at < now() - interval '30 days')   -- <r>
    RETURNING 1)
  SELECT count(*)::int INTO v_n FROM u;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_n;
END $$;
CREATE FUNCTION app.identity_expire_audit_exports() RETURNS TABLE (object_path text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  -- 08 A15.3: admits audit_exports__{select,update}__owner_only; reset before return
  PERFORM set_config('app.maintenance', 'identity_expire_audit_exports', true);
  RETURN QUERY
  UPDATE identity.audit_exports SET status = 'expired', updated_at = now(), version = version + 1
  WHERE status = 'ready' AND (expires_at <= now() OR downloads_remaining = 0)
  RETURNING identity.audit_exports.object_path;
  -- class E retention (§9; 08 A17 P-18(c)): rows that ended more than 1 year ago; their objects were deleted at expiry
  DELETE FROM identity.audit_exports
   WHERE status IN ('expired','failed') AND created_at < now() - interval '1 year';
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
CREATE FUNCTION app.identity_purge_auth_events() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  -- 08 A12.2: admits tenant_settings__select__owner_only and auth_events__{select,delete}__owner_only; reset before return
  PERFORM set_config('app.maintenance', 'identity_purge_auth_events', true);
  WITH d AS (
    DELETE FROM identity.auth_events e
    USING (SELECT tenant_id, retention_audit_years FROM identity.tenant_settings) ts
    WHERE e.tenant_id = ts.tenant_id AND e.occurred_at < now() - make_interval(years => ts.retention_audit_years)
    RETURNING 1),
  p AS (DELETE FROM identity.auth_events WHERE tenant_id IS NULL AND occurred_at < now() - interval '5 years' RETURNING 1)
  SELECT (SELECT count(*) FROM d)::int + (SELECT count(*) FROM p)::int INTO v_n;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_n;
END $$;
CREATE FUNCTION app.identity_load_breached_batch(p_hashes bytea[], p_version text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH i AS (INSERT INTO identity.g_breached_passwords (sha1, list_version)
             SELECT h, p_version FROM unnest(p_hashes) h WHERE octet_length(h) = 20
             ON CONFLICT (sha1) DO UPDATE SET list_version = EXCLUDED.list_version RETURNING 1)
  SELECT count(*)::int FROM i
$$;
-- after the final batch the task calls: DELETE of rows with list_version <> current via
CREATE FUNCTION app.identity_finish_breached_import(p_version text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH d AS (DELETE FROM identity.g_breached_passwords WHERE list_version <> p_version RETURNING 1) SELECT count(*)::int FROM d
$$;
-- INVOKER breached-password lookup (§4.9; review C2 m#30): lims_app holds SELECT on the G table
CREATE FUNCTION app.identity_is_breached(p_sha1 bytea) RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM identity.g_breached_passwords WHERE sha1 = p_sha1)
$$;
-- 08 A25 D-217. DDL owner: C0 (C0 05-SCHEMA §10 creates it); this text and C0's must be identical (P-41). Reads core.users through
-- users__select__owner_only (app.maintenance = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL; §10.2). Called only by
-- the worker task identity.notify_ip_throttle; no HTTP response can observe the result. C0 creates it first, so CREATE OR REPLACE
-- here (same text; smoke-load 2026-11-06).
CREATE OR REPLACE FUNCTION app.identity_tenants_for_email_hmacs(p_hmacs bytea[]) RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF coalesce(cardinality(p_hmacs), 0) > 100 THEN                    -- D-217: at most 100 values
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_tenants_for_email_hmacs_invalid_input';   -- [CONV] (dl_resolve pattern)
  END IF;
  PERFORM set_config('app.maintenance', 'identity_tenants_for_email_hmacs', true);
  RETURN QUERY SELECT DISTINCT u.tenant_id FROM core.users u WHERE u.email_hmac = ANY (p_hmacs);
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.identity_resolve_session(uuid,uuid), app.identity_session_by_token(bytea),
  app.identity_login_context(uuid), app.identity_user_exists(uuid), app.identity_record_auth_event(jsonb),
  app.identity_bootstrap_platform_admin(uuid,uuid,text,text,uuid),
  app.identity_purge_sessions(), app.identity_expire_support_sessions(), app.identity_expire_invitations(),
  app.identity_expire_audit_exports(), app.identity_purge_auth_events(),
  app.identity_load_breached_batch(bytea[],text), app.identity_finish_breached_import(text),
  app.identity_is_breached(bytea), app.identity_tenants_for_email_hmacs(bytea[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_is_breached(bytea) TO lims_app;
GRANT EXECUTE ON FUNCTION app.identity_tenants_for_email_hmacs(bytea[]) TO lims_worker;
-- 08 A28.1 — platform-staff writes during authentication (before a platform session exists). Called by the identity auth service
-- inside ctx.db.identityAuthTx (claims: identity system actor, no tenant) after app.identity_login_context /
-- app.identity_session_by_token identified the platform staff user. Each sets app.pre_user_id = p_user_id before its write; the
-- owner policies match tenant_id IS NULL AND user_id = app.pre_user_id (A12.1 pattern) and the GUC is reset before return.
-- Unknown keys or a non-platform target → P0001 identity_platform_auth_write_invalid_input [CONV].
CREATE FUNCTION app.identity_platform_auth_write_session_insert(p_user_id uuid, p_row jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v identity.sessions%ROWTYPE;
BEGIN
  v := jsonb_populate_record(NULL::identity.sessions, p_row);
  IF v.kind IS DISTINCT FROM 'platform' OR v.tenant_id IS NOT NULL OR v.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
  END IF;
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- sessions__insert__owner_only
  INSERT INTO identity.sessions SELECT v.*;
  PERFORM set_config('app.pre_user_id', '', true);
END $$;

CREATE FUNCTION app.identity_platform_auth_write_session_update(p_user_id uuid, p_session_id uuid, p_set jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v identity.sessions%ROWTYPE;
  v_n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_set) k WHERE k NOT IN ('state','aal','refresh_token_enc','access_token_enc','enc_key_id',
       'access_expires_at','last_seen_at','idle_expires_at','mfa_failed_attempts','support_session_id','revoked_at','revoked_by',
       'revoke_reason','updated_by')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
  END IF;
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- sessions__{select,update}__owner_only
  SELECT * INTO v FROM identity.sessions s
   WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.kind = 'platform' AND s.tenant_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.pre_user_id', '', true);
    RETURN 0;
  END IF;
  v := jsonb_populate_record(v, p_set);
  UPDATE identity.sessions s
     SET state = v.state, aal = v.aal, refresh_token_enc = v.refresh_token_enc, access_token_enc = v.access_token_enc,
         enc_key_id = v.enc_key_id, access_expires_at = v.access_expires_at, last_seen_at = v.last_seen_at,
         idle_expires_at = v.idle_expires_at, mfa_failed_attempts = v.mfa_failed_attempts, support_session_id = v.support_session_id,
         revoked_at = v.revoked_at, revoked_by = v.revoked_by, revoke_reason = v.revoke_reason, updated_by = v.updated_by,
         updated_at = now(), version = s.version + 1
   WHERE s.id = p_session_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

CREATE FUNCTION app.identity_platform_auth_write_mfa_factor(p_user_id uuid, p_factor_id uuid, p_row jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
-- p_factor_id NULL → insert p_row (startMfaEnrolment); else update the factor's status columns (completeMfaEnrolment, re-enrol)
DECLARE
  v identity.mfa_factors%ROWTYPE;
  v_n integer;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- mfa_factors__{select,insert,update}__owner_only
  PERFORM set_config('app.pre_tenant_id', '', true);                             -- tenant-less factors only (A15.2 select branch)
  IF p_factor_id IS NULL THEN
    v := jsonb_populate_record(NULL::identity.mfa_factors, p_row);
    IF v.tenant_id IS NOT NULL OR v.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
    END IF;
    INSERT INTO identity.mfa_factors SELECT v.*;
    v_n := 1;
  ELSE
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_row) k WHERE k NOT IN ('status','verified_at','removed_at','removed_by',
         'removal_reason','friendly_name','is_active','updated_by')) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
    END IF;
    SELECT * INTO v FROM identity.mfa_factors f
     WHERE f.id = p_factor_id AND f.user_id = p_user_id AND f.tenant_id IS NULL FOR UPDATE;
    IF FOUND THEN
      v := jsonb_populate_record(v, p_row);
      UPDATE identity.mfa_factors f
         SET status = v.status, verified_at = v.verified_at, removed_at = v.removed_at, removed_by = v.removed_by,
             removal_reason = v.removal_reason, friendly_name = v.friendly_name, is_active = v.is_active, updated_by = v.updated_by,
             updated_at = now(), version = f.version + 1
       WHERE f.id = p_factor_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    ELSE
      v_n := 0;
    END IF;
  END IF;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

CREATE FUNCTION app.identity_platform_auth_write_invitation_accept(p_user_id uuid, p_invitation_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
-- setPasswordFromSetup for a platform-staff invite: sent → accepted; also stamps platform_staff.last_login_at
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- invitations__{select,update}__owner_only
  UPDATE identity.invitations i SET status = 'accepted', accepted_at = now(), updated_at = now(), updated_by = p_user_id,
         version = i.version + 1
   WHERE i.id = p_invitation_id AND i.tenant_id IS NULL AND i.user_id = p_user_id AND i.status = 'sent' AND i.expires_at > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

CREATE FUNCTION app.identity_platform_auth_write_staff_login(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
-- successful platform-staff login: platform_staff.last_login_at (platform-only table, no tenant_id column)
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- platform_staff__update__owner_only
  UPDATE identity.platform_staff ps SET last_login_at = now(), updated_at = now(), updated_by = p_user_id, version = ps.version + 1
   WHERE ps.user_id = p_user_id AND ps.is_active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

-- 08 A28.4 — e-mail HMACs of one IP's failure window, for the worker task identity.notify_ip_throttle (no claims). Gated by
-- app.maintenance = 'identity_notify_ip_throttle' (A12.2 pattern); at most 100 distinct values (the D-217 cap of the next call).
CREATE FUNCTION app.identity_notify_ip_throttle_hmacs(p_client_ip inet, p_since timestamptz) RETURNS SETOF bytea
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM set_config('app.maintenance', 'identity_notify_ip_throttle', true);   -- auth_events__select__owner_only
  RETURN QUERY
    SELECT DISTINCT e.email_hmac FROM identity.auth_events e
     WHERE e.tenant_id IS NULL AND e.event_type = 'login_failed' AND e.email_hmac IS NOT NULL
       AND e.client_ip = p_client_ip AND e.occurred_at >= p_since
     LIMIT 100;
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.identity_platform_auth_write_session_insert(uuid,jsonb),
  app.identity_platform_auth_write_session_update(uuid,uuid,jsonb), app.identity_platform_auth_write_mfa_factor(uuid,uuid,jsonb),
  app.identity_platform_auth_write_invitation_accept(uuid,uuid), app.identity_platform_auth_write_staff_login(uuid),
  app.identity_notify_ip_throttle_hmacs(inet,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_platform_auth_write_session_insert(uuid,jsonb),
  app.identity_platform_auth_write_session_update(uuid,uuid,jsonb), app.identity_platform_auth_write_mfa_factor(uuid,uuid,jsonb),
  app.identity_platform_auth_write_invitation_accept(uuid,uuid), app.identity_platform_auth_write_staff_login(uuid) TO lims_api;
GRANT EXECUTE ON FUNCTION app.identity_notify_ip_throttle_hmacs(inet,timestamptz) TO lims_worker;
GRANT EXECUTE ON FUNCTION app.identity_resolve_session(uuid,uuid), app.identity_session_by_token(bytea),
  app.identity_login_context(uuid), app.identity_user_exists(uuid), app.identity_record_auth_event(jsonb),
  app.identity_bootstrap_platform_admin(uuid,uuid,text,text,uuid) TO lims_api;
GRANT EXECUTE ON FUNCTION app.identity_purge_sessions(), app.identity_expire_support_sessions(),
  app.identity_expire_invitations(), app.identity_expire_audit_exports(), app.identity_purge_auth_events(),
  app.identity_load_breached_batch(bytea[],text), app.identity_finish_breached_import(text) TO lims_worker;
```

Note: maintenance functions grant to `lims_worker` only and login/claims functions to `lims_api` only (narrower than `lims_app`; C0 may adjust if its role layout differs).

## 11. Tests C0 must ship for this schema (db/tests; REQ-SEC-042)

1. Every identity table: tenant A claims → zero tenant B rows; INSERT with tenant B id fails; UPDATE/DELETE of B rows affects 0 rows.
2. Platform rows (`tenant_id IS NULL`) invisible to tenant claims and to support-session claims — with one exception (08 A25 D-216): tenant claims of A see exactly the `annex_1` row that A's `tenant_settings.ird_annex_1_record_id` references (`ird_annex_records__select__tenant_platform_ref`), and no other platform `ird_annex_records` row (a second, unreferenced Annex 1 row stays invisible; partner/patient claims of A see neither).
3. `__platform` policies false when claims `aal = 'aal1'`, when `platform_staff_id` is inactive, or when `scope` ≠ `platform`.
4. `__own` session policy cannot read another session of the same user or tenant.
5. `has_table_privilege('lims_app', 'identity.<t>', 'DELETE') = false` for all identity tables.
6. Append-only tables: UPDATE privilege absent (`auth_events`, `ird_annex_events`, `ird_annex_documents`, `access_reviews`, `platform_events`).
7. `branding_assets` mutable-column trigger rejects content changes (`immutable_row`).
8. `feature_flags__check_approval` rejects enabling a founder-approval flag without `approval_ref`.
9. CHECK constraints for every 04 range (idle 15–30, absolute ≤12, link TTL 30–90, retention floors).
10. DEFINER functions: `prosecdef` + `proconfig` contains `search_path=`; EXECUTE not granted to PUBLIC/anon/authenticated.
11. `app.identity_bootstrap_platform_admin` raises `bootstrap_closed` when an active superadmin exists.
12. Composite FK probe: `identity.sessions(tenant_id=A, membership_id=<B membership>)` insert fails.
13. `sessions__kind_shape__ck` / `sessions__idle__ck` / `sessions__absolute__ck`: each of the five kinds accepts its R10 shape and lifetimes and rejects the others (e.g. `patient` with `aal2`, `staff_mobile` without `app_instance_id`, `tenant_staff` with 14-day idle).
14. `core.membership_branches` / `core.membership_centres` insert for a `partner` or `patient` membership → `scope_user_only`; `all_centres = true` on a non-`user` membership → CHECK violation (08 R3).
15. `branding_assets__bucket__ck` rejects any bucket other than `identity-assets`; `audit_exports__path__ck` accepts `{tenant_id}/…` paths only (08 R26).
16. `tenant_settings`: `accent_color` must match `#RRGGBB`; `address_lines` > 4 or a line > 120 chars rejected; `barcode_prefix`/accession prefixes `[A-Z0-9]{0,4}` only.
17. `identity.sessions.previous_token_sha256` (CR-C2-018, 08 Addendum A3.1): a 31- or 33-byte value → `sessions__previous_token_len__ck` violation; NULL accepted; two sessions with the same non-NULL `previous_token_sha256` → `sessions__previous_token_sha256__p_uq` violation; many sessions with NULL accepted. `app.identity_session_by_token(<current token hash>)` returns the row with `token_reused = false`; `app.identity_session_by_token(<previous token hash>)` returns the same session with `token_reused = true`; both return no row once the session is `revoked` or `expired`. The index is listed in `db/meta/index-exceptions.yaml`.
18. Membership lifecycle columns (08 Addendum A3.4; C0 05-SCHEMA §10 schema tests 1–4 cover the DDL): `app.identity_resolve_session` and `app.identity_login_context` return `membership_locked = true` exactly when the membership's `locked_at IS NOT NULL`, and `membership_status` = the row's `status`; a repository write that sets `core.memberships.is_active` fails (generated column); a second `invite` of the same user while an `invited` membership exists → unique violation (mapped to `identity.user_exists`).
19. `app.identity_login_context` membership count (08 A6.6): for a staff user with one `active` `user` membership in tenant A plus one `deactivated` `user` membership in tenant B, `membership_count = 1`; adding a `patient` or `partner` membership of the same user leaves it at 1; a user whose only `user` membership is `deactivated` gets `membership_count = 0`. The predicate is `status = 'active' AND actor_type = 'user'`; a deactivated membership never produces `membership_count > 1` (no `identity_multi_membership` alert).
20. `app.identity_login_context` membership choice (08 A8.1): for a staff user with a `deactivated` `user` membership in tenant A and an `active` `user` membership in tenant B (whichever was updated later), the function returns tenant B's `tenant_id`, `membership_id` and `membership_status = 'active'`, so `loginStaff` signs the user into tenant B. For a user whose only `user` memberships are `deactivated`, it returns the most recently updated one (`ORDER BY updated_at DESC`) with `membership_status = 'deactivated'` and `membership_count = 0`, so `loginStaff` returns `403 identity.membership_inactive` for that membership. The function body contains no `LIMIT 1` without `ORDER BY`.
21. `app.is_platform_actor()` under FORCE RLS (08 A10.5; the function is C0 DDL since 08 A15.6, C0 05-SCHEMA §10 schema test 21; C2 keeps this contract test): with `relforcerowsecurity = true` on `identity.platform_staff` (asserted from `pg_class`) and `platform_staff__select__owner_only` present, platform claims (`scope = 'platform'`, `aal = 'aal2'`, `platform_staff_id` and `sub` of an **active** staff row) → `true`. The same claims for an inactive row, `aal = 'aal1'`, or `scope` ≠ `platform` → `false`. The test never disables RLS on the table or on a stand-in (C0 AC-0B-2.4).
22. §6 DEFINERs under FORCE RLS (08 A10.5, A12.7, A15; C0 05-SCHEMA §10 test 13): each function's contract test runs with FORCE RLS on every table it touches (asserted from `pg_class`), as the calling role of §10.3 (`lims_api` / `lims_worker`) with no claims unless stated, and asserts the rows the fixture expects. Each maintenance function runs with `app.maintenance` unset on entry and leaves it `''` (08 A15.3). `app.identity_purge_sessions` deletes exactly the seeded sessions and admin notices with `expires_at < now()`. `app.identity_expire_support_sessions` and `app.identity_expire_audit_exports` change exactly their due rows and return their counts / object paths. `app.identity_expire_invitations` (one UPDATE, 08 A12.6) expires exactly the due `pending`/`sent` rows, clears `email` on exactly the terminal rows older than 30 days, leaves a row it expires in this run with its `email`, and returns the sum of both. `app.identity_purge_auth_events` deletes the tenant-less rows older than 5 years **and** each tenant's rows older than that tenant's `retention_audit_years` (fixture: tenant A 5 years, tenant B 7 years; a tenant-B row 6 years old stays, a tenant-A row 6 years old goes). `app.identity_record_auth_event` inserts one tenant-less row. `app.identity_bootstrap_platform_admin` inserts the superadmin and the `bootstrap_admin_created` event. Pre-tenant lookups (08 A12.1): `app.identity_session_by_token(<current hash>)` returns the session with `token_reused = false` and `(<previous hash>)` the same session with `token_reused = true`; `app.identity_resolve_session(<gotrue_session_id>, <sub>)` returns the tenant-staff session with its `tenant_status`, `membership_status = 'active'` and `membership_locked`, and no row for a wrong `sub`; for a `platform` session whose `support_session_id` names an active, unexpired support session it returns `platform_staff_id`, `platform_role` and that support session's `support_session_id`, `support_tenant_id`, `support_scope` and `support_expires_at` and `support_tenant_status` = the support tenant's `core.tenants.status` (08 A20.1), and for a support session that is not `active` or has expired those five columns are NULL; after return `app.pre_tenant_id` is `''`; `app.identity_login_context(<sub>)` returns the active membership's `tenant_id`, `membership_id`, `membership_status = 'active'`, `tenant_status`, `mfa_required` from the membership's roles, `has_verified_factor = true` for a seeded verified tenant factor, and the tenant's `idle_timeout_minutes` / `absolute_session_hours`; for a platform staff user with no membership and a verified tenant-less factor it returns `platform_staff_id`, `platform_role`, `membership_count = 0`, `tenant_id` NULL, `mfa_required = true` and `has_verified_factor = true` (08 A15.2), and `has_verified_factor = false` when that user's only factor is unverified or belongs to a tenant; `app.identity_user_exists(<sub>)` is `true` for a `core.users` row in any tenant and for a platform staff user, `false` for an unknown id.
23. `core.dead_letters` `__platform` policies (08 A10.4; C0 05-SCHEMA §10 test 14): as `lims_api` with platform claims, a direct `SELECT` returns tenant rows and no NULL-tenant row, and a direct `UPDATE` of a NULL-tenant row changes 0 rows.
24. GUC-bound owner policies (08 A12.1, A12.2, A12.7): (a) each function returns its expected rows — test 22; (b) a `lims_api` (and `lims_worker`) session with no claims that runs `set_config('app.pre_session_token_sha256', <hex of a seeded hash>, true)`, `app.pre_gotrue_session_id`, `app.pre_user_id`, `app.pre_tenant_id`, `app.pre_support_session_id` (08 A15.1) itself, then selects from `identity.sessions`, `core.memberships`, `core.users`, `core.tenants`, `core.roles`, `core.membership_roles`, `identity.mfa_factors`, `identity.tenant_settings`, `identity.support_sessions` and `identity.auth_events`, sees 0 rows in each; the same holds with `app.maintenance` set in turn to each maintenance function's name (`identity_purge_auth_events`, `identity_purge_sessions`, `identity_expire_support_sessions`, `identity_expire_invitations`, `identity_expire_audit_exports`, and C0's `identity_tenants_for_email_hmacs` with `core.users`; 08 A15.3, A25 D-217), selecting also from `identity.invitations`, `identity.audit_exports` and `identity.admin_notices`; (c) in the same transaction, after each of `app.identity_resolve_session`, `app.identity_session_by_token`, `app.identity_login_context`, `app.identity_user_exists` and the five maintenance functions returns, `current_setting(<each GUC it sets>, true) = ''`; (d) the maintenance functions' owner policies admit nothing without their GUC: as `lims_owner` (`SET ROLE`, no claims, `app.maintenance` unset) a `SELECT` of the seeded due rows in `identity.sessions`, `identity.admin_notices`, `identity.support_sessions`, `identity.invitations`, `identity.audit_exports` and `identity.auth_events` returns 0 rows, and with `app.maintenance` = the matching function name it returns them (08 A15.3). `pg_policies` shows every policy whose `qual` mentions `app.pre_` or `app.maintenance` with `roles = {lims_owner}`.
25. Platform-only tables and bootstrap (08 A12.5): `pg_trigger` has no `app.tg_row_audit` trigger on `identity.platform_staff` or `identity.platform_events`. With FORCE RLS on and **no claims** (the CLI path of 03-APP-FLOW §9.4), `app.identity_bootstrap_platform_admin` succeeds (no `audit_context_missing`), inserts the staff row and the `bootstrap_admin_created` event, and writes no `audit.audit_log` row.

26. Staff-actor guard (08 A17 P-16): every `__tenant` policy on an identity table has `is_staff_or_system` in `qual` and (for INSERT/UPDATE) in `with_check` (`pg_policies`); with partner, patient and portal claims of tenant A (`tenant_id` = A, `actor_type` = `partner` / `patient` / `portal`), every identity table returns 0 rows, except that a partner sees its own `identity.sessions` rows (`__own`, `__own_user`) and its own `identity.mfa_factors` rows (`__own`), and can update them but not another member's rows (0 rows changed). `db/meta/tables.yaml` marks only `sessions` and `mfa_factors` `shared_with: [partner]`.
27. NULL-tenant rows of mixed tables (08 A25 D-215): with platform claims, inserting a platform-staff invitation (`identity.invitations`, `tenant_id` NULL), a tenant-less MFA factor and an Annex 1 record, and updating each, writes **0** `audit.audit_log` rows and does not raise; the C2 service writes one `identity.platform_events` row each (`platform_staff_invited`, `platform_mfa_enrolled`, `annex_1_changed`). A tenant row of the same tables still writes its `audit_log` row. `platform_events__type__ck` accepts `platform_mfa_enrolled` and `ird_document_downloaded`.
28. `app.identity_tenants_for_email_hmacs` (08 A25 D-217; A12.7 pattern; C0 05-SCHEMA §10 runs the same test): with FORCE RLS on `core.users` (asserted from `pg_class`), as `lims_worker` with no claims, the function returns the distinct tenants of users whose `email_hmac` is in the array (fixture: two users in A, one in B, one unknown HMAC → {A, B}); 101 values → `P0001 identity_tenants_for_email_hmacs_invalid_input`; `app.maintenance` is `''` after return; a `lims_worker` session that sets `app.maintenance = 'identity_tenants_for_email_hmacs'` itself sees 0 `core.users` rows; EXECUTE is granted to `lims_worker` only (`lims_api` → permission denied). `admin_notices` accepts `subject_id` NULL for kind `login_ip_throttled` and rejects it for every other kind (`admin_notices__subject__ck`).
29. Scan state (08 A17 P-19): `branding_assets.scan_state` and `ird_annex_documents.scan_state` accept only `pending`/`clean`/`quarantined`, default `pending`; an UPDATE of `scan_state` passes both mutable-column triggers, an UPDATE of any other `ird_annex_documents` column raises `immutable_row`; `lims_app` holds UPDATE on `ird_annex_documents.scan_state` only.
30. v1 constants: `tenant_settings__timezone__ck` rejects `'Asia/Kolkata'` and accepts `'Asia/Kathmandu'` (08 A13 P-15); the `barcode_pattern` default is `{prefix}{yy}{seq:8}` (08 A13 D-8); `sessions__idle__ck` accepts `staff_mobile` with 60 and 720 and rejects 59 and 721 (review C2 m#48).
31. `app.identity_expire_audit_exports` 1-year purge (08 A17 P-18(c)): it deletes `expired` and `failed` rows created more than 1 year ago and keeps younger ones and every `queued`/`building`/`ready` row; `audit_exports__delete__owner_only` admits nothing without `app.maintenance = 'identity_expire_audit_exports'`.
32. Pre-auth writes (08 A25 D-212; C0 provides `identityAuthTx`): with claims `{sub: <identity system actor>, actor_type: 'system'}` and no `tenant_id`, `identity.sessions` / `mfa_factors` / `invitations` INSERT or UPDATE affect 0 rows or fail the policy, and only `app.identity_record_auth_event` inserts an auth event; after the claims gain `tenant_id` = A (what `bindTenant` sets), `sessions__insert__tenant`, `sessions__update__tenant`, `auth_events__insert__tenant`, `mfa_factors__*__tenant` and `invitations__update__tenant` admit tenant-A rows only.
33. Audit inside maintenance DEFINERs (08 A28.5; C0 05-SCHEMA §10 test 32): with the audit triggers attached, `app.identity_expire_invitations()` and `app.identity_expire_support_sessions()` run as `lims_worker` with no claims, change their due rows, and write one `audit_log` row per tenant row with `actor_type = 'system'`, `actor_id` NULL, `detail.maintenance` = the function name; no `audit_context_missing`.
34. Platform-staff auth DEFINERs (08 A28.1): as `lims_api` with the identity-system-actor claims of `identityAuthTx` (no `tenant_id`), a direct INSERT of a `platform` session is refused by RLS, while `app.identity_platform_auth_write_session_insert(<staff user>, <row>)` inserts it; `…_session_update` changes the allowed columns (e.g. `state`, `aal`, `mfa_failed_attempts`) of that user's platform session and returns 0 for another user's session id; an unlisted key (`tenant_id`, `kind`) → `P0001 identity_platform_auth_write_invalid_input`; `…_mfa_factor` inserts and verifies a tenant-less factor of the user and refuses a row with a `tenant_id`; `…_invitation_accept` accepts the user's `sent` platform invitation only; `…_staff_login` sets `platform_staff.last_login_at`. `app.pre_user_id` is `''` after each call; a `lims_api` session that sets `app.pre_user_id` itself still cannot insert or update a platform session (policies `TO lims_owner`). After login, platform claims (`is_platform_actor()`) read and update tenant-less `mfa_factors` / `invitations` rows through `__platform`, and tenant rows not at all.
35. `app.identity_notify_ip_throttle_hmacs` (08 A28.4): as `lims_worker`, no claims, returns the distinct `email_hmac` values of tenant-less `login_failed` events of that IP since `p_since` (not other IPs, not older events, not tenant rows); `app.maintenance` is `''` afterwards; EXECUTE for `lims_worker` only.
