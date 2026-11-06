# C0 — Foundation & Contracts — 05 SCHEMA

Status: DRAFT for build, 2026-11-05. Owner of the DDL: **C0-0B**. Abbreviations as in `01-PRD.md`.

This document specifies:
1. what C0 itself owns: roles, schemas, the `app` helper schema, the `core` tables (CM §3), the `audit` tables, the platform tables of IC §12, and grants;
2. the rules C0 follows when translating other chunks' `05-SCHEMA.md` into migrations.

**Tables of other modules are not defined here.** Their DDL specification lives in the owning chunk's `05-SCHEMA.md` (for example `chunks/C5-*/05-SCHEMA.md` for `lab.*`). C0 translates it verbatim into `db/migrations/`. A deviation needs a CR to that chunk's document, never a silent change.

---

## 1. Roles (`db/bootstrap/00_roles.sql`)

Run once per cluster by the provisioning superuser. In dev this is the image superuser via `pnpm dev:up`. In staging/prod it is a C1 runbook step, never an application path. Passwords come from the secret store (REQ-SEC-128), shown here as psql variables.

| Role | LOGIN | BYPASSRLS | Member of | Owns | Purpose (CV §5.9 + CR-C0-007, CR-C1-002, CR-C6-002; 08 §4.7) |
|---|---|---|---|---|---|
| `lims_owner` | NO | NO | — | all module schemas, tables, views, `app` functions (except below) | object owner; FORCE RLS applies to it |
| `lims_migrator` | YES | NO | `lims_owner`, `lims_queue`, `lims_reporting_lookup` (each `WITH INHERIT FALSE, SET TRUE`) | `migrations_meta` schema (runner revision table) | runs migrations; first statement `SET [LOCAL] ROLE lims_owner` |
| `lims_app` | NO | NO | — | — | group role: DML grants + policy `TO` target (IC X9) |
| `lims_api` | YES | NO | `lims_app` | — | API pool login through PgBouncer |
| `lims_worker` | YES | NO | `lims_app`, `lims_queue` | — | Graphile Worker login, direct connection (04 S8) |
| `lims_queue` | NO | NO | — | `graphile_worker` schema; `app.enqueue_job`, `app.queue_depth` | queue privileges (IC §12; 04 D6 UNVERIFIED → SP-2) |
| `lims_reporting_lookup` | NO | NO | — | C6 pre-tenant token lookup DEFINERs (`app.reporting_verify_qr(bytea)`, `app.reporting_resolve_portal_credential(text, bytea)`, `app.reporting_ingest_provider_callback(text, bytea, jsonb)`, `app.reporting_redeem_link_for_app(bytea, bytea)` — 08 A13 D-30) | CR-C6-002 |
| `lims_monitor` | YES | NO | `pg_monitor` | — | metrics exporter (CR-C1-002) |
| `lims_replicator` | YES (REPLICATION) | NO | — | — | standby streaming (CR-C1-002) |
| `lims_audit_ship` | YES (REPLICATION) | NO | — | — | logical decoding of publication `lims_audit_ship` (INSERT only) for the audit store (CR-C1-002; 04 D11) |
| `lims_analytics` | NO (reserved) | NO | — | — | future BI path: `SELECT` on `v_pub_*` only (REQ-SEC-131) |
| `lims_migration` | reserved | — | — | — | C18 loader role — DEFER (B4); not created |

No GoTrue-hook role is created: the GoTrue custom access-token hook is not used (08 R10).

```sql
-- db/bootstrap/00_roles.sql   (psql -v lims_migrator_pw=... -v lims_api_pw=... -v lims_worker_pw=... -v lims_monitor_pw=... -v lims_replicator_pw=... -v lims_audit_ship_pw=... -v dbname=...)
CREATE ROLE lims_owner      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE lims_app        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE lims_queue      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE lims_reporting_lookup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE lims_analytics  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE lims_migrator   LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'lims_migrator_pw';
CREATE ROLE lims_api        LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'lims_api_pw';
CREATE ROLE lims_worker     LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'lims_worker_pw';
CREATE ROLE lims_monitor    LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'lims_monitor_pw';
CREATE ROLE lims_replicator LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION   NOBYPASSRLS PASSWORD :'lims_replicator_pw';
CREATE ROLE lims_audit_ship LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION   NOBYPASSRLS PASSWORD :'lims_audit_ship_pw';
GRANT pg_monitor TO lims_monitor;                                        -- CR-C1-002

GRANT lims_owner     TO lims_migrator WITH INHERIT FALSE, SET TRUE;
GRANT lims_queue     TO lims_migrator WITH INHERIT FALSE, SET TRUE;
GRANT lims_reporting_lookup TO lims_migrator WITH INHERIT FALSE, SET TRUE;
GRANT lims_app   TO lims_api    WITH INHERIT TRUE,  SET FALSE;
GRANT lims_app   TO lims_worker WITH INHERIT TRUE,  SET FALSE;
GRANT lims_queue TO lims_worker WITH INHERIT TRUE,  SET FALSE;

-- per-role session guards (not request context; safe with transaction pooling because they are role defaults)
ALTER ROLE lims_api    SET idle_in_transaction_session_timeout = '30s';   -- [CONV]
ALTER ROLE lims_worker SET idle_in_transaction_session_timeout = '120s';  -- [CONV]
ALTER ROLE lims_api    SET search_path = '';                              -- every query schema-qualified (REQ-SEC-019 spirit)
ALTER ROLE lims_worker SET search_path = '';
```

```sql
-- db/bootstrap/01_database.sql
-- 08 A25 D-201: no standing CREATE for lims_queue / lims_reporting_lookup. lims_owner holds CREATE WITH GRANT OPTION [CONV: so
-- the migration that creates lims_queue-owned objects can grant CREATE to lims_queue for that file only and revoke it again, §10
-- "queue wrapper"; lims_owner is NOLOGIN and reachable only through lims_migrator SET ROLE].
GRANT CREATE ON DATABASE :"dbname" TO lims_owner WITH GRANT OPTION;
GRANT CONNECT ON DATABASE :"dbname" TO lims_migrator, lims_api, lims_worker;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
-- Extensions that need superuser are created here, only if SP-3 confirms availability in supabase/postgres:17.6.1.136:
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;   -- REQ-ARCH-023 (C4 name search); schema 'extensions' as in the Supabase image
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions; -- 08 A31.1: tenant-leading trigram GIN indexes (C4, C11); availability stays an SP-3 check
GRANT USAGE ON SCHEMA extensions TO lims_owner, lims_migrator;   -- 08 A31.1: migrations reference opclasses schema-qualified (extensions.gin_trgm_ops)
-- pgtap is NEVER created here; test harness creates it in CI/dev databases only (SP-3).
GRANT CONNECT ON DATABASE :"dbname" TO lims_monitor, lims_audit_ship;    -- CR-C1-002 (lims_replicator uses the replication protocol only)
-- SP-3 (review C0 m#36): record which database the Supabase services (GoTrue, Storage, PostgREST) connect to in the pinned image.
-- If it is this database, REVOKE ALL … FROM PUBLIC above removes their CONNECT, and SP-3 adds
--   GRANT CONNECT ON DATABASE :"dbname" TO <the auth, storage and PostgREST login roles>;
-- with the exact role names recorded from supabase/postgres:17.6.1.136 (UNVERIFIED until SP-3; not guessed here).
```

```sql
-- migration <ts>_audit__create_publication_lims_audit_ship.sql (CR-C1-002; after audit.* and billing.activity_log exist)
SET LOCAL ROLE lims_owner;
GRANT USAGE ON SCHEMA audit, billing TO lims_audit_ship;
GRANT SELECT ON audit.audit_log, audit.access_log, billing.activity_log TO lims_audit_ship;   -- no policy for it: FORCE RLS returns 0 rows via SQL; WAL decoding only
CREATE PUBLICATION lims_audit_ship FOR TABLE audit.audit_log, audit.access_log, billing.activity_log WITH (publish = 'insert');
-- Rule: a column added to a published table is announced in the PR so C1's auditstore-drift job runs first.
```

CI assertions (`db/tests/roles/`, 02-CV §5.9): no `lims_%` role has `rolsuper` or `rolbypassrls` (AC-0B-1.1); `rolreplication` only for `lims_replicator` and `lims_audit_ship`; `lims_owner`, `lims_app`, `lims_queue`, `lims_reporting_lookup`, `lims_analytics` have `rolcanlogin = false`; `lims_api` is not a member of `lims_queue`, `lims_owner` or `lims_reporting_lookup`; publication `lims_audit_ship` has `pubinsert = true` and `pubupdate`/`pubdelete`/`pubtruncate = false`; every table in module schemas is owned by `lims_owner` (AC-0B-1.2); no role outside this table plus Supabase's own roles exists. **No standing CREATE (08 A25 D-201):** after all migrations, `has_database_privilege(r, current_database(), 'CREATE') = false` and `has_schema_privilege(r, 'app', 'CREATE') = false` for `r` ∈ {`lims_worker`, `lims_api`, `lims_queue`, `lims_reporting_lookup`} (`lims_worker` inherits `lims_queue`, so a standing grant to `lims_queue` would reach the worker login); the only residual is the one SP-2 records in `services/worker/src/core/DECISIONS.md` and 07-SECURITY §6 if Graphile Worker must migrate its own schema at start (§10 schema test 30).

## 2. Schemas

Created in migration `20261105000000_app__create_schemas.sql`. Owner `lims_owner` unless noted.

| Schema | Owner | Module / purpose (CM §3) | `USAGE` granted to |
|---|---|---|---|
| `app` | `lims_owner` | helper functions, DEFINER inventory; never exposed (CV §5.1) | `lims_app`, `lims_queue`, `lims_reporting_lookup` |
| `core` | `lims_owner` | C0 tables / C2 logic | `lims_app`, `lims_queue` |
| `audit` | `lims_owner` | C0 tables / C2 viewer | `lims_app` |
| `identity`, `catalog`, `frontdesk`, `billing`, `lab`, `instruments`, `reporting`, `analytics`, `quality`, `micro`, `anatomic`, `inventory`, `partners`, `smartreport`, `payments`, `engagement`, `homecollection` | `lims_owner` | owner chunk per CM §3 | `lims_app`; `lims_analytics` (for `v_pub_*` only) |
| `migration_staging` | `lims_owner` | C18; **never** exposed to API roles | none (C18 defines its own loader role by CR) |
| `api` | `lims_owner` | reserved for curated PostgREST views/RPC (04 S3); empty in v1 | none |
| `graphile_worker` | `lims_queue` | Graphile Worker 0.18.0 queue (installed by the migration runner inside the D-201 grant/revoke window, per SP-2) | `lims_queue` members only |
| `migrations_meta` | `lims_migrator` | runner revision table | none |

```sql
SET LOCAL ROLE lims_owner;
CREATE SCHEMA app;  CREATE SCHEMA core;  CREATE SCHEMA audit;
CREATE SCHEMA identity; CREATE SCHEMA catalog; CREATE SCHEMA frontdesk; CREATE SCHEMA billing; CREATE SCHEMA lab;
CREATE SCHEMA instruments; CREATE SCHEMA reporting; CREATE SCHEMA analytics; CREATE SCHEMA quality; CREATE SCHEMA micro;
CREATE SCHEMA anatomic; CREATE SCHEMA inventory; CREATE SCHEMA partners; CREATE SCHEMA smartreport; CREATE SCHEMA payments;
CREATE SCHEMA engagement; CREATE SCHEMA homecollection; CREATE SCHEMA migration_staging; CREATE SCHEMA api;

REVOKE ALL ON SCHEMA app, core, audit, identity, catalog, frontdesk, billing, lab, instruments, reporting, analytics, quality,
  micro, anatomic, inventory, partners, smartreport, payments, engagement, homecollection, migration_staging, api FROM PUBLIC;
GRANT USAGE ON SCHEMA app, core, audit, identity, catalog, frontdesk, billing, lab, instruments, reporting, analytics, quality,
  micro, anatomic, inventory, partners, smartreport, payments, engagement, homecollection TO lims_app;
GRANT USAGE ON SCHEMA app, core TO lims_queue;
GRANT USAGE ON SCHEMA app TO lims_reporting_lookup;   -- schema usage on reporting is granted in C6's migration
-- No standing CREATE ON SCHEMA app for lims_queue / lims_reporting_lookup (08 A25 D-201). The migration that creates objects
-- owned by one of them runs: GRANT CREATE … TO <role> → SET LOCAL ROLE <role> → create → RESET ROLE; SET LOCAL ROLE lims_owner →
-- REVOKE CREATE … FROM <role>, all in that one file (§10 "queue wrapper" shows it for lims_queue; C6's lookup migration does the
-- same for lims_reporting_lookup). PostgreSQL also needs CREATE on the schema for ALTER … OWNER TO, so "create as lims_owner, then
-- ALTER OWNER" does not avoid the grant (08 A25 D-201).
GRANT USAGE ON SCHEMA identity, catalog, frontdesk, billing, lab, instruments, reporting, analytics, quality,
  micro, anatomic, inventory, partners, smartreport, payments, engagement, homecollection TO lims_analytics;

ALTER DEFAULT PRIVILEGES FOR ROLE lims_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE lims_owner REVOKE ALL ON TABLES FROM PUBLIC;
-- Default privileges of lims_queue / lims_reporting_lookup: PostgreSQL allows ALTER DEFAULT PRIVILEGES FOR ROLE r only to members
-- of r, and lims_owner is not one (found by the 2026-11-06 scratch run: "permission denied to change default privileges"), so each
-- role sets its own, reached through lims_migrator's SET membership:
RESET ROLE;  SET LOCAL ROLE lims_queue;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET ROLE;  SET LOCAL ROLE lims_reporting_lookup;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET ROLE;  SET LOCAL ROLE lims_owner;
```

No privilege on `app` is granted to `supabase_auth_admin` (no GoTrue hook path — 08 R10).

## 3. Tables owned by C0

Mandatory columns and table classes follow CV §5.2–§5.3. Every tenant table: `tenant_id uuid NOT NULL` without default, `UNIQUE (tenant_id, id)`, ENABLE + FORCE RLS, `tenant_id` leading every index. **Listed exceptions** (all recorded in `db/meta/tables.yaml` with reasons, index exceptions also in `db/meta/index-exceptions.yaml` — 08 §4.7): `core.tenants` (root table, keyed by `id`); `core.memberships__user_id__p_uq` (partial global unique `WHERE actor_type = 'user' AND status IN ('invited','active')`, one tenant per staff user — 08 R27, predicate per 08 Addendum A3.4); retention indexes on platform tables (IC §12 itself lists `(state, dead_at)` and `(expires_at)`); `core.rate_limit_counters` (non-tenant, RLS-exempt).

**Mandatory-column exceptions of C0's own tables (08 A17 P-18(b); review C0 m#38; `db/meta/tables.yaml` field `mandatory_column_exceptions`, 02-TRD §4.1):** `core.event_log` (key `(tenant_id, event_id)`, no `id`/`version`/`is_active`/`updated_*`: class A log row, never edited, purged at 90 days); `<m>.event_inbox` (key `(tenant_id, event_id)`, same reason; one row per processed event); `core.dead_letters` (no `UNIQUE (tenant_id, id)`: `tenant_id` is NULL for platform rows and `id` is globally unique, no child FK references it); `core.idempotency_keys` (no `id`, `version`, `is_active`, `updated_*`: one row per `(tenant_id, actor_id, key)`, its natural key, which is `UNIQUE NULLS NOT DISTINCT` because platform rows have `tenant_id` NULL — 08 A25 D-213; expires after 7 days). The same field carries the other chunks' exceptions when C0 translates them: C8 (its 05-SCHEMA §1 paragraph, 08 A17 D-45), C10 `micro.specimen_isolate_counters` and its `event_inbox` note (P-18(b)), C11 `anatomic.accession_counters` (review hand-offs, 08 A25 §(c)(ii)). `db/meta/index-exceptions.yaml` also carries the other chunks' rows of 08 §4.7, translated from their `05-SCHEMA.md`; for C2's `identity.sessions` these are `(token_sha256)`, `(gotrue_session_id)` (CR-C2-017) and the partial `(previous_token_sha256) WHERE previous_token_sha256 IS NOT NULL` (CR-C2-018, 08 Addendum A3.1), each read only by the inventoried DEFINER `app.identity_session_by_token` (or `app.identity_resolve_session` for `gotrue_session_id`); and C2's `identity.auth_events__occurred_at__idx` (retention purge across tenants by `app.identity_purge_auth_events`, 08 A28.6).

**Mandatory-column exception — `core.memberships.is_active` (08 Addendum A3.4).** CV §5.3 gives every class M table a plain `is_active boolean NOT NULL DEFAULT true`. On `core.memberships` only, `is_active` is `GENERATED ALWAYS AS (status = 'active') STORED`: writers set `status` (`invited`/`active`/`deactivated`) and never write `is_active` (an INSERT or UPDATE that supplies a non-DEFAULT value for `is_active` fails, SQLSTATE `428C9`). Readers (`ctx.core`, `app.has_all_centres()`, `app.current_centre_ids()`) keep reading `is_active`; deactivating a membership (CV §5.2 "deactivate") means `status = 'deactivated'`. Every other C0 table keeps the plain writable column.

PHI class per column (IC §1): **P0** no personal data · **P1** pseudonymous ids · **P2** identifiers/personal data · **P3** health data.

### 3.1 `core.tenants` — class M (root)

| Column | Type | Null | Default | Constraint | PHI |
|---|---|---|---|---|---|
| id | uuid | no | — | PK; = tenant id everywhere | P0 |
| tenant_code | text | no | — | `^[a-z][a-z0-9_]{2,31}$`; UNIQUE (global — platform slug) | P0 |
| legal_name | text | no | — | 1–200 chars | P0 (company) |
| display_name | text | no | — | 1–120 chars | P0 |
| status | text | no | `'provisioning'` | IN (`provisioning`,`active`,`suspended`,`offboarded`) | P0 |
| timezone | text | no | `'Asia/Kathmandu'` | IANA name, ≤ 64 chars (CV §4.8); read by C2's `IdentityPort.getTenantSettings().timezone` | P0 |
| status_reason | text | yes | — | ≤ 500 (08 A3.4); holds the `reason_text` of C2 `suspendTenant` / `terminateTenant` (08 A6.3) | P0 |
| activated_at | timestamptz | yes | — | lifecycle timestamp, set by C2 (08 A3.4) | P0 |
| suspended_at | timestamptz | yes | — | lifecycle timestamp, set by C2 (08 A3.4) | P0 |
| offboarded_at | timestamptz | yes | — | lifecycle timestamp, set by C2; named after status `offboarded` (C2's former `terminated_at`, 08 A3.4) | P0 |
| billing_live_on | date | yes | — | set by C2 `updateTenant` (08 A3.4) | P0 |
| version, is_active, created_at, created_by, updated_at, updated_by | per CV §5.3 | | | | P1 |

Other tenant settings (letterhead, numbering, channels, retention, IRD PAN…) are **C2's** storage in the `identity` schema (IC §4.6 `TenantSettings`; C2 `05-SCHEMA.md`).

### 3.2 `core.branches`, `core.collection_centres` — class M, tenant-scoped (not centre-scoped)

`core.branches`: id, tenant_id, `branch_code text` (`^[A-Za-z0-9-]{1,16}$`, UNIQUE (tenant_id, branch_code)), `name text` (1–120), `address_text text` (≤ 500), `phone_display text` (≤ 40, business contact), `is_processing_lab boolean NOT NULL DEFAULT true`, mandatory M columns. PHI P0.

`core.collection_centres`: id, tenant_id, `branch_id uuid NOT NULL` (processing branch it sends to; FK (tenant_id, branch_id) → branches), `centre_code text` (`^[A-Za-z0-9-]{1,16}$`, shape of 00 §4 `C000000002`; UNIQUE (tenant_id, centre_code)), `name text` (1–120), `centre_kind text NOT NULL` IN (`own`,`franchise`,`home_collection`) (00 §4 home-collection pseudo-centre; 00 §3 item 1 franchise), `address_text`, `phone_display`, mandatory M columns. PHI P0.

No hard limit on the number of branches or centres (00 §3 item 1 "unlimited collection centres").

### 3.3 `core.users`, `core.memberships`, `core.membership_centres`, `core.membership_branches` — class M

`core.users` (staff/patient/partner profile per tenant; credentials stay in GoTrue `auth.users`):

| Column | Type | Null | Notes | PHI |
|---|---|---|---|---|
| tenant_id | uuid | no | | P0 |
| id | uuid | no | = GoTrue `sub` (any UUID version — IC §2.1 `Uuid`); no FK into `auth` (REQ-ARCH-014 keeps GoTrue swappable) | P1 |
| display_name | text | no | 1–120 | P2 |
| staff_code | text | yes | ≤ 32 | P2 |
| email_normalized | text | yes | ≤ 254; UNIQUE (tenant_id, email_normalized) (`users__tenant_id_email_normalized__uq`) (08 A3.4) | P2 |
| phone_e164 | text | yes | `^\+[1-9][0-9]{7,14}$` (08 A3.4) | P2 |
| last_login_at | timestamptz | yes | set by C2 (08 A3.4); internal — the admin UI shows `memberships.last_login_at` (08 A6.3) | P0 |
| email_hmac | bytea | yes | `octet_length(email_hmac) = 32` (`users__email_hmac__ck`); HMAC-SHA256 of `email_normalized` with C2's `LIMS_IDENTITY_EMAIL_HMAC_KEY`, written by C2 on user create and on email change (08 A25 D-217); read only by `app.identity_tenants_for_email_hmacs` (§4.3) | P1 |
| is_active, version, created_*, updated_* | | | | |
| PK | (tenant_id, id) — DECISION: `id` is GoTrue's, not ours, so a patient user of two tenants (Phase 3) can have two profiles | | | |

`core.memberships`:

| Column | Type | Null | Default | Notes | PHI |
|---|---|---|---|---|---|
| id | uuid | no | — | UUIDv7 | P1 |
| tenant_id | uuid | no | — | | P0 |
| user_id | uuid | no | — | FK (tenant_id, user_id) → users (tenant_id, id) | P1 |
| actor_type | text | no | — | IN (`user`,`patient`,`partner`) (CV §6) | P0 |
| all_centres | boolean | no | false | hub staff (CV §5.8) | P0 |
| status | text | no | `'active'` | IN (`invited`,`active`,`deactivated`) (08 A3.4); the only writable lifecycle column | P0 |
| invited_at | timestamptz | yes | — | set by C2 (08 A3.4) | P0 |
| accepted_at | timestamptz | yes | — | set by C2 (08 A3.4) | P0 |
| deactivated_at | timestamptz | yes | — | set by C2 (08 A3.4); cleared (NULL) on reactivate (08 A6.3) | P0 |
| deactivated_by | uuid | yes | — | set by C2 (08 A3.4); cleared (NULL) on reactivate (08 A6.3) | P1 |
| deactivation_reason_code | text | yes | — | set by C2 (08 A3.4); IN (`left_organisation`,`security_concern`,`policy_violation`,`other`) — same set as `lock_reason_code` (08 A6.3); cleared (NULL) on reactivate, history stays in `audit.audit_log` (08 A6.3) | P0 |
| locked_at | timestamptz | yes | — | set by C2 (00 E1 "lock a user"); **locked ⇔ `locked_at IS NOT NULL`** — there is no `is_locked` column (08 A3.4); the API field/filter `is_locked` and `ActorProfile.isLocked` stay as wire names, always computed as `locked_at IS NOT NULL` (08 A6.1) | P0 |
| locked_by | uuid | yes | — | | P1 |
| lock_reason_code | text | yes | — | ≤ 64; IN (`left_organisation`,`security_concern`,`policy_violation`,`other`) (08 A3.4) | P0 |
| lock_reason_text | text | yes | — | ≤ 500 (08 A3.4) | P2 |
| last_login_at | timestamptz | yes | — | set by C2 (08 A3.4); the per-tenant value the admin UI shows (08 A6.3) | P0 |
| signatory_display_title | text | yes | — | ≤ 200 (00 §4 signatory block) | P2 |
| signatory_registration_no | text | yes | — | ≤ 40 (e.g. NMC no.) | P2 |
| signature_image_ref | text | yes | — | storage object path under `{tenant_id}/signatures/…` | P2 |
| partner_role | text | yes | — | 08 A28.3: IN (`partner_admin`,`partner_member`); present **iff** `actor_type = 'partner'` (`memberships__partner_role_presence__ck`, `memberships__partner_role__ck`); written and read by C2 (the source of `<partner role>` in C2 TRD §7.1) | P0 |
| is_active | boolean | no | — | **`GENERATED ALWAYS AS (status = 'active') STORED`** — this table only; never written (08 A3.4; §3 exception note) | P0 |
| version, created_*, updated_* | | | | | |

Constraints: UNIQUE (tenant_id, id); UNIQUE (tenant_id, user_id, actor_type) WHERE status IN ('invited','active') (`memberships__tenant_id_user_id_actor_type__p_uq`; a pending invite also blocks a duplicate membership — 08 A3.4); CHECK `memberships__all_centres_user_only__ck CHECK (actor_type = 'user' OR NOT all_centres)` (08 R3); CHECK `memberships__status__ck`, `memberships__lock_reason__ck` (08 A3.4). "One staff user = memberships in exactly one tenant" (CV §6): a partial global unique index `memberships__user_id__p_uq (user_id) WHERE actor_type = 'user' AND status IN ('invited','active')` enforces one tenant per staff user, counting pending invites (08 R27; predicate per 08 A3.4; listed in `db/meta/index-exceptions.yaml`); collisions surface only as the generic `identity.user_exists` (checked inside the inventoried DEFINER `app.identity_user_exists`). Patients and partners stay multi-tenant-capable (the index is partial).

`core.membership_centres`: tenant_id, membership_id, centre_id, created_at, created_by; PK (tenant_id, membership_id, centre_id); FKs to memberships and collection_centres. Association class (DELETE allowed — CV §4.1), audited.

`core.membership_branches` (CR-C2-003; 08 R3): tenant_id, membership_id, branch_id, created_at, created_by; PK (tenant_id, membership_id, branch_id); FKs to memberships and branches. Association class (DELETE allowed), audited. Trigger `app.tg_scope_user_only()` (BEFORE INSERT on `membership_centres` and `membership_branches`) refuses rows whose membership is not `actor_type = 'user'` (SQLSTATE `23514`, message `scope_user_only`).

Branch scope is explicit: `core.membership_branches (tenant_id, membership_id, branch_id, created_at, created_by)`, PK (tenant_id, membership_id, branch_id), FKs to memberships and branches, association class, audited (C2 05-SCHEMA). `all_centres = true` implies all branches. Branch scope is application-level only; no RLS policy reads it (08 R3). It may guard only P0/P1 data (today C12 stores/stock); P2/P3 tables are centre-scoped by RLS.

### 3.4 `core.roles`, `core.role_permissions`, `core.membership_roles`, `core.g_permissions` (IC §11)

- `core.g_permissions` — class G: `code text PK` (`^[a-z_]+\.[a-z_]+\.[a-z_]+$`), `module text`, `privileged boolean`, `phase text` IN (`1`,`1.5`,`2`,`3`), `description text`, `is_active`, `created_at`. Seeded from `contracts/permissions.yaml` by generated `db/seeds/001_core__g_permissions.sql`.
- `core.roles` — class M: id, tenant_id, `role_code text` (`^[a-z][a-z0-9_]{1,39}$`, UNIQUE (tenant_id, role_code)), `display_name`, `description`, `is_system_default boolean` (seeded defaults from IC §11 `roles:`), `mfa_required boolean` (IC §11), mandatory M columns.
- `core.role_permissions` — association: tenant_id, role_id, permission_code (FK → g_permissions(code)); PK (tenant_id, role_id, permission_code); CHECK `permission_code NOT LIKE 'platform.%'` (IC §11: tenant roles cannot hold `platform.*`); INDEX `role_permissions__tenant_id_permission_code__idx (tenant_id, permission_code)` (08 A3.4; C2 last-admin checks).
- `core.membership_roles` — association: tenant_id, membership_id, role_id; PK (tenant_id, membership_id, role_id); INDEX `membership_roles__tenant_id_role_id__idx (tenant_id, role_id)` (08 A3.4; C2 last-admin checks, member counts).
- The "last holder of `identity.role.manage`" rule (`identity.last_admin_protected`) is C2 logic, not DDL.
- Platform roles (`platform_superadmin`, `platform_support`) are a separate identity (REQ-SEC-063) stored by C2 (`identity` schema).

### 3.5 Platform tables (IC §12; columns verbatim plus mandatory columns)

| Table | Class | Notes beyond IC §12 |
|---|---|---|
| `core.event_log` | A | `envelope jsonb` holds the payload: PHI class = the event's class (up to P3, IC §3.25). `created_by` = publishing actor. SELECT + INSERT to `lims_app`. `shared_with: [partner, portal, patient]` in `db/meta/tables.yaml` (08 A23.3): those actors may INSERT their own rows (`created_by` = their actor id; the table has no `actor_id` column, so `created_by` is the actor column the A23.3 predicate binds [CONV]) but never SELECT |
| `<m>.event_inbox` | A | created in every module schema except `core`, `audit`, `catalog` (08 A31.4), `migration_staging`, `api` (§3.9) |
| `core.dead_letters` | E | `job_payload` holds ids only (P1); `last_error_message_redacted` scrubbed by the logger scrubber; state transitions `open → replayed | discarded` only (trigger); `version integer NOT NULL DEFAULT 1` for If-Match on replay/discard (08 A3.4); `resolution_note text NULL` CHECK `char_length(resolution_note) BETWEEN 1 AND 500` = discard reason (required by `ctx.core.deadLetters.discard`) or optional replay note (08 A8.4); `job_payload` is never returned by `ctx.core.deadLetters` (`DeadLetterRow`, 02-TRD §6.8; 08 A8.5); for a platform row, `app.dl_resolve(... 'replayed' ...)` returns it to the C0 core service only, for the re-enqueue (08 A10.1); `job_key text NULL` (CHECK ≤ 400 chars [CONV]) = the failed job's Graphile `job_key`, copied from `helpers.job.key` by the dead-letter wrapper at dead-lettering (NULL when the job had none); replay re-enqueues with `job_key = coalesce(job_key, task_identifier || ':' || id) || ':replay:' || <version after the bump>` (08 A23.2) |
| `core.idempotency_keys` | E | `response_body jsonb` may contain P2/P3 (stays in Nepal DB under RLS; 7-day retention); policies add `actor_id = app.current_actor_id()`. `tenant_id` is **NULL** for platform-context operations (`provisionTenant`, `openSupportSession`, `invitePlatformStaff`; 08 A25 D-213); key `idempotency_keys__tenant_id_actor_id_key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, actor_id, key)` replaces the PK; NULL-tenant rows are reached only through `__platform` policies. `shared_with: [partner, portal, patient]` (08 A23.3): those actors INSERT/SELECT/UPDATE (and DELETE their own `in_progress` row, §6) only rows with their own `actor_id` |
| `core.g_task_registry` | G | `identifier text PK`, `module text`, `kind` IN (`task`,`consumer`,`core`), `scope` IN (`per_tenant`,`platform`), `max_attempts int`, `is_active`, `registered_at timestamptz`, `created_at` |
| `core.g_system_actors` | G | `module text PK`, `actor_id uuid UNIQUE NOT NULL` (fixed UUIDv7 from `db/meta/system-actors.yaml`), `is_active`, `created_at` |
| `core.rate_limit_counters` | E, **UNLOGGED**, RLS-exempt | `key_hash text`, `window_start timestamptz`, `hits int`; PK (key_hash, window_start). Accessed only through `app.ratelimit_hit` (no table grants). Non-tenant, hashed keys, no PHI (04 S11 fallback) |

### 3.6 `audit.audit_log` — class A (04 D11; REQ-ARCH-025)

| Column | Type | Null | Notes | PHI |
|---|---|---|---|---|
| id | uuid | no | `app.uuidv7()` (trigger-side generator — 04 D9 allows a SQL function when a trigger needs one) | P1 |
| tenant_id | uuid | no | from the audited row | P0 |
| centre_id | uuid | yes | from the audited row when it has `centre_id` | P0 |
| schema_name, table_name | text | no | | P0 |
| row_id | uuid | yes | audited row's `id` (NULL for association tables without `id`) | P1 |
| action | text | no | IN (`INSERT`,`UPDATE`,`DELETE`) | P0 |
| changed_columns | text[] | no | UPDATE: changed columns excluding `updated_at`,`updated_by`,`version`; INSERT/DELETE: `{}` | P0 |
| old_values | jsonb | yes | UPDATE: changed columns only; DELETE: full row | **P3** |
| new_values | jsonb | yes | UPDATE: changed columns only; INSERT: full row | **P3** |
| actor_id | uuid | yes | claims `sub`; NULL only for a row written inside a maintenance DEFINER with no claims (08 A28.5; `audit_log__actor__ck`) | P1 |
| actor_type | text | no | claims `actor_type` | P0 |
| membership_id, support_session_id | uuid | yes | claims | P1 |
| request_id | uuid | yes | `app.request_id` | P0 |
| client_ip | inet | yes | `app.client_ip` | P2 |
| user_agent | text | yes | `app.user_agent` | P2 |
| detail | jsonb | yes | `{"maintenance": "<function name>"}` for maintenance rows (08 A28.5) [CONV column; added to the `lims_audit_ship` publication — announced to C1's auditstore-drift job, §1]; NULL otherwise | P0 |
| occurred_at | timestamptz | no | `now()` | P0 |
| created_at, created_by | | no / yes | = occurred_at, actor_id (`created_by` NULL exactly when `actor_id` is NULL, 08 A28.5) | |
| PK | (tenant_id, occurred_at, id) — time column in the key for future partitioning (04 D10) | | | |

Storing only changed columns for UPDATE keeps the old/new trail of 04 D11 while bounding growth (`02-TRD.md` §10.1). Which tables are audited is declared per table by the owner chunk (`audited: true` in its `05-SCHEMA.md`). Default: every class M, C and B table is audited. A and E tables are not (they are logs or ephemeral).

### 3.7 `audit.access_log` — class A (REQ-SEC-096/097)

Columns: id (app UUIDv7), tenant_id, centre_id (null), actor_id, actor_type, membership_id (null), support_session_id (null), `action text NOT NULL` (FK → `audit.g_cs_access_actions(code)`), `entity_type text NOT NULL` (≤ 40), `entity_id uuid` (null), `purpose_code text` (null, ≤ 64), `outcome text NOT NULL` IN (`allowed`,`denied`), `detail jsonb NOT NULL DEFAULT '{}'` (ids/counts only, ≤ 4 KB by CHECK `octet_length(detail::text) <= 4096`), request_id, client_ip inet, user_agent, occurred_at, created_at, created_by. PK (tenant_id, occurred_at, id). PHI: P1/P2 (no health values; `detail` is validated by the core against the logger denylist). `shared_with: [partner, portal, patient]` (08 A23.3): those actors INSERT rows with their own `actor_id` (e.g. C6 `report.portal_view`, C16 patient paths) and never SELECT.

`audit.g_cs_access_actions` — class G coded set (CV §5.5 columns): `code text PK`, `display text`, `system text DEFAULT 'lims'`, `system_version text DEFAULT '1'`, `sort_order int`, `is_active boolean`. **Seed = the C0 base list below ∪ every code of the 03-IC §13.1 YAML block, generated** by `tools/codegen/gen-access-actions.ts` [CONV name] into `db/seeds/003_audit__g_cs_access_actions.sql`; an equality test (T0B-04) fails when the seed differs from the base list ∪ the 03-IC §13.1 block, and the P-3 CI check (`tools/codegen/check-access-actions.ts`, 02-TRD §15.1) fails a string-literal `action:` in `services/**` that is not in the seed (08 A13 P-3; review C0 #9). The hand list that follows is the expected content at 2026-11-06, for review only. `patient.demographics_access` is removed from the base list (no user in any chunk or in 03-IC §13.1; C4 hand-off verified, 08 A25 §(c)(ii)). C0 base list [CONV; chunks add codes by CR]: `report.view`, `report.print`, `report.download`, `report.bulk_download`, `report.release_override`, `invoice.view`, `invoice.print`, `invoice.reprint`, `data.export`, `patient.view`, `trf.view`, `consent.change`, `role.change`, `permission.change`, `membership.lock`, `membership.unlock`, `session.revoke`, `support_session.open`, `support_session.close`, `auth.login_success`, `auth.login_failure`, `auth.mfa_failure`, `auth.password_reset`, `auth.otp_sent`, `auth.otp_failure`, `dead_letter.replay`, `dead_letter.discard`. Additions (08 §4.4; every code `<entity>.<verb>`): C2 `audit_entry.view`, `dead_letter.view`, `audit_export.download`, `ird_document.download`, `branding_asset.download`, `support_session.approve`, `support_session.deny`, `support_session.activate`, `support_session.revoke`, `tenant.lifecycle_change`, `settings.change`, `feature_flag.change`; C4 `patient.search`, `patient.update`, `patient.anonymise`, `credit_note.print`, `receipt.print` (08 A2.9); C5 `specimen_label.print`, `lab_result.view`, `lab_result_history.view`, `critical_value.view`, `worksheet.print`, `ingest_exception.view` (08 A13 D-11); C6 `report.release`, `report.portal_view`, `report.portal_download`, `report.outsourced_view`, `report.narrative_sign`, `report.token_revoke`, `portal.session_start`, `portal.link_reissue`; C7 `instrument_message.raw_view`, `instrument_message.attachment_view`, `instrument_message.reprocess`, `instrument_message.rematch`, `device_credential.issue`, `device_credential.revoke`; C8 `referral_report.view`; C9 `autoverify.activate`, `autoverify.retire`, `autoverify_decision.view`, `autoverify_simulation.view` (08 A17 D-53); C10 `culture.view`, `breakpoint_set.import`, `breakpoint_set.activate`, `breakpoint_set.retire`, `micro_instrument_record.assign`; C11 `anatomic_case.view`, `anatomic_report.view`, `anatomic_image.view`, `anatomic_label.print`, `anatomic_object.lookup`, `anatomic_report.sign_out` (08 A17 D-53); C13 `manifest.print`, `report.access_slip`, `statement.view`; C14/C16 `smart_summary.view`; C15 `payment_intent.resolve`; C16 `link_code.issue`, `app_link.redeem`, `app_link.revoke`, `patient_membership.lookup`, `patient_account.delete`; C17 `home_visit.view`. Reserved (DEFER, B4): `legacy_document.download`. C3 catalog file / referrer exports use the existing `data.export`.

### 3.8 Retention (CV §5.11; 04 I8; B15)

| Table | Retention | Mechanism |
|---|---|---|
| `audit.audit_log`, `audit.access_log` | ≥ 5 years (B15 default; per-tenant longer via C2 setting) | **not purged by C0**; shipped to the separate store by C1 (04 D11) |
| `core.event_log` | 90 days [CONV] | `app.purge_event_log()` (daily cron; own transaction, 300 s statement timeout, 4-min loop cap, 08 A25 D-200) |
| `<m>.event_inbox` | 90 days [CONV] | `app.purge_event_inboxes()` |
| `core.idempotency_keys` | 7 days | `app.purge_idempotency_keys()` |
| `core.dead_letters` | until resolved + 90 days | `app.purge_dead_letters()` |
| `core.rate_limit_counters` | 2 × largest window (48 h) | `app.purge_ratelimit_counters()` |
| core M tables | never deleted (deactivate) | — |

### 3.9 `event_inbox` schema list

Created in: `identity`, `frontdesk`, `billing`, `lab`, `instruments`, `reporting`, `analytics`, `quality`, `micro`, `anatomic`, `inventory`, `partners`, `smartreport`, `payments`, `engagement`, `homecollection` (16; `catalog` has none: C3 consumes no events, 08 A31.4). The worker core's consumer wrapper uses `<module>.event_inbox` of the subscribing module. Generated by C0 only (`db/tools/gen-inbox.ts`, §10 template); a module 05-SCHEMA never creates its own `event_inbox` (08 A30.2).

## 4. `app` helper functions and the DEFINER inventory

### 4.1 Context helpers (CV §5.8, verbatim semantics)

`app.current_claims()`, `app.current_tenant_id()`, `app.current_actor_id()`, `app.current_actor_type()` — SQL, STABLE, SECURITY INVOKER, exactly as CV §5.8. Added by C0 for convenience: `app.current_membership_id()` (INVOKER, same pattern). `app.has_all_centres()`, `app.current_centre_ids()` — SECURITY DEFINER exactly as CV §5.8 (CASE rewritten with explicit branches; `user` → membership, `system` → tenant set, every other actor type → `false` — 08 R3), owned by `lims_owner`. `app.is_staff_or_system()` — INVOKER, `actor_type IN ('user','system','device')`; **every** `__tenant` / `__tenant_centre` policy's USING and WITH CHECK contain `(SELECT app.is_staff_or_system())` (08 A17 P-16, A23.3; CR-C13-011; 08 R10 item 5). The only tables that also admit partner/portal/patient actors are those marked `shared_with` in `db/meta/tables.yaml`, and they do so through separate actor-specific policies (`__partner`, `__portal`, `__patient`), never by dropping the guard from `__tenant`. C0's shared tables: `core.event_log`, `core.idempotency_keys`, `audit.access_log` (08 A23.3; §6). `device` stays inside the guard (08 A19.1; the boundary for device and `staff_mobile` sessions is the C0 route probe, 02-TRD §5.3). `app.current_lims_session_id()` — INVOKER (`nullif(claims ->> 'lims_session_id', '')::uuid`), C0 DDL since 08 A20.2 (moved from C2 with `app.is_platform_actor()`), EXECUTE `lims_app`, `lims_api`, `lims_worker`.

**Required companion policies (C0 design point).** The two DEFINER helpers execute as `lims_owner`. `core.memberships` and `core.membership_centres` have FORCE RLS, so their reads inside the helpers are filtered by policies for `lims_owner`. Without a policy for `lims_owner` they would always return false or `'{}'`. This would deny every centre-scoped user silently. C0 therefore adds `memberships__select__owner_only` and `membership_centres__select__owner_only` (`TO lims_owner USING (tenant_id = (SELECT app.current_tenant_id()))`). They are still tenant-bound and named per CV §3 (`owner_only`). `memberships__select__owner_only` also admits `user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid` for the C2 pre-tenant lookups (08 A12.1; §4.3 GUC rule); one SELECT owner policy per table, so the two predicates are ORed. The isolation suite includes a positive test: a centre-scoped user sees their own centre's rows (`db/tests/policies/helpers_positive.sql`).

### 4.2 Platform-scope rule

The API never sets a platform scope. Cross-tenant operations exist only as inventoried DEFINER functions: retention purges, `app.dl_*` / `app.platform_list_tenants` platform functions, and the pre-tenant credential lookups of 08 §4.7 (identity session resolution, C6/C7/C15/C16 token lookups bound to a transaction-local GUC set from the presented hash). Each has a fixed, narrow predicate enforced by an `owner_only` or `lookup` policy; where the predicate depends on a parameter or spans tenants, the policy is bound to a transaction-local GUC the function sets (`app.pre_*`, `app.maintenance`; §4.3 GUC rule, 08 A12.1–A12.3). None uses `USING (true)`, with one decided exception: `identity.platform_staff__select__owner_only` (`TO lims_owner USING (true)`, read by `app.is_platform_actor()`; 08 A10.5). It is the only entry in the forbidden-construct allowlist of 02-TRD §4.2 and AC-0B-2.2. C2's platform context (claims `scope = 'platform'`, no `tenant_id`) reads only through `__platform` policies (`app.is_platform_actor()`, CR-C2-004); `withTenantScope` is limited to an operationId allowlist (08 R10 item 4, as extended by 08 A25 D-214), plus two core-internal uses outside module `identity`: the worker-core cron fan-out (08 A23.1) and `ctx.core.deadLetters.replay` of a tenant row (08 A23.2), each under the owning module's system actor; no module code calls it.

### 4.3 DEFINER inventory (`db/meta/definer-inventory.yaml`; REQ-SEC-020)

| Function | Owner | EXECUTE granted to | Why DEFINER | Policy it relies on |
|---|---|---|---|---|
| `app.has_all_centres()` | lims_owner | lims_app | membership lookup inside policies without recursion (REQ-SEC-021); rewritten CASE: `system` → tenant set, `user` → membership, every other actor type → false (08 R3) | `memberships__select__owner_only` |
| `app.current_centre_ids()` | lims_owner | lims_app | same | `memberships__select__owner_only`, `membership_centres__select__owner_only` |
| `app.tg_row_audit()` (trigger; optional excluded-column list as trigger argument — CR-C15-013) | lims_owner | — (trigger) | `lims_app` must not be able to insert audit rows directly (AC-0B-5.3) | `audit_log__insert__owner_only` |
| `app.enqueue_job(...)` | lims_queue | lims_app | `graphile_worker.add_job` "requires database owner privileges" (Graphile Worker add_job docs, fetched 2026-11-05) | none (queue tables not RLS); checks registry + tenant match |
| `app.queue_depth()` → `TABLE (task_identifier text, ready bigint, locked bigint, failed bigint)` (SQL body §10; counts only, never payloads or keys — review C0 m#37) | lims_queue | lims_worker | read queue counts for metrics | — (`graphile_worker` has no RLS) |
| `app.ratelimit_hit(text,int,int)` | lims_owner | lims_api, lims_worker | no table grants on counters | RLS-exempt table |
| `app.purge_idempotency_keys()`, `app.purge_event_log()`, `app.purge_event_inboxes()`, `app.purge_dead_letters()`, `app.purge_ratelimit_counters()` — each `(OUT deleted bigint, OUT capped boolean)` [CONV: `capped` feeds `lims_core_retention_purge_capped_total{table}`, 08 A25 D-200]; batched loop capped at `clock_timestamp() - now() > interval '4 minutes'` (D-200); SQL bodies in §10 | lims_owner | lims_worker | cross-tenant retention (CV §5.11); each called by `core.retention_purge` in its own transaction with `statement_timeout = 300000` (02-TRD §7.6) | `<t>__delete__owner_only` **and** `<t>__select__owner_only` with the same expiry predicates (a `DELETE … WHERE` reads the row, so under FORCE RLS the owner also needs a SELECT policy — 08 A10.5; `core.dead_letters` folds its purge predicate into the existing `dead_letters__select__owner_only`, §10), each gated by `current_setting('app.maintenance', true) = '<function name>'`, which the function sets and resets (08 A15.3; §4.3 GUC rule). `app.purge_ratelimit_counters()` touches only the RLS-exempt `core.rate_limit_counters` and relies on no policy |
| `app.dl_insert_platform(uuid, text, jsonb, text, text, integer, timestamptz, text)` (last argument `p_job_key`, 08 A23.2), `app.dl_list_platform(text, text, timestamptz, timestamptz, timestamptz, uuid, integer, uuid)`, `app.dl_resolve(uuid, integer, text, text)` (SQL bodies in §10, 08 A9.4) | lims_owner | lims_worker (insert), lims_api (list, resolve; platform context only — 08 §4.7: list and resolve add `(SELECT app.is_platform_actor())` to their predicate, so outside platform context they return / change no row) | dead letters with `tenant_id IS NULL` (IC §12); `app.dl_resolve` applies the same `version = expectedVersion` guard (08 A6.4), the `open → replayed | discarded` transition and the `resolution_note` write (08 A8.4, A9.3) as the tenant-row path; `app.dl_list_platform` serves `ctx.core.deadLetters.list({ platformRows: true, … })` and, with `p_dead_letter_id`, `ctx.core.deadLetters.get` (08 A9.1, A9.2); `app.dl_list_platform` never returns `job_payload`; `app.dl_resolve` returns it to the C0 core service only, which strips it before building `DeadLetterRow` and re-enqueues it on replay (08 A10.1; 02-TRD §7.4) | `dead_letters__{select,insert,update}__owner_only` with `tenant_id IS NULL` (§6, §10) |
| `app.platform_list_tenants(text, text, text, timestamptz, uuid, integer)` (SQL body in §10, 08 A12.3) | lims_owner | lims_api (platform context only: returns no row unless `(SELECT app.is_platform_actor())`) | platform tenant list for C2 `listTenants` (CR-C0-004): filter `status`, sort `code` / `-created_at`, keyset paging, non-PHI tenant columns only | `tenants__select__owner_only` (`app.maintenance = 'platform_list_tenants'` branch); `platform_staff__select__owner_only` (through `app.is_platform_actor()`) |
| `app.cron_tenant_ids() RETURNS SETOF uuid` (SQL body §10; 08 A13 P-6, A23.1) | lims_owner | lims_worker | tenant list for `tenantScope: 'per_tenant'` cron ticks: `core.tenants.status IN ('active','suspended')` [CONV, P-6]; plpgsql, sets `app.maintenance = 'cron_tenant_ids'` and resets it | `tenants__select__owner_only` (`app.maintenance = 'cron_tenant_ids'` branch, §10) |
| `app.core_resolve_tenant_code(p_code text) RETURNS TABLE (tenant_id uuid, status text)` (SQL body §10; 08 A19 D-121; replaces `app.engagement_resolve_tenant_code`) | lims_owner | lims_api | patient pre-auth tenant resolution before any context (C16; also C18 D-134, deferred); plpgsql, sets `app.pre_tenant_code` and resets it; the caller filters `status = 'active'` | `tenants__select__owner_only` (`tenant_code = app.pre_tenant_code` branch, §10) |
| `app.identity_tenants_for_email_hmacs(p_hmacs bytea[]) RETURNS SETOF uuid` (SQL body §10; 08 A25 D-217; requesting spec C2 05-SCHEMA §10.3 — the two texts must be identical, a difference is a CR, P-41) | lims_owner | lims_worker | tenants whose staff were targeted by a throttled IP (task `identity.notify_ip_throttle`); ≤ 100 values; plpgsql, sets `app.maintenance = 'identity_tenants_for_email_hmacs'` and resets it | `users__select__owner_only` (`app.maintenance` branch with `email_hmac IS NOT NULL`, §10) |
| `app.is_platform_actor()` (C0-owned DDL in §10, 08 A15.6; contract tests C2 05-SCHEMA §11 test 21) | lims_owner | lims_app (so `lims_api` and `lims_worker` as members) | platform-context predicate (CR-C2-004) | `platform_staff__select__owner_only` (`TO lims_owner USING (true)`, 08 A10.5; C2 05-SCHEMA §5.4, §10.1) |
| `app.identity_resolve_session(uuid, uuid)`, `app.identity_login_context(...)`, `app.identity_session_by_token(bytea)` (matches `token_sha256` or `previous_token_sha256`, returns `token_reused` — CR-C2-018, 08 Addendum A3.1), `app.identity_record_auth_event(jsonb)`, `app.identity_user_exists(uuid)`, `app.identity_bootstrap_platform_admin(uuid, uuid, text, text, uuid)` | lims_owner | lims_api | claims resolution and login before tenant context (CR-C2-005; SQL in C2 05-SCHEMA §10.3) | owner_only — per-function list in C2 05-SCHEMA §5.4 (08 A10.5); `app.identity_resolve_session`, `app.identity_session_by_token`, `app.identity_login_context`, `app.identity_user_exists` bind theirs to the `app.pre_*` GUCs (08 A12.1; the `core` ones are in §10: `memberships__select__owner_only`, `users__select__owner_only`, `tenants__select__owner_only`, `roles__select__owner_only`, `membership_roles__select__owner_only`) |
| `app.identity_purge_sessions()`, `app.identity_expire_support_sessions()`, `app.identity_expire_invitations()` (each `RETURNS integer`), `app.identity_expire_audit_exports() RETURNS TABLE (object_path text)`, `app.identity_purge_auth_events() RETURNS integer` (SQL in C2 05-SCHEMA §10.3; 08 A12.2, A15.3) | lims_owner | lims_worker | cross-tenant maintenance of identity tables (C2 cron) | owner policies gated on `app.maintenance = '<function name>'` — per-function list in C2 05-SCHEMA §5.4 (08 A15.3; P-41(d)) |
| `app.identity_load_breached_batch(p_hashes bytea[], p_version text) RETURNS integer`, `app.identity_finish_breached_import(p_version text) RETURNS integer` (SQL in C2 05-SCHEMA §10.3) | lims_owner | lims_worker | breached-password list import into class G `identity.g_breached_passwords` (C2 05-SCHEMA §3) | none (class G, no RLS) |
| `app.identity_platform_auth_write_session_insert(uuid, jsonb)`, `app.identity_platform_auth_write_session_update(uuid, uuid, jsonb)`, `app.identity_platform_auth_write_mfa_factor(uuid, uuid, jsonb)`, `app.identity_platform_auth_write_invitation_accept(uuid, uuid)`, `app.identity_platform_auth_write_staff_login(uuid)` [CONV names, C2] (08 A28.1); `app.identity_notify_ip_throttle_hmacs(inet, timestamptz) RETURNS SETOF bytea` (the `identity.notify_ip_throttle` `auth_events` reader, 08 A28.4) — signatures and SQL in C2 05-SCHEMA §10.3 | lims_owner | lims_api (the five `app.identity_platform_auth_write_*`) / lims_worker (`app.identity_notify_ip_throttle_hmacs`) | platform-staff session/MFA/invitation/last-login writes before a platform session exists; tenant-less `auth_events` read for the throttle notice | `app.identity_platform_auth_write_*`: owner policies `tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid` (`platform_staff__update__owner_only`: `user_id = app.pre_user_id`) on `identity.sessions`, `identity.mfa_factors`, `identity.invitations`, `identity.platform_staff` (C2 05-SCHEMA §5.4); `app.identity_notify_ip_throttle_hmacs`: `auth_events__select__owner_only` branch gated by `app.maintenance = 'identity_notify_ip_throttle'` (C2 05-SCHEMA §5.4) |
| `app.reporting_verify_qr(bytea)`, `app.reporting_resolve_portal_credential(text, bytea)`, `app.reporting_ingest_provider_callback(text, bytea, jsonb)` | lims_reporting_lookup | lims_api | pre-tenant token lookups (CR-C6-002; bytea per 08 R24) | lookup (GUC-bound; `app.pre_*` names, 08 A21.4) |
| `app.reporting_redeem_link_for_app(p_token_sha256 bytea, p_phone_sha256 bytea) RETURNS TABLE (tenant_id uuid, patient_id uuid, report_id uuid, version_no integer, released_at timestamptz)` (SQL in C6 05-SCHEMA; 08 A13 D-30) | lims_reporting_lookup | lims_api | `ReportingPort.redeemPortalLinkForApp`: a row only for a valid link with recipient `patient`, channel `sms`\|`whatsapp` and `coalesce(portal_links.destination_sha256, delivery destination) = p_phone_sha256`; a mismatch increments `portal_links.redeem_failures` (≤ 5, then nothing is returned) | `portal_links__select__owner_only` / `__update__owner_only` `TO lims_reporting_lookup` `USING (token_sha256 = <app.pre_portal_token_sha256>)`; column grant `UPDATE (redeem_failures, updated_at, version) ON reporting.portal_links TO lims_reporting_lookup` (C6) |
| `app.instruments_resolve_device_credential(bytea)`, `app.instruments_agent_state_snapshot()`, `app.purge_instruments_archive(p_raw_retention_days integer)` (≥ 365; signature changed by 08 A13 D-42) | lims_owner | lims_api / lims_worker | device credential before context; agent metrics; archive purge (CR-C7-006). D-42: `instruments.purge_archive` runs `per_tenant` (P-6) and passes the retention derived from `TenantSettings.retention.rawInstrumentYears` (read via IdentityPort; C7 TRD §10) | owner_only; the purge's policies gated on `app.maintenance = 'purge_instruments_archive'` (08 A12.2, A13) |
| `app.current_partner_id()` (body from C13 05-SCHEMA; created in the C0 helpers stage, §4.5, 08 A30.1) | lims_owner | lims_app | partner actor scope (CR-C13-004) | owner_only |
| `app.payments_resolve_callback_token(p_token_sha256 bytea) RETURNS TABLE (tenant_id uuid, intent_id uuid)` (SQL in C15 05-SCHEMA) | lims_owner | lims_api | payment callback before context (CR-C15-004) | `intents__select__owner_only ON payments.intents TO lims_owner USING (callback_token_sha256 = decode(current_setting('app.pre_payments_callback_token_sha256', true), 'hex'))` — GUC `app.pre_payments_callback_token_sha256` (hex), set and reset in the body (08 A12.1; C15 05-SCHEMA P-41 table) |
| `app.engagement_resolve_preauth(text, bytea)`, `app.engagement_resolve_display(bytea)` (C16 05-SCHEMA §6.6; `app.engagement_resolve_tenant_code` is removed, replaced by C0 `app.core_resolve_tenant_code`, 08 A19 D-121) | lims_owner | lims_api | patient pre-auth / queue display before context (CR-C16-005; bytea per 08 R24) | `otp_challenges__select__owner_only` (GUC `app.pre_engagement_otp_token_sha256`), `queue_displays__select__owner_only` (GUC `app.pre_engagement_display_token_sha256`); C0 `tenants__select__owner_only` (`app.pre_tenant_id` branch) |
| `app.engagement_account_id()`, `app.engagement_patient_ids()`, `app.engagement_patient_visible(uuid, timestamptz)` (these three and the INVOKER `app.engagement_preauth_stage()` are created in the C0 helpers stage, §4.5, 08 A30.1; bodies from C16 05-SCHEMA §6.1), `app.engagement_redeem_link_code(bytea)` (takes the 32-byte HMAC, 08 A2.4, D-110), `app.engagement_apply_report_link(uuid, timestamptz)`, `app.engagement_code_redeemed_by_me(uuid, uuid)` (C16 05-SCHEMA §6.6) | lims_owner | lims_app | patient actor scope (CR-C16-006) | per C16 05-SCHEMA §6.6: `accounts__select__owner_only`, `account_patient_links__select/update__owner_only`, `link_codes__select/update__owner_only` (tenant-claim bound, 08 D-121); C0 `memberships__select__owner_only` |
| `engagement.purge_payment_requests()`, `engagement.purge_queue()` (each `RETURNS integer`; C16 05-SCHEMA §6.6) | lims_owner | lims_worker | retention of non-E engagement rows (08 D-121 last bullet) | `payment_requests__select/delete__owner_only` (`app.maintenance = 'engagement_purge_payment_requests'`); `queue_tokens__…`, `queue_day_counters__select/delete__owner_only` (`app.maintenance = 'engagement_purge_queue'`) |
| `frontdesk.purge_trf_drafts(p_older_than interval, p_ids uuid[]) RETURNS integer` (C4 hand-off, 08 A25 §(c)(ii); SQL in C4 05-SCHEMA) | lims_owner | lims_worker | TRF draft purge (C4) | owner policies on `frontdesk.trf_attachments` gated by `app.maintenance = 'frontdesk_purge_trf_drafts'` (C4) |
| `partners.redact_lines(uuid, timestamptz)` (C13 hand-off; SQL in C13 05-SCHEMA) | lims_owner | lims_worker | manifest-line redaction (C13); tenant-bound | owner policies gated by `app.maintenance = 'partners_redact_lines'` plus the tenant claim (C13; owner policies also note `app.current_partner_id()`) |
| `app.homecollection_anonymise_retired_visits(timestamptz)` (C17 hand-off; SQL in C17 05-SCHEMA) | lims_owner | lims_worker | anonymisation of retired home visits (C17) | `visits__select/update__owner_only`, `handover_items__select/update__owner_only`, gated by `app.maintenance = 'homecollection_anonymise_retired_visits'` plus the tenant claim (C17) |
| **Removed:** the GoTrue access-token hook function and the membership fallback lookup function | — | — | no GoTrue hook path (08 R10) | — |

Not DEFINER (INVOKER, listed for completeness): `app.is_staff_or_system()` (CR-C13-011), `app.current_lims_session_id()` (C0 DDL, 08 A20.2), `app.engagement_preauth_stage()` (no table read; C16 05-SCHEMA §6.6), `app.purge_inventory_alerts()` (CR-C12-008). Bodies of module-requested functions are specified in the owner chunk's `05-SCHEMA.md`; C0 translates them verbatim.

Every entry: `SET search_path = ''`, schema-qualified references, no caller-supplied tenant parameter (REQ-SEC-019/020). CI asserts the set of `prosecdef` functions equals this inventory.

**Owner-policy rule (08 A10.5, program-wide).** FORCE RLS applies to the table owner (`lims_owner`), so a SECURITY DEFINER that reads, updates or deletes a FORCE-RLS table sees only the rows admitted by a policy `TO` its owner role. Each such function needs a matching `<table>__<cmd>__owner_only` policy `TO lims_owner` with the narrowest USING clause the function needs. PostgreSQL 16 behaviour checked on a PG 16 scratch cluster (2026-11-06; re-verified on the pinned `supabase/postgres:17.6.1.136` image by the T0B-08 owner-policy suite, §10 schema test 31 — review C0 m#33): an owner `DELETE … WHERE <col>` also needs a SELECT policy admitting the existing row. An owner `UPDATE … WHERE <col>` (with or without `RETURNING`) also needs a SELECT policy admitting both the existing row and the new row. A plain `INSERT` without `RETURNING` needs only the INSERT policy. One policy name per table and command (`<table>__<command>__<scope>`), so several functions on one table share one `owner_only` policy whose USING clause ORs their predicates. `db/meta/definer-inventory.yaml` records, for each function, the tables and commands it touches and the policy that admits them. CI (C0-0B, T0B-08) runs each function's contract test with FORCE RLS on every table it touches. It asserts non-empty results where the fixture expects rows, e.g. `app.is_platform_actor()` = true for an active staff row and a purge deleting its seeded expired rows. Schema and contract tests never run `ALTER TABLE … DISABLE ROW LEVEL SECURITY` or `NO FORCE ROW LEVEL SECURITY` and never create stand-in tables without ENABLE + FORCE RLS (AC-0B-2.4; §10 schema test 13).

**GUC-bound owner policies (08 A12.1–A12.3, program-wide; applies 08 §4.7).** A static policy cannot reference a function parameter, and a cross-tenant read has no claims to bind to. In both cases the DEFINER sets a transaction-local GUC **inside its body** with `set_config(name, value, true)` before the read, its `owner_only` policies (`TO lims_owner` only) match on that GUC, and the function resets every GUC it set to `''` before it returns. Because the policies name only `lims_owner`, a `lims_app` session that sets the same GUC itself sees nothing. Two families:
- *Pre-tenant lookups* use `app.pre_*` text GUCs holding the presented value. The C2 names are fixed by 08 A12.1: `app.pre_session_token_sha256` (hex of the presented hash), `app.pre_gotrue_session_id`, `app.pre_user_id` (GoTrue `sub`), `app.pre_tenant_id` (set only after the function has chosen the membership; for a platform support session, `app.identity_resolve_session` sets it to the session's `support_tenant_id` before reading `core.tenants` — 08 A20.1, served by the existing `tenants__select__owner_only` `id = app.pre_tenant_id` branch, no new policy). C0's own pre-tenant GUC: `app.pre_tenant_code` (`app.core_resolve_tenant_code`, 08 A19 D-121). Predicates in C2 05-SCHEMA §5.4 and, for `core` tables, §10 below.
- *Cross-tenant maintenance* functions set `set_config('app.maintenance', '<function name>', true)`; their owner policies are `USING (current_setting('app.maintenance', true) = '<function name>' AND <narrow predicate>)` (the narrow predicate is omitted only where the function needs every row, e.g. `app.platform_list_tenants`). This replaces ad-hoc GUC names (e.g. C7 `app.instruments_purge` becomes `app.maintenance = 'instruments_purge_messages'` style). It applies to **every** cross-tenant maintenance DEFINER (08 A15.3): C0 `app.platform_list_tenants` (08 A12.3), `app.cron_tenant_ids` (08 A23.1), `app.identity_tenants_for_email_hmacs` (08 A25 D-217) and the C0 purges of this section (`app.purge_event_log`, `app.purge_event_inboxes`, `app.purge_idempotency_keys`, `app.purge_dead_letters`), C7 `app.purge_instruments_archive` (08 A13 D-42), C2 `app.identity_purge_auth_events` (08 A12.2), `app.identity_purge_sessions` and `app.identity_expire_*` (C2 05-SCHEMA §5.4), and the C6, C7, C13, C15 and C16 purge/expiry functions in their review fix pass. No static (ungated) owner policy for maintenance remains. `app.purge_ratelimit_counters()` is the one purge with no owner policy: `core.rate_limit_counters` is RLS-exempt (§3.5).

CI (T0B-08): every policy whose `qual` or `with_check` mentions `app.pre_` or `app.maintenance` has `roles = {lims_owner}`; each GUC-bound function's contract test proves (a) it returns the expected row with FORCE RLS on, (b) a `lims_app` session that sets the same GUC directly sees nothing, (c) the GUC is `''` after the function returns (08 A12.7; §10 schema tests 16–17; C2 05-SCHEMA §11 tests 22, 24).

Audit of the C0 DDL DEFINERs against this rule (08 A10.5, A12). The C2 DEFINERs are audited in C2 05-SCHEMA §5.4; the `core` owner policies they need (`memberships__select__owner_only` `app.pre_user_id` branch, `users__select__owner_only`, `tenants__select__owner_only` `app.pre_tenant_id` branch, `roles__select__owner_only`, `membership_roles__select__owner_only`; 08 A12.1) are C0 DDL in §10. The module DEFINERs of C6, C7, C13, C15 and C16 have their bodies in those chunks; CI applies the same rule to them when C0 translates them.

| Function | FORCE-RLS table · command | Owner policy that admits it |
|---|---|---|
| `app.has_all_centres()` | `core.memberships` · SELECT | `memberships__select__owner_only` (tenant-bound branch; the `app.pre_user_id` branch serves C2, 08 A12.1) |
| `app.current_centre_ids()` | `core.memberships`, `core.membership_centres` · SELECT | `memberships__select__owner_only`, `membership_centres__select__owner_only` (existing) |
| `app.is_platform_actor()` (C0 DDL since 08 A15.6) | `identity.platform_staff` · SELECT | `platform_staff__select__owner_only` `USING (true)` (C2 identity DDL, C2 05-SCHEMA §10.1; 08 A10.5) |
| `app.tg_row_audit()` | `audit.audit_log` · INSERT (no RETURNING) | `audit_log__insert__owner_only` — **changed** (08 A12.5): `tenant_id = (SELECT app.current_tenant_id())`, or, with no tenant claim, a `core.tenants` row audited under its own id in platform context (`schema_name = 'core' AND table_name = 'tenants' AND row_id = tenant_id AND (SELECT app.is_platform_actor())`). Not attached to platform-only tables (§4.4) |
| `app.enqueue_job(...)`, `app.queue_depth()` | none (owner `lims_queue`; `core.g_task_registry` is class G, `graphile_worker` has no RLS) | — |
| `app.ratelimit_hit(...)`, `app.purge_ratelimit_counters()` | none (`core.rate_limit_counters` is RLS-exempt) | — |
| `app.purge_event_log()` | `core.event_log` · SELECT (subquery + WHERE), DELETE | `event_log__select__owner_only` and `event_log__delete__owner_only`, both `USING (current_setting('app.maintenance', true) = 'purge_event_log' AND created_at < now() - interval '90 days')` (gate **added** by 08 A15.3) |
| `app.purge_event_inboxes()` | `<m>.event_inbox` · SELECT, DELETE | `event_inbox__select__owner_only` and `event_inbox__delete__owner_only` per schema of §3.9, both `USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days')` (gate added, 08 A15.3) |
| `app.purge_idempotency_keys()` | `core.idempotency_keys` · SELECT, DELETE | `idempotency_keys__select__owner_only` and `idempotency_keys__delete__owner_only`, both `USING (current_setting('app.maintenance', true) = 'purge_idempotency_keys' AND expires_at < now())` (gate added, 08 A15.3) |
| `app.purge_dead_letters()` | `core.dead_letters` · SELECT, DELETE | `dead_letters__select__owner_only` `USING (tenant_id IS NULL OR (current_setting('app.maintenance', true) = 'purge_dead_letters' AND state <> 'open' AND resolved_at < now() - interval '90 days'))` (the `tenant_id IS NULL` branch serves `app.dl_*`); `dead_letters__delete__owner_only` `USING (current_setting('app.maintenance', true) = 'purge_dead_letters' AND state <> 'open' AND resolved_at < now() - interval '90 days')` (gate added, 08 A15.3) |
| `app.dl_insert_platform(...)` | `core.dead_letters` · INSERT (no RETURNING) | `dead_letters__insert__owner_only` (existing) |
| `app.dl_list_platform(...)` | `core.dead_letters` · SELECT | `dead_letters__select__owner_only` (the function also filters `tenant_id IS NULL`) |
| `app.dl_resolve(...)` | `core.dead_letters` · UPDATE … WHERE … RETURNING | `dead_letters__update__owner_only` + `dead_letters__select__owner_only` (old and new row keep `tenant_id IS NULL`) |
| `app.platform_list_tenants(...)` | `core.tenants` · SELECT; `identity.platform_staff` · SELECT (via `app.is_platform_actor()`) | `tenants__select__owner_only` `USING (id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid OR current_setting('app.maintenance', true) IN ('platform_list_tenants', 'cron_tenant_ids') OR tenant_code = nullif(current_setting('app.pre_tenant_code', true), ''))` (maintenance branch 08 A12.3; the first branch serves C2, 08 A12.1); `platform_staff__select__owner_only` (C2) |
| `app.cron_tenant_ids()` | `core.tenants` · SELECT | `tenants__select__owner_only` — `app.maintenance = 'cron_tenant_ids'` branch (**added**, 08 A23.1; the function itself filters `status IN ('active','suspended')`) |
| `app.core_resolve_tenant_code(text)` | `core.tenants` · SELECT | `tenants__select__owner_only` — `tenant_code = nullif(current_setting('app.pre_tenant_code', true), '')` branch (**added**, 08 A19 D-121; one owner SELECT policy per table) |
| `app.identity_tenants_for_email_hmacs(bytea[])` | `core.users` · SELECT | `users__select__owner_only` — **added** branch `current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL` (08 A25 D-217), ORed with the C2 `app.pre_user_id` branch |

### 4.4 Triggers

- `app.enforce_mutable_columns()` — CV §5.7 (INVOKER). Attached `BEFORE UPDATE` to class C/B tables with the owner's column list. The mutable-column list is `coalesce(TG_ARGV::text[], '{}')` (08 A20.3, same reason as A15.5 below): a trigger created with no arguments allows no column to change and raises `immutable_row` on any change; it never silently allows everything (§10 schema test 25).
- `app.tg_row_audit()` — `AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW` on audited tables. Raises `audit_context_missing` (SQLSTATE `P0001`) when neither a claims `sub` nor `app.maintenance` is set, so unaudited writes cannot happen. **Maintenance DEFINERs (08 A28.5):** with no claims but `app.maintenance` set (e.g. C2 `identity_expire_invitations`, `identity_expire_support_sessions`), the row is audited with `actor_type = 'system'`, `actor_id` / `created_by` NULL, `detail = {"maintenance": <function name>}` and the row's `tenant_id` (the row's own id for `core.tenants`); `audit_log__insert__owner_only` admits exactly that shape (§10 schema test 32). `tenant_id` of the audit row = the audited row's `tenant_id`; for `core.tenants` (no `tenant_id` column) it is the row's own `id`, which is what is written when no tenant claim is present (platform context; with a tenant claim the `__tenant` policies already force `id` = the claim) — 08 A12.5. `audit_log__insert__owner_only` admits that platform-context row (§4.3 audit, §10). **Not attached** to `identity.platform_staff`, `identity.platform_events` or any other platform-only table (no `tenant_id`, or `tenant_id` always NULL): their changes are recorded in `identity.platform_events` by the C2 service or DEFINER (08 A12.5; C2 05-SCHEMA §3.1). The bootstrap CLI path (`app.identity_bootstrap_platform_admin`, no claims) therefore raises no `audit_context_missing` (§10 schema test 19). Optional trigger arguments list excluded columns that are never copied into `audit_log` (e.g. `payments.merchant_accounts.secret_ciphertext/secret_nonce/secret_auth_tag`, CR-C15-013; 02-CV §5.7). The excluded-column list is `coalesce(TG_ARGV::text[], '{}')` (08 A15.5): with no trigger arguments PL/pgSQL `TG_ARGV` is NULL, and `jsonb - NULL` / `key <> ALL (NULL)` would yield NULL, so an argument-less trigger wrote INSERT/DELETE rows without values and skipped every UPDATE as a no-op. INSERT records the new row (`new_values`), DELETE the old row (`old_values`), UPDATE the changed columns (`changed_columns`, `old_values`, `new_values` of those columns only; AC-0B-5.2) (§10 schema test 20). **NULL-tenant rows of mixed tables (08 A25 D-215):** when the audited row's `tenant_id` is NULL and the table is not `core.tenants`, the trigger writes **no** `audit_log` row and does not raise (e.g. C2 `invitations` / `mfa_factors` / `ird_annex_records` platform rows; C2 records those changes in `identity.platform_events`) (§10 schema test 28).
- Trigger inventory notes from the review hand-offs (08 A25 §(c)(ii)): `frontdesk.patients` gets `tg_row_audit` with the excluded-column arguments `full_name, name_search, birth_on, phone_e164, email, address_text` (08 A13 D-27(a); compensating access-log `patient.update` is C4's); `reporting.portal_links` gets **no** default `tg_row_audit` — C6's own conditional audit triggers replace it (08 A21.3).
- `app.tg_dead_letter_transition()` — `BEFORE UPDATE` on `core.dead_letters`: only `state` (`open → replayed|discarded`), `resolved_by`, `resolved_at`, `resolution_note` (discard reason / replay note, 08 A8.4) and `version` (If-Match bump, 08 A3.4) may change.
- No trigger, policy or DEFINER writes `core.memberships.is_active` (generated, 08 A3.4); membership lifecycle writes set `status`.

### 4.5 Migration stage order and the helpers stage (08 A30.1, A30.2)

Every `app.*` helper used inside an RLS policy is created in C0's early **helpers** stage, before any module's tables or policies. That covers C0's own helpers and the module-requested ones: `app.current_partner_id()` (body: C13 05-SCHEMA) and `app.engagement_patient_ids()` (body: C16 05-SCHEMA §6.1), both used by C6 `reporting` policies, which precede `partners` and `engagement` in the DAG, and the other C16 policy helpers `app.engagement_preauth_stage()`, `app.engagement_account_id()`, `app.engagement_patient_visible(uuid, timestamptz)` (C16 05-SCHEMA §6.1; `app.engagement_patient_ids()` calls `app.engagement_account_id()`). No other chunk's policies call a module-defined `app.*` helper (smoke-load and grep, 2026-11-06). Bodies that read module tables are created with `check_function_bodies = off` in that stage (resolved at first call, after the owning module's migration). The owning chunk's 05-SCHEMA keeps the body of record; its migration uses `CREATE OR REPLACE FUNCTION` with the same text, so the function is not created twice.

Stage order (02-TRD §4.2 "Ordering = schema DAG"; §10 below is concatenated in this order):

1. Bootstrap roles (§1, `db/bootstrap/00_roles.sql`).
2. Schemas and default privileges (§2, `*_app__create_schemas.sql`).
3. **Helpers stage** (`*_app__create_context_helpers.sql`): context helpers, `app.is_staff_or_system()`, `app.current_lims_session_id()`, `app.is_platform_actor()` (`check_function_bodies` off), `app.uuidv7()`, and the module policy helpers `app.current_partner_id()`, `app.engagement_preauth_stage()`, `app.engagement_account_id()`, `app.engagement_patient_ids()`, `app.engagement_patient_visible(uuid, timestamptz)` (`check_function_bodies` off; 08 A30.1).
4. `core` tables, platform tables, `audit`, `<m>.event_inbox` for every schema of §3.9 (generated by C0 only; a module 05-SCHEMA never creates its own, 08 A30.2), the C0 DEFINER helpers `app.has_all_centres()` / `app.current_centre_ids()`, triggers, queue wrapper, rate limit, retention purges, platform dead letters, tenant list, cron fan-out, tenant-code resolver, throttled-IP tenant lookup, C0 RLS (incl. the `event_inbox` policies) and helper grants.
5. Module migrations in DAG order: `identity` → `catalog` → `frontdesk` → `billing` → `lab` → `instruments` → `reporting` → `analytics` → Wave 2 (`quality`, `micro`, `anatomic`, `inventory`, `partners`, `smartreport`, `payments`) → Wave 3 (`engagement`, `homecollection`) → `migration_staging`.

## 5. Grants per C0 table

| Table | lims_app | Others |
|---|---|---|
| core.tenants, branches, collection_centres, users, memberships, roles | SELECT, INSERT, UPDATE | — |
| core.membership_centres, membership_branches, role_permissions, membership_roles | SELECT, INSERT, DELETE | — |
| core.g_permissions, g_system_actors, g_task_registry | SELECT | lims_queue: SELECT on g_task_registry |
| core.event_log | SELECT, INSERT | — |
| <m>.event_inbox | SELECT, INSERT | — |
| core.dead_letters | SELECT, INSERT, UPDATE (used only by C0 core code — `ctx.core.deadLetters` and the worker dead-letter wrapper; C2 has no SQL or grant of its own on this table, 08 A8.6) | — |
| core.idempotency_keys | SELECT, INSERT, UPDATE, DELETE | — |
| core.rate_limit_counters | none | — |
| audit.audit_log | SELECT | — |
| audit.access_log | SELECT, INSERT | — |
| audit.g_cs_access_actions | SELECT | — |

## 6. RLS policies (all `TO lims_app` unless stated; FORCE RLS on every table)

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| core.tenants | `__tenant`: `id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())` (guard added, 08 A23.3); `__owner_only` (lims_owner: `id = app.pre_tenant_id` GUC — C2 pre-tenant lookups, 08 A12.1, A20.1 — OR `app.maintenance IN ('platform_list_tenants','cron_tenant_ids')`, 08 A12.3, A23.1 — OR `tenant_code = app.pre_tenant_code` GUC, 08 A19 D-121) | `__tenant` (same predicate; provisioning transaction sets claims `tenant_id` = new id) | `__tenant` | none |
| core.branches, collection_centres, users, roles | `__tenant`; users and roles also `__owner_only` (lims_owner; users: `id = app.pre_user_id` GUC, for `app.identity_user_exists`, OR `app.maintenance = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL`, 08 A25 D-217; roles: `tenant_id = app.pre_tenant_id` GUC, for `app.identity_login_context`; 08 A12.1) | `__tenant` | `__tenant` | none |
| core.memberships | `__tenant`; `__owner_only` (lims_owner: tenant claim, OR `user_id = app.pre_user_id` GUC, 08 A12.1) | `__tenant` | `__tenant` | none |
| core.membership_centres | `__tenant`; `__owner_only` (lims_owner) | `__tenant` | none | `__tenant` |
| core.membership_branches | `__tenant` | `__tenant` | none | `__tenant` |
| core.role_permissions, membership_roles | `__tenant`; membership_roles also `__owner_only` (lims_owner: `tenant_id = app.pre_tenant_id` GUC and a membership of `app.pre_user_id`, for `app.identity_login_context`, 08 A12.1) | `__tenant` | none | `__tenant` |
| core.event_log (`shared_with: [partner, portal, patient]`) | `__tenant`; `__owner_only` (lims_owner: `app.maintenance = 'purge_event_log' AND created_at < now() - interval '90 days'`, for `app.purge_event_log`, 08 A10.5, A15.3); **no** non-staff SELECT (08 A23.3) | `__tenant`; `__partner` / `__portal` / `__patient`: `tenant_id = app.current_tenant_id() AND created_by = app.current_actor_id() AND actor_type = <that type>` (08 A23.3) | none | `__owner_only` (lims_owner: `app.maintenance = 'purge_event_log' AND created_at < now() - interval '90 days'`) |
| <m>.event_inbox | `__tenant`; `__owner_only` (`app.maintenance = 'purge_event_inboxes' AND received_at < now() - interval '90 days'`, 08 A10.5, A15.3) | `__tenant` | none | `__owner_only` (`app.maintenance = 'purge_event_inboxes' AND received_at < now() - interval '90 days'`) |
| core.dead_letters | `__tenant` (tenant rows); `__platform` (`tenant_id IS NOT NULL AND app.is_platform_actor()`, 08 A10.4); `__owner_only` (`tenant_id IS NULL OR (app.maintenance = 'purge_dead_letters' AND state <> 'open' AND resolved_at < now() - interval '90 days')` — `app.dl_*` and `app.purge_dead_letters`, 08 A10.5, A15.3) | `__tenant`; `__owner_only` (`tenant_id IS NULL`) | `__tenant`; `__platform` (`tenant_id IS NOT NULL`, 08 A10.4); `__owner_only` (`tenant_id IS NULL`) | `__owner_only` (`app.maintenance = 'purge_dead_letters' AND state <> 'open' AND resolved_at < now() - interval '90 days'`) |
| core.idempotency_keys (`shared_with: [partner, portal, patient]`) | `__tenant` + `actor_id = (SELECT app.current_actor_id())`; `__partner` / `__portal` / `__patient` (`tenant_id = app.current_tenant_id() AND actor_id = app.current_actor_id() AND actor_type = <that type>`, 08 A23.3); `__platform` (`tenant_id IS NULL AND actor_id = app.current_actor_id() AND app.is_platform_actor()`, 08 A25 D-213); `__owner_only` (`app.maintenance = 'purge_idempotency_keys' AND expires_at < now()`, for `app.purge_idempotency_keys`, 08 A10.5, A15.3) | `__tenant`, the three actor policies, `__platform` (same predicates) | same as INSERT | `__tenant`, actor and `__platform` policies, each + `state = 'in_progress'` [CONV: 02-TRD §6.6 step 5 / D-202 release of the actor's own in-progress key; A23.3/D-213 name SELECT/INSERT/UPDATE, the DELETE of the actor's own in-progress row is the same release step the staff path has]; `__owner_only` (`app.maintenance = 'purge_idempotency_keys' AND expires_at < now()`) |
| audit.audit_log | `__tenant` (with the staff guard, 08 A23.3, and the CR-C2-010 centre clause `centre_id IS NULL OR has_all_centres() OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])`, 08 A28.6) | `__owner_only` (lims_owner, `tenant_id = (SELECT app.current_tenant_id())`, or a platform-context `core.tenants` row under its own id, 08 A12.5) | none | none |
| audit.access_log (`shared_with: [partner, portal, patient]`) | `__tenant` (staff guard + CR-C2-010 centre clause, 08 A28.6); **no** non-staff SELECT (08 A23.3) | `__tenant`; `__partner` / `__portal` / `__patient`: `tenant_id = app.current_tenant_id() AND actor_id = app.current_actor_id() AND actor_type = <that type>` (08 A23.3) | none | none |
| G tables | no RLS (no tenant data; listed in `rls_exempt.txt`) | — | — | — |
| core.rate_limit_counters | RLS-exempt (no grants) | — | — | — |

In this table `app.maintenance = '<name>'` stands for `current_setting('app.maintenance', true) = '<name>'`, set and reset by the named function (§4.3 GUC rule; 08 A12.2, A15.3).

Every `__tenant` policy above — on **every** core and audit table, incl. `core.tenants` and `audit.audit_log` — has `(SELECT app.is_staff_or_system())` in USING and WITH CHECK, and the §10 DDL shows it (08 A17 P-16, A23.3; CR-C13-011; 08 R10 item 5). `core.event_log`, `core.idempotency_keys` and `audit.access_log` are `shared_with: [partner, portal, patient]` in `db/meta/tables.yaml`; their non-staff access is only the actor-specific policies in the table (`__partner`, `__portal`, `__patient`; the `__tenant` policies keep the guard). Those actor policies bind `actor_type = <type>` [CONV: makes each policy actor-specific, as P-16 requires, and keeps staff on the guarded `__tenant` policy]. Scope `portal` is used for the portal actor's policies [CONV; 02-CV §5.8 lists `partner` and `patient` only — hand-off to the 02-CV owner]. Non-staff actors read tenant data only through `ctx.core`/ports called under a system actor or the actor-specific reads of 02-CV §8.5 (D-119); C2 builds partner/patient/portal profiles from the fixed permission sets without core reads (C2 TRD §7.1; triage batch 4 §(h) C0 #3). C2's `__platform` policies on core tables (C2 05-SCHEMA §5.3) are added in the same migrations; on `core.dead_letters` the `__platform` SELECT/UPDATE policies are written by C0 and serve `ctx.core.deadLetters`, which runs under platform claims (08 A8.6). They admit only rows with `tenant_id IS NOT NULL`; NULL-tenant (platform-task) rows are reachable only through the `app.dl_*` DEFINERs (08 A10.4; DDL §10). Policy scopes used: `tenant`, `tenant_centre`, `owner_only`, `lookup`, `platform`, `partner`, `patient` (02-CV §5.8); no `auth_hook` scope.

Core tables are **tenant-scoped, not centre-scoped**: every module reads branches/centres/memberships through `ctx.core` (CM §5 R1), and centre filtering applies to the data tables that carry `centre_id`.

## 7. Indexes (every query in `02-TRD.md` §6–§7)

| Index | Serves |
|---|---|
| `tenants__tenant_code__uq` (global) | provisioning uniqueness |
| `branches__tenant_id_branch_code__uq`; `branches__tenant_id_is_active__idx (tenant_id, is_active)` | `ctx.core.branches` |
| `collection_centres__tenant_id_centre_code__uq`; `collection_centres__tenant_id_branch_id__idx (tenant_id, branch_id, is_active)` | `ctx.core.centres({branchId})` |
| `users__tenant_id_email_normalized__uq (tenant_id, email_normalized)` (08 A3.4) | C2 invite/recovery lookup |
| `memberships__tenant_id_id__uq`; `memberships__tenant_id_user_id_actor_type__p_uq (tenant_id, user_id, actor_type) WHERE status IN ('invited','active')` (08 A3.4) | composite FKs; C2 lookups |
| `memberships__user_id__p_uq (user_id) WHERE actor_type = 'user' AND status IN ('invited','active')` (**exception**, `db/meta/index-exceptions.yaml`: partial global unique, one tenant per staff user — 08 R27, predicate per 08 A3.4; read only inside `app.identity_user_exists` / `app.identity_login_context`) | invite collision check, login context |
| `membership_branches` PK (tenant_id, membership_id, branch_id) | `IdentityPort.getActor` branchIds (08 R3) |
| `membership_centres` PK (tenant_id, membership_id, centre_id) | `app.current_centre_ids()` |
| `membership_roles` PK; `role_permissions` PK | `ctx.core.membershipPermissions` |
| `role_permissions__tenant_id_permission_code__idx (tenant_id, permission_code)`; `membership_roles__tenant_id_role_id__idx (tenant_id, role_id)` (08 A3.4) | C2 last-admin checks, role member counts |
| `event_log` PK (tenant_id, event_id); `event_log__tenant_id_event_type_idempotency_key__uq`; `event_log__tenant_id_aggregate__idx (tenant_id, aggregate_type, aggregate_id, aggregate_seq)` (IC §12); `event_log__created_at__brin` (**exception**, retention) | publish dedupe, fan-out read, purge |
| `<m>.event_inbox` PK (tenant_id, event_id); `event_inbox__received_at__brin` (**exception**) | consumer dedupe, purge |
| `dead_letters__state_dead_at__idx (state, dead_at)` (IC §12); `dead_letters__tenant_id_state_dead_at__idx` | console lists |
| `idempotency_keys__tenant_id_actor_id_key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, actor_id, key)` (replaces the PK, 08 A25 D-213; PostgreSQL ≥ 15); `idempotency_keys__expires_at__idx` (IC §12) | idempotency claim (`ON CONFLICT (tenant_id, actor_id, key)`); purge |
| `audit_log` PK (tenant_id, occurred_at, id); `audit_log__tenant_id_id__idx`; `audit_log__tenant_id_table_row__idx (tenant_id, schema_name, table_name, row_id, occurred_at DESC)`; `audit_log__tenant_id_actor__idx (tenant_id, actor_id, occurred_at DESC)`; `audit_log__tenant_id_request_id__idx (tenant_id, request_id)`, partial `audit_log__tenant_id_support_session__p_idx (tenant_id, support_session_id, occurred_at DESC) WHERE support_session_id IS NOT NULL` (08 A28.6) | C2 audit viewer (incl. its `request_id` / `support_session_id` filters) (`/admin/audit/{audit_id}`, per-record history, per-user history) |
| `access_log` PK; `access_log__tenant_id_id__idx`; `access_log__tenant_id_entity__idx (tenant_id, entity_type, entity_id, occurred_at DESC)`; `access_log__tenant_id_actor__idx (tenant_id, actor_id, occurred_at DESC)`; `access_log__tenant_id_action__idx (tenant_id, action, occurred_at DESC)`; `access_log__tenant_id_request_id__idx`, partial `access_log__tenant_id_support_session__p_idx` (same shapes, 08 A28.6) | access history, export review (REQ-SEC-045) |

## 8. Storage and Realtime policy templates (C0 writes; buckets come from chunk specs)

```sql
-- storage.objects (Supabase Storage). Applies only if SP-4 proves Storage populates request.jwt.claims (04 D3 UNVERIFIED).
-- One policy set per bucket; bucket list = 08 §4.8 (`<owner-module>-<purpose>`, exception `reports` — 08 R26): reports, reporting-inputs, reporting-prints,
-- identity-assets, identity-exports, frontdesk-trf, billing-exports, instruments-attachments, micro-imports, anatomic-images,
-- partners-slips (08 A5.2; write-once per successful issue — a retry before the row is 'issued' may replace it (upsert); review C0 m#32)
-- (reporting-legacy reserved, B4).
-- Until SP-4 passes, no end-user policy is created; all access is server-side through ctx.storage (08 R12b). Example for bucket 'reports' (04 D15):
CREATE POLICY reports__select__tenant ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'reports' AND (storage.foldername(name))[1] = ((SELECT app.current_tenant_id()))::text);
-- INSERT/UPDATE/DELETE policies for 'reports' are NOT created: report PDFs are written by the service path chosen in C6's TRD and are immutable.
```

`realtime.messages` policies (Flutter only — 04 S5): topic prefix `tenant:{tenant_id}:` checked with `realtime.topic()`; written when C16/C17 specs exist; gated by SP-4.

## 9. Rules for translating other chunks' `05-SCHEMA.md`

1. The column list, types, nulls, defaults, checks, indexes, views and policies are taken **verbatim**. C0 adds only the mandatory items the chunk may omit: mandatory columns (CV §5.3), `UNIQUE (tenant_id, id)`, FORCE RLS, `tg_row_audit` if `audited`, `enforce_mutable_columns` for C/B.
2. Anything that violates CV §5 (ENUM types, non-composite FKs, an FK into `billing`, wrong FK direction, a policy to `authenticated`, `USING (true)`, a non-tenant-leading index without a stated reason, the uncast centre predicate `centre_id = ANY ((SELECT app.current_centre_ids()))` — 08 A16.1, a `__tenant`/`__tenant_centre` policy without `(SELECT app.is_staff_or_system())` on a table not marked `shared_with` — 08 A17 P-16) is **not** translated. C0 raises a CR to the chunk and builds the compliant form (`centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])`; the guard ANDed into USING and WITH CHECK).
3. Published views (`v_pub_*`) are created `WITH (security_invoker = true)` and `GRANT SELECT … TO lims_app, lims_analytics`, with the exact IC §6 column list (CV §5.13).
4. Every translated table enters `db/meta/tables.yaml` with its class, `centre_scoped`, `phi_class` per column, `audited`, retention, probe fixture, `shared_with` (when the owner lists non-staff actor policies, 08 A17 P-16) and `mandatory_column_exceptions` (copied from the owner's 05-SCHEMA §1 paragraph, P-18(b)).
5. The `billing` schema must stay isolatable (04 D16): no cross-tenant sequences, `tenant_id` leading every key, and the per-tenant export/restore test (AC-0B-6.4) is extended whenever billing DDL changes.
6. A DEFINER requested by a chunk is translated only from that chunk's 05-SCHEMA text with the P-41 items (full SQL body, owner policies `TO <function owner>`, gating, inventory row, A12.7 tests); C0 adds its §4.3 inventory row. Wording such as "C0 decides" is a CR back to the chunk (08 A19 P-41).
7. Transcription notes recorded from the review hand-offs (08 A25 §(c)(ii)): C17 — the `visits` transition-guard trigger lets the maintenance function `app.homecollection_anonymise_retired_visits` through (C17 05-SCHEMA exception text), the `handover_items` `enforce_mutable_columns` trigger carries C17's `WHEN` clause, `mutations__batch__fk` is `DEFERRABLE INITIALLY DEFERRED`, and `homecollection.event_inbox` is generated (§3.9); C11 — confirm `btree_gin` alongside `pg_trgm` in SP-3 (§1 `01_database.sql` creates both in `extensions`, 08 A31.1), otherwise an index exception for the `cs_diagnoses` trigram index; operator classes are referenced schema-qualified (`extensions.gin_trgm_ops`, 08 A31.1); `anatomic.event_inbox` is in the §3.9 list and gets the standard inbox policies; C8/C10/C11 mandatory-column exceptions per rule 4; C2 (08 A28.6) — `identity.ird_annex_documents` is class M, and `identity.sessions` / `identity.mfa_factors` are `shared_with: [partner]` in `db/meta/tables.yaml`.

## 10. DDL (C0-owned objects)

Split into migration files by the naming rule (`02-TRD.md` §4.2). Shown here concatenated in DAG order. Each file starts with `SET LOCAL ROLE lims_owner;` (shown once).

```sql
SET LOCAL ROLE lims_owner;

-- ===================================================================== app: context helpers (CV §5.8)
CREATE FUNCTION app.current_claims() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'tenant_id', '')::uuid
$$;
CREATE FUNCTION app.current_actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'sub', '')::uuid
$$;
CREATE FUNCTION app.current_actor_type() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT app.current_claims() ->> 'actor_type'
$$;
CREATE FUNCTION app.current_membership_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid
$$;
CREATE FUNCTION app.is_staff_or_system() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(app.current_actor_type() IN ('user','system','device'), false)
$$;   -- every __tenant policy has it (08 A17 P-16, A23.3); shared_with tables add separate actor policies (§6)
-- C0-owned since 08 A20.2 (moved from C2 with app.is_platform_actor()); C2 05-SCHEMA §5.1 references it and keeps its tests.
CREATE FUNCTION app.current_lims_session_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'lims_session_id', '')::uuid
$$;

-- Platform-context predicate (CR-C2-004). C0-owned (08 A15.6): created here, before every policy and function that references it
-- (core.dead_letters __platform policies, audit_log__insert__owner_only, app.dl_list_platform, app.dl_resolve,
-- app.platform_list_tenants below; the C2 identity and core.tenants __platform policies, C2 05-SCHEMA §10.1–§10.2). Body unchanged
-- from C2 05-SCHEMA §5.1. It reads identity.platform_staff, which the identity migration creates later in the DAG (02-TRD §4.2),
-- so this one statement is created with check_function_bodies off; the body is resolved at its first call, after the identity
-- migration. Under FORCE RLS it reads through platform_staff__select__owner_only (TO lims_owner USING (true); C2 05-SCHEMA §5.4,
-- 08 A10.5). Contract tests: C2 05-SCHEMA §11 test 21; grants and creation order: §10 schema test 21.
SET LOCAL check_function_bodies = off;
CREATE FUNCTION app.is_platform_actor() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (app.current_claims() ->> 'scope') = 'platform'
    AND (app.current_claims() ->> 'aal') = 'aal2'
    AND EXISTS (SELECT 1 FROM identity.platform_staff ps
                WHERE ps.id = nullif(app.current_claims() ->> 'platform_staff_id', '')::uuid
                  AND ps.user_id = app.current_actor_id()
                  AND ps.is_active), false)
$$;
SET LOCAL check_function_bodies = on;
REVOKE ALL ON FUNCTION app.is_platform_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_platform_actor() TO lims_app;   -- §4.3 inventory: lims_app (lims_api, lims_worker are members)

-- Module policy helpers (08 A30.1; §4.5): every module-requested app.* helper used inside an RLS policy. C6 reporting policies
-- use app.current_partner_id() and app.engagement_patient_ids() before partners / engagement exist; C16 policies use the
-- other three. They read module tables, so they are created here with check_function_bodies off. Bodies verbatim from
-- C13 05-SCHEMA (app.current_partner_id) and C16 05-SCHEMA §6.1 (the four app.engagement_* helpers). Owner lims_owner
-- (this file runs as lims_owner); the owning modules' migrations use CREATE OR REPLACE with the same text.
SET LOCAL check_function_bodies = off;
CREATE FUNCTION app.current_partner_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.current_actor_type() = 'partner' THEN (
    SELECT pu.partner_id
    FROM partners.partner_users pu
    JOIN partners.partners p ON p.tenant_id = pu.tenant_id AND p.id = pu.partner_id
    WHERE pu.tenant_id = app.current_tenant_id()
      AND pu.membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
      AND pu.status IN ('invited','active')
      AND p.status = 'active') END
$$;
CREATE FUNCTION app.engagement_preauth_stage() RETURNS text LANGUAGE sql STABLE AS $$   -- INVOKER (no table read)
  SELECT app.current_claims() ->> 'patient_stage'
$$;
CREATE FUNCTION app.engagement_account_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.current_actor_type() = 'patient' AND app.engagement_preauth_stage() IS NULL THEN (
    SELECT a.id FROM engagement.accounts a
    JOIN core.memberships m ON m.tenant_id = a.tenant_id AND m.id = a.membership_id
    WHERE a.tenant_id = app.current_tenant_id()
      AND a.membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
      AND a.status = 'active' AND m.actor_type = 'patient' AND m.is_active) END
$$;
CREATE FUNCTION app.engagement_patient_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(l.patient_id), '{}') FROM engagement.account_patient_links l
  WHERE l.tenant_id = app.current_tenant_id() AND l.account_id = app.engagement_account_id() AND l.status = 'active'
$$;
CREATE FUNCTION app.engagement_patient_visible(p_patient_id uuid, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM engagement.account_patient_links l
    WHERE l.tenant_id = app.current_tenant_id() AND l.account_id = app.engagement_account_id()
      AND l.patient_id = p_patient_id AND l.status = 'active'
      AND (l.visible_from IS NULL OR p_at >= l.visible_from))
$$;
SET LOCAL check_function_bodies = on;
REVOKE ALL ON FUNCTION app.current_partner_id(), app.engagement_preauth_stage(), app.engagement_account_id(),
  app.engagement_patient_ids(), app.engagement_patient_visible(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_partner_id(), app.engagement_preauth_stage(), app.engagement_account_id(),
  app.engagement_patient_ids(), app.engagement_patient_visible(uuid, timestamptz) TO lims_app;   -- §4.3 inventory (C16 §6.1: EXECUTE lims_app)

-- RFC 9562 UUIDv7 for trigger-side ids only (04 D9). App code uses @lims/shared-ts/uuidv7.
CREATE FUNCTION app.uuidv7() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT encode(
           set_bit(set_bit(
             overlay(uuid_send(gen_random_uuid())
                     PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                     FROM 1 FOR 6),
           52, 1), 53, 1),
         'hex')::uuid
$$;
-- golden test: output matches IC §2.1 Uuidv7 regex; timestamp prefix within ±5 ms of clock_timestamp()

-- ===================================================================== core tables
CREATE TABLE core.tenants (
  id            uuid        NOT NULL,
  tenant_code   text        NOT NULL,
  legal_name    text        NOT NULL,
  display_name  text        NOT NULL,
  status        text        NOT NULL DEFAULT 'provisioning',
  timezone      text        NOT NULL DEFAULT 'Asia/Kathmandu',
  status_reason text,                                                 -- 08 A3.4
  activated_at  timestamptz,                                          -- 08 A3.4 (lifecycle timestamps, set by C2)
  suspended_at  timestamptz,
  offboarded_at timestamptz,                                          -- 08 A3.4 (C2's former terminated_at)
  billing_live_on date,                                               -- 08 A3.4
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT tenants__pk PRIMARY KEY (id),
  CONSTRAINT tenants__tenant_code__ck CHECK (tenant_code ~ '^[a-z][a-z0-9_]{2,31}$'),
  CONSTRAINT tenants__names__ck CHECK (char_length(legal_name) BETWEEN 1 AND 200 AND char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT tenants__status__ck CHECK (status IN ('provisioning','active','suspended','offboarded')),
  CONSTRAINT tenants__timezone__ck CHECK (char_length(timezone) BETWEEN 1 AND 64),
  CONSTRAINT tenants__status_reason__ck CHECK (coalesce(char_length(status_reason),0) <= 500)   -- 08 A3.4
);
CREATE UNIQUE INDEX tenants__tenant_code__uq ON core.tenants (tenant_code);

CREATE TABLE core.branches (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  branch_code text NOT NULL, name text NOT NULL, address_text text, phone_display text,
  is_processing_lab boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT branches__pk PRIMARY KEY (id),
  CONSTRAINT branches__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT branches__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT branches__branch_code__ck CHECK (branch_code ~ '^[A-Za-z0-9-]{1,16}$'),
  CONSTRAINT branches__text__ck CHECK (char_length(name) BETWEEN 1 AND 120 AND coalesce(char_length(address_text),0) <= 500
                                      AND coalesce(char_length(phone_display),0) <= 40)
);
CREATE UNIQUE INDEX branches__tenant_id_branch_code__uq ON core.branches (tenant_id, branch_code);
CREATE INDEX branches__tenant_id_is_active__idx ON core.branches (tenant_id, is_active);

CREATE TABLE core.collection_centres (
  id uuid NOT NULL, tenant_id uuid NOT NULL, branch_id uuid NOT NULL,
  centre_code text NOT NULL, name text NOT NULL, centre_kind text NOT NULL,
  address_text text, phone_display text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT collection_centres__pk PRIMARY KEY (id),
  CONSTRAINT collection_centres__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT collection_centres__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT collection_centres__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT collection_centres__centre_code__ck CHECK (centre_code ~ '^[A-Za-z0-9-]{1,16}$'),
  CONSTRAINT collection_centres__kind__ck CHECK (centre_kind IN ('own','franchise','home_collection')),
  CONSTRAINT collection_centres__text__ck CHECK (char_length(name) BETWEEN 1 AND 120 AND coalesce(char_length(address_text),0) <= 500
                                                AND coalesce(char_length(phone_display),0) <= 40)
);
CREATE UNIQUE INDEX collection_centres__tenant_id_centre_code__uq ON core.collection_centres (tenant_id, centre_code);
CREATE INDEX collection_centres__tenant_id_branch_id__idx ON core.collection_centres (tenant_id, branch_id, is_active);

CREATE TABLE core.users (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  display_name text NOT NULL, staff_code text,
  email_normalized text, phone_e164 text, last_login_at timestamptz,          -- 08 A3.4
  email_hmac bytea,                                                           -- 08 A25 D-217 (written by C2)
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT users__pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT users__email_hmac__ck CHECK (octet_length(email_hmac) = 32),                           -- 08 A25 D-217 (NULL passes)
  CONSTRAINT users__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT users__text__ck CHECK (char_length(display_name) BETWEEN 1 AND 120 AND coalesce(char_length(staff_code),0) <= 32),
  CONSTRAINT users__email_normalized__ck CHECK (coalesce(char_length(email_normalized),0) <= 254),   -- 08 A3.4
  CONSTRAINT users__phone_e164__ck CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$')                       -- 08 A3.4 (NULL passes)
);
CREATE UNIQUE INDEX users__tenant_id_email_normalized__uq ON core.users (tenant_id, email_normalized);   -- 08 A3.4

CREATE TABLE core.memberships (
  id uuid NOT NULL, tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  actor_type text NOT NULL, all_centres boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',                                       -- 08 A3.4: the writable lifecycle column
  invited_at timestamptz, accepted_at timestamptz,                             -- 08 A3.4
  deactivated_at timestamptz, deactivated_by uuid, deactivation_reason_code text,   -- 08 A3.4
  locked_at timestamptz, locked_by uuid, lock_reason_code text,                -- locked = locked_at IS NOT NULL (no is_locked column, 08 A3.4)
  lock_reason_text text,                                                       -- 08 A3.4
  last_login_at timestamptz,                                                   -- 08 A3.4
  signatory_display_title text, signatory_registration_no text, signature_image_ref text,
  partner_role text,                                                           -- 08 A28.3 (read by C2)
  version integer NOT NULL DEFAULT 1,
  is_active boolean GENERATED ALWAYS AS (status = 'active') STORED,            -- 08 A3.4: generated on this table only; writers set status, never is_active
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT memberships__pk PRIMARY KEY (id),
  CONSTRAINT memberships__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT memberships__user__fk FOREIGN KEY (tenant_id, user_id) REFERENCES core.users (tenant_id, id),
  CONSTRAINT memberships__actor_type__ck CHECK (actor_type IN ('user','patient','partner')),
  CONSTRAINT memberships__all_centres_user_only__ck CHECK (actor_type = 'user' OR NOT all_centres),   -- 08 R3
  CONSTRAINT memberships__lock__ck CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
  CONSTRAINT memberships__partner_role_presence__ck CHECK ((actor_type = 'partner') = (partner_role IS NOT NULL)),   -- 08 A28.3
  CONSTRAINT memberships__partner_role__ck CHECK (partner_role IN ('partner_admin','partner_member')),            -- 08 A28.3 (NULL passes)
  CONSTRAINT memberships__status__ck CHECK (status IN ('invited','active','deactivated')),            -- 08 A3.4
  CONSTRAINT memberships__lock_reason__ck CHECK (lock_reason_code IN
     ('left_organisation','security_concern','policy_violation','other')),                           -- 08 A3.4 (NULL passes)
  CONSTRAINT memberships__deactivation_reason__ck CHECK (deactivation_reason_code IN
     ('left_organisation','security_concern','policy_violation','other')),                           -- 08 A6.3 (same set as lock_reason_code; NULL passes)
  CONSTRAINT memberships__text__ck CHECK (coalesce(char_length(lock_reason_code),0) <= 64
     AND coalesce(char_length(lock_reason_text),0) <= 500                                            -- 08 A3.4
     AND coalesce(char_length(signatory_display_title),0) <= 200 AND coalesce(char_length(signatory_registration_no),0) <= 40
     AND coalesce(char_length(signature_image_ref),0) <= 512)
);
CREATE UNIQUE INDEX memberships__tenant_id_user_id_actor_type__p_uq ON core.memberships (tenant_id, user_id, actor_type)
  WHERE status IN ('invited','active');                                                              -- 08 A3.4: pending invite blocks a duplicate
CREATE UNIQUE INDEX memberships__user_id__p_uq ON core.memberships (user_id)
  WHERE actor_type = 'user' AND status IN ('invited','active');   -- EXCEPTION (index-exceptions.yaml): one tenant per staff user (08 R27; predicate 08 A3.4)

CREATE TABLE core.membership_centres (
  tenant_id uuid NOT NULL, membership_id uuid NOT NULL, centre_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT membership_centres__pk PRIMARY KEY (tenant_id, membership_id, centre_id),
  CONSTRAINT membership_centres__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT membership_centres__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id)
);

CREATE TABLE core.membership_branches (                                -- CR-C2-003; 08 R3 (explicit branch scope, application-level only)
  tenant_id uuid NOT NULL, membership_id uuid NOT NULL, branch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT membership_branches__pk PRIMARY KEY (tenant_id, membership_id, branch_id),
  CONSTRAINT membership_branches__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT membership_branches__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id)
);

CREATE FUNCTION app.tg_scope_user_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.memberships m
                 WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.membership_id AND m.actor_type = 'user') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'scope_user_only', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;   -- 08 R3: centre/branch scope rows only for staff memberships
CREATE TRIGGER membership_centres__scope_user_only BEFORE INSERT ON core.membership_centres
  FOR EACH ROW EXECUTE FUNCTION app.tg_scope_user_only();
CREATE TRIGGER membership_branches__scope_user_only BEFORE INSERT ON core.membership_branches
  FOR EACH ROW EXECUTE FUNCTION app.tg_scope_user_only();

CREATE TABLE core.g_permissions (
  code text NOT NULL, module text NOT NULL, privileged boolean NOT NULL, phase text NOT NULL,
  description text, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_permissions__pk PRIMARY KEY (code),
  CONSTRAINT g_permissions__code__ck CHECK (code ~ '^[a-z_]+\.[a-z_]+\.[a-z_]+$'),
  CONSTRAINT g_permissions__phase__ck CHECK (phase IN ('1','1.5','2','3'))
);

CREATE TABLE core.roles (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  role_code text NOT NULL, display_name text NOT NULL, description text,
  is_system_default boolean NOT NULL DEFAULT false, mfa_required boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT roles__pk PRIMARY KEY (id),
  CONSTRAINT roles__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT roles__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT roles__role_code__ck CHECK (role_code ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT roles__text__ck CHECK (char_length(display_name) BETWEEN 1 AND 80 AND coalesce(char_length(description),0) <= 300)
);
CREATE UNIQUE INDEX roles__tenant_id_role_code__uq ON core.roles (tenant_id, role_code);

CREATE TABLE core.role_permissions (
  tenant_id uuid NOT NULL, role_id uuid NOT NULL, permission_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT role_permissions__pk PRIMARY KEY (tenant_id, role_id, permission_code),
  CONSTRAINT role_permissions__role__fk FOREIGN KEY (tenant_id, role_id) REFERENCES core.roles (tenant_id, id),
  CONSTRAINT role_permissions__permission__fk FOREIGN KEY (permission_code) REFERENCES core.g_permissions (code),
  CONSTRAINT role_permissions__no_platform__ck CHECK (permission_code NOT LIKE 'platform.%')
);
CREATE INDEX role_permissions__tenant_id_permission_code__idx ON core.role_permissions (tenant_id, permission_code);   -- 08 A3.4

CREATE TABLE core.membership_roles (
  tenant_id uuid NOT NULL, membership_id uuid NOT NULL, role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT membership_roles__pk PRIMARY KEY (tenant_id, membership_id, role_id),
  CONSTRAINT membership_roles__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT membership_roles__role__fk FOREIGN KEY (tenant_id, role_id) REFERENCES core.roles (tenant_id, id)
);
CREATE INDEX membership_roles__tenant_id_role_id__idx ON core.membership_roles (tenant_id, role_id);                    -- 08 A3.4

CREATE TABLE core.g_system_actors (
  module text NOT NULL, actor_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_system_actors__pk PRIMARY KEY (module),
  CONSTRAINT g_system_actors__actor_id__uq UNIQUE (actor_id)
);

CREATE TABLE core.g_task_registry (
  identifier text NOT NULL, module text NOT NULL, kind text NOT NULL, scope text NOT NULL,
  max_attempts integer NOT NULL, is_active boolean NOT NULL DEFAULT true,
  registered_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_task_registry__pk PRIMARY KEY (identifier),
  CONSTRAINT g_task_registry__identifier__ck CHECK (identifier ~ '^(core|evt|[a-z_]+)\.[a-z0-9_.]+$' AND char_length(identifier) <= 200),
  CONSTRAINT g_task_registry__kind__ck CHECK (kind IN ('task','consumer','core')),
  CONSTRAINT g_task_registry__scope__ck CHECK (scope IN ('per_tenant','platform')),
  CONSTRAINT g_task_registry__attempts__ck CHECK (max_attempts BETWEEN 1 AND 100)
);

-- ===================================================================== platform tables (IC §12)
CREATE TABLE core.event_log (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL, producer text NOT NULL,
  idempotency_key text NOT NULL, aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, aggregate_seq integer NOT NULL,
  occurred_at timestamptz NOT NULL, envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_log__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_log__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT event_log__idem__ck CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT event_log__seq__ck CHECK (aggregate_seq >= 1)
);
CREATE UNIQUE INDEX event_log__tenant_id_event_type_idempotency_key__uq ON core.event_log (tenant_id, event_type, idempotency_key);
CREATE INDEX event_log__tenant_id_aggregate__idx ON core.event_log (tenant_id, aggregate_type, aggregate_id, aggregate_seq);
CREATE INDEX event_log__created_at__brin ON core.event_log USING brin (created_at);            -- EXCEPTION: retention

CREATE TABLE core.dead_letters (
  id uuid NOT NULL, tenant_id uuid,                                  -- NULL only for platform tasks (IC §12)
  task_identifier text NOT NULL, job_payload jsonb NOT NULL,
  last_error_code text NOT NULL, last_error_message_redacted text NOT NULL, attempts integer NOT NULL,
  first_failed_at timestamptz NOT NULL, dead_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open', resolved_by uuid, resolved_at timestamptz,
  resolution_note text,                                              -- 08 A8.4: discard reason / optional replay note
  job_key text,                                                      -- 08 A23.2: the failed job's job_key (helpers.job.key), copied at dead-lettering
  version integer NOT NULL DEFAULT 1,                                -- 08 A3.4: If-Match on replay/discard
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT dead_letters__pk PRIMARY KEY (id),
  CONSTRAINT dead_letters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT dead_letters__state__ck CHECK (state IN ('open','replayed','discarded')),
  CONSTRAINT dead_letters__resolved__ck CHECK ((state = 'open') = (resolved_at IS NULL) AND (resolved_at IS NULL) = (resolved_by IS NULL)),
  CONSTRAINT dead_letters__msg__ck CHECK (char_length(last_error_message_redacted) <= 2000),
  CONSTRAINT dead_letters__resolution_note__ck CHECK (char_length(resolution_note) BETWEEN 1 AND 500),  -- 08 A8.4
  CONSTRAINT dead_letters__job_key__ck CHECK (char_length(job_key) BETWEEN 1 AND 400)                 -- [CONV] (08 A23.2)
);
CREATE INDEX dead_letters__state_dead_at__idx ON core.dead_letters (state, dead_at);                  -- IC §12
CREATE INDEX dead_letters__tenant_id_state_dead_at__idx ON core.dead_letters (tenant_id, state, dead_at);

CREATE TABLE core.idempotency_keys (
  tenant_id uuid,                                                    -- NULL only for platform-context operations (08 A25 D-213)
  actor_id uuid NOT NULL, key text NOT NULL,
  method text NOT NULL, route text NOT NULL, request_sha256 bytea NOT NULL,
  state text NOT NULL, response_status integer, response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys__tenant_id_actor_id_key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, actor_id, key),   -- replaces the PK (D-213)
  CONSTRAINT idempotency_keys__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT idempotency_keys__key__ck CHECK (key ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT idempotency_keys__sha__ck CHECK (octet_length(request_sha256) = 32),   -- 02-CV §3 hash-column rule (08 R24)
  CONSTRAINT idempotency_keys__state__ck CHECK (state IN ('in_progress','completed')),
  CONSTRAINT idempotency_keys__completed__ck CHECK ((state = 'completed') = (response_status IS NOT NULL))
);
CREATE INDEX idempotency_keys__expires_at__idx ON core.idempotency_keys (expires_at);                -- IC §12

CREATE UNLOGGED TABLE core.rate_limit_counters (
  key_hash text NOT NULL, window_start timestamptz NOT NULL, hits integer NOT NULL DEFAULT 0,
  CONSTRAINT rate_limit_counters__pk PRIMARY KEY (key_hash, window_start)
);                                                                     -- RLS-exempt (rls_exempt.txt: "hashed non-tenant counters, no grants")

-- ===================================================================== audit
CREATE TABLE audit.g_cs_access_actions (
  code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT g_cs_access_actions__pk PRIMARY KEY (code),
  CONSTRAINT g_cs_access_actions__code__ck CHECK (code ~ '^[a-z_]+\.[a-z_]+$')
);

CREATE TABLE audit.audit_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  schema_name text NOT NULL, table_name text NOT NULL, row_id uuid, action text NOT NULL,
  changed_columns text[] NOT NULL DEFAULT '{}', old_values jsonb, new_values jsonb,
  actor_id uuid, actor_type text NOT NULL, membership_id uuid, support_session_id uuid,   -- actor_id NULL only for maintenance (08 A28.5)
  request_id uuid, client_ip inet, user_agent text,
  detail jsonb,                                                      -- 08 A28.5: {"maintenance": "<function name>"} [CONV column]
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,    -- = actor_id (NULL for maintenance rows)
  CONSTRAINT audit_log__pk PRIMARY KEY (tenant_id, occurred_at, id),
  CONSTRAINT audit_log__action__ck CHECK (action IN ('INSERT','UPDATE','DELETE')),
  CONSTRAINT audit_log__actor__ck CHECK ((actor_id IS NOT NULL AND created_by IS NOT NULL)
     OR (actor_id IS NULL AND created_by IS NULL AND actor_type = 'system' AND detail ? 'maintenance')),   -- 08 A28.5
  CONSTRAINT audit_log__ua__ck CHECK (coalesce(char_length(user_agent),0) <= 512)
);
CREATE INDEX audit_log__tenant_id_id__idx ON audit.audit_log (tenant_id, id);
CREATE INDEX audit_log__tenant_id_table_row__idx ON audit.audit_log (tenant_id, schema_name, table_name, row_id, occurred_at DESC);
CREATE INDEX audit_log__tenant_id_actor__idx ON audit.audit_log (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX audit_log__tenant_id_request_id__idx ON audit.audit_log (tenant_id, request_id);                        -- 08 A28.6 (C2 viewer)
CREATE INDEX audit_log__tenant_id_support_session__p_idx ON audit.audit_log (tenant_id, support_session_id, occurred_at DESC)
  WHERE support_session_id IS NOT NULL;                                                                            -- 08 A28.6

CREATE TABLE audit.access_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  actor_id uuid NOT NULL, actor_type text NOT NULL, membership_id uuid, support_session_id uuid,
  action text NOT NULL, entity_type text NOT NULL, entity_id uuid, purpose_code text,
  outcome text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
  request_id uuid, client_ip inet, user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT access_log__pk PRIMARY KEY (tenant_id, occurred_at, id),
  CONSTRAINT access_log__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT access_log__action__fk FOREIGN KEY (action) REFERENCES audit.g_cs_access_actions (code),
  CONSTRAINT access_log__outcome__ck CHECK (outcome IN ('allowed','denied')),
  CONSTRAINT access_log__text__ck CHECK (char_length(entity_type) BETWEEN 1 AND 40 AND coalesce(char_length(purpose_code),0) <= 64
                                         AND coalesce(char_length(user_agent),0) <= 512 AND octet_length(detail::text) <= 4096)
);
CREATE INDEX access_log__tenant_id_id__idx ON audit.access_log (tenant_id, id);
CREATE INDEX access_log__tenant_id_entity__idx ON audit.access_log (tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX access_log__tenant_id_actor__idx ON audit.access_log (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX access_log__tenant_id_action__idx ON audit.access_log (tenant_id, action, occurred_at DESC);
CREATE INDEX access_log__tenant_id_request_id__idx ON audit.access_log (tenant_id, request_id);                      -- 08 A28.6
CREATE INDEX access_log__tenant_id_support_session__p_idx ON audit.access_log (tenant_id, support_session_id, occurred_at DESC)
  WHERE support_session_id IS NOT NULL;                                                                            -- 08 A28.6

-- ===================================================================== event_inbox (template; one migration per schema in §3.9; C0 only, 08 A30.2)
-- Generated by db/tools/gen-inbox.ts for each <m> in §3.9; shown for lab:
CREATE TABLE lab.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON lab.event_inbox USING brin (received_at);     -- EXCEPTION: retention
-- (Index/constraint names are schema-local, so the same names are reused per schema.)

-- ===================================================================== DEFINER helpers (CV §5.8 verbatim, has_all_centres CASE per 02-CV §5.8 as amended by 08 R3)
CREATE FUNCTION app.has_all_centres() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE app.current_actor_type()
    WHEN 'system' THEN app.current_tenant_id() IS NOT NULL
    WHEN 'user'   THEN coalesce((SELECT m.all_centres FROM core.memberships m
                                 WHERE m.tenant_id = app.current_tenant_id()
                                   AND m.id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
                                   AND m.is_active), false)
    ELSE false                                                  -- device, portal, patient, partner (08 R3)
  END
$$;
CREATE FUNCTION app.current_centre_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE app.current_actor_type()
    WHEN 'device' THEN coalesce(ARRAY[nullif(app.current_claims() ->> 'centre_id', '')::uuid], '{}')
    ELSE coalesce((SELECT array_agg(mc.centre_id)
                   FROM core.memberships m
                   JOIN core.membership_centres mc ON mc.tenant_id = m.tenant_id AND mc.membership_id = m.id
                   WHERE m.tenant_id = app.current_tenant_id()
                     AND m.id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
                     AND m.is_active), '{}')
  END
$$;

-- ===================================================================== triggers
CREATE FUNCTION app.enforce_mutable_columns() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- mutable-column list = trigger arguments; coalesce: with no arguments TG_ARGV is NULL and jsonb - NULL is NULL, which would make
  -- every change look "equal" (NULL IS DISTINCT FROM NULL = false) and allow everything (08 A20.3, same bug as A15.5)
  IF (to_jsonb(OLD) - coalesce(TG_ARGV::text[], '{}')) IS DISTINCT FROM (to_jsonb(NEW) - coalesce(TG_ARGV::text[], '{}')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.tg_row_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_claims jsonb := app.current_claims();
  -- excluded columns (CR-C15-013). TG_ARGV is NULL when the trigger has no arguments; without coalesce, jsonb - NULL and
  -- key <> ALL (NULL) are NULL, so INSERT/DELETE rows lost their values and every UPDATE looked like a no-op (08 A15.5).
  v_excl text[] := coalesce(TG_ARGV::text[], '{}');
  v_row jsonb; v_old jsonb; v_new jsonb; v_changed text[] := '{}';
  v_maint text := nullif(current_setting('app.maintenance', true), '');   -- 08 A28.5
  v_sub uuid := nullif(app.current_claims() ->> 'sub', '')::uuid;
BEGIN
  -- 08 A25 D-215: a NULL-tenant row of a mixed table (anything but core.tenants, which has no tenant_id column) is not written to
  -- audit_log (tenant_id NOT NULL there); C2 records those changes in identity.platform_events. Checked first: never raises here.
  IF NOT (TG_TABLE_SCHEMA = 'core' AND TG_TABLE_NAME = 'tenants')
     AND nullif((CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END) ->> 'tenant_id', '') IS NULL THEN
    RETURN NULL;
  END IF;
  -- 08 A28.5: inside a maintenance DEFINER (no claims, app.maintenance set) the row is audited as actor_type 'system', actor_id NULL,
  -- detail.maintenance = <function name>; audit_context_missing only when neither claims sub nor app.maintenance is present.
  IF v_sub IS NULL AND v_maint IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'audit_context_missing', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_row := to_jsonb(NEW); v_new := v_row - v_excl;                  -- INSERT records the new row
  ELSIF TG_OP = 'DELETE' THEN
    v_row := to_jsonb(OLD); v_old := v_row - v_excl;                  -- DELETE records the old row
  ELSE                                                               -- UPDATE records the changed columns
    v_row := to_jsonb(NEW);
    SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}'),
           jsonb_object_agg(n.key, o.value), jsonb_object_agg(n.key, n.value)
      INTO v_changed, v_old, v_new
      FROM jsonb_each(to_jsonb(NEW)) n
      JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value
       AND n.key NOT IN ('updated_at','updated_by','version')
       AND n.key <> ALL (v_excl);                                      -- excluded columns (CR-C15-013; 08 A15.5)
    IF cardinality(v_changed) = 0 THEN RETURN NULL; END IF;          -- no-op update: nothing to audit
  END IF;
  INSERT INTO audit.audit_log (id, tenant_id, centre_id, schema_name, table_name, row_id, action, changed_columns,
                               old_values, new_values, actor_id, actor_type, membership_id, support_session_id,
                               request_id, client_ip, user_agent, detail, occurred_at, created_at, created_by)
  VALUES (app.uuidv7(),
          -- core.tenants has no tenant_id column: its own id, also when no tenant claim is present (platform context, 08 A12.5)
          coalesce(v_row ->> 'tenant_id', CASE WHEN TG_TABLE_SCHEMA = 'core' AND TG_TABLE_NAME = 'tenants' THEN v_row ->> 'id' END)::uuid,
          nullif(v_row ->> 'centre_id', '')::uuid,
          TG_TABLE_SCHEMA, TG_TABLE_NAME, nullif(v_row ->> 'id', '')::uuid, TG_OP, v_changed, v_old, v_new,
          v_sub, CASE WHEN v_sub IS NULL THEN 'system' ELSE coalesce(v_claims ->> 'actor_type', 'user') END,
          nullif(v_claims ->> 'membership_id', '')::uuid, nullif(v_claims ->> 'support_session_id', '')::uuid,
          nullif(current_setting('app.request_id', true), '')::uuid,
          nullif(current_setting('app.client_ip', true), '')::inet,
          left(nullif(current_setting('app.user_agent', true), ''), 512),
          CASE WHEN v_sub IS NULL THEN jsonb_build_object('maintenance', v_maint) END,   -- 08 A28.5
          now(), now(), v_sub);
  RETURN NULL;                                                       -- AFTER trigger
END $$;

CREATE FUNCTION app.tg_dead_letter_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(OLD) - ARRAY['state','resolved_by','resolved_at','resolution_note','version'])
     IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state','resolved_by','resolved_at','resolution_note','version'])   -- version: 08 A3.4 If-Match bump; resolution_note: 08 A8.4
     OR NOT (OLD.state = 'open' AND NEW.state IN ('replayed','discarded')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'core.dead_letters';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dead_letters__transition BEFORE UPDATE ON core.dead_letters
  FOR EACH ROW EXECUTE FUNCTION app.tg_dead_letter_transition();

-- audited core tables (class M): tenants, branches, collection_centres, users, memberships, membership_centres, roles, role_permissions, membership_roles
-- NOT attached to identity.platform_staff, identity.platform_events or any other platform-only table (08 A12.5): audit_log.tenant_id
-- is NOT NULL; their changes go to identity.platform_events (C2). db/meta/tables.yaml marks them audited: false.
CREATE TRIGGER tenants__audit AFTER INSERT OR UPDATE OR DELETE ON core.tenants FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
-- … same statement for each table listed above (generated) …

-- ===================================================================== queue wrapper (owner lims_queue; IC §12; SP-2 confirms add_job mapping for 0.18.0)
-- 08 A25 D-201: this migration file is the only window in which lims_queue holds CREATE. As lims_owner (CREATE on the database
-- WITH GRANT OPTION from 01_database.sql; owner of schema app): grant → SET ROLE lims_queue → create → back to lims_owner → revoke.
-- The migration runner installs the graphile_worker schema (owned by lims_queue) inside the same window (SP-2 records the exact
-- 0.18.0 install command). If SP-2 shows the worker must migrate its own schema at start, that residual privilege is recorded in
-- services/worker/src/core/DECISIONS.md and 07-SECURITY §6, not kept silently.
DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO lims_queue', current_database()); END $$;
GRANT CREATE ON SCHEMA app TO lims_queue;
SET LOCAL ROLE lims_queue;   -- this migration file switches to lims_queue for these objects only
-- (graphile_worker schema installation by the runner happens here — SP-2)
CREATE FUNCTION app.enqueue_job(identifier text, payload jsonb, job_key text DEFAULT NULL,
                                run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reg record;
BEGIN
  SELECT r.scope, r.max_attempts INTO v_reg FROM core.g_task_registry r
   WHERE r.identifier = enqueue_job.identifier AND r.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'unknown_task_identifier';
  END IF;
  -- per_tenant identifiers need matching tenant claims. Cron ticks (08 A23.1) and tenant-row dead-letter replays (08 A23.2) get
  -- them from the worker/API core's withTenantScope(tenantId, <module system actor>); nothing relaxes this check.
  IF v_reg.scope = 'per_tenant' AND (app.current_tenant_id() IS NULL
       OR nullif(enqueue_job.payload ->> 'tenant_id', '')::uuid IS DISTINCT FROM app.current_tenant_id()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'job_tenant_mismatch';
  END IF;
  PERFORM graphile_worker.add_job(
            identifier   => enqueue_job.identifier,
            payload      => enqueue_job.payload::json,
            run_at       => coalesce(enqueue_job.run_at, now()),
            max_attempts => coalesce(enqueue_job.max_attempts, v_reg.max_attempts)::smallint,
            job_key      => enqueue_job.job_key,
            job_key_mode => 'unsafe_dedupe');
END $$;
-- Queue depth for lims_queue_depth{task} (review C0 m#37): counts only — never payloads, keys or errors. Column names of the
-- graphile_worker.jobs view (task_identifier, run_at, locked_at, attempts, max_attempts) are UNVERIFIED for 0.18.0; SP-2 confirms
-- them (or this body is adjusted in the SP-2 PR) before T0B-05 merges.
CREATE FUNCTION app.queue_depth() RETURNS TABLE (task_identifier text, ready bigint, locked bigint, failed bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT j.task_identifier,
         count(*) FILTER (WHERE j.locked_at IS NULL AND j.attempts < j.max_attempts AND j.run_at <= now()),
         count(*) FILTER (WHERE j.locked_at IS NOT NULL),
         count(*) FILTER (WHERE j.attempts >= j.max_attempts)
  FROM graphile_worker.jobs j
  GROUP BY j.task_identifier
$$;
REVOKE ALL ON FUNCTION app.enqueue_job(text, jsonb, text, timestamptz, int), app.queue_depth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_job(text, jsonb, text, timestamptz, int) TO lims_app;
GRANT EXECUTE ON FUNCTION app.queue_depth() TO lims_worker;
RESET ROLE;  SET LOCAL ROLE lims_owner;
REVOKE CREATE ON SCHEMA app FROM lims_queue;                                                      -- D-201: close the window
DO $$ BEGIN EXECUTE format('REVOKE CREATE ON DATABASE %I FROM lims_queue', current_database()); END $$;

-- (no GoTrue auth hook, no membership fallback lookup — 08 R10; identity DEFINERs are specified in C2 05-SCHEMA §10.3)

-- ===================================================================== rate limit fallback (04 S11)
CREATE FUNCTION app.ratelimit_hit(p_key_hash text, p_window_seconds int, p_limit int,
                                  OUT allowed boolean, OUT retry_after_seconds int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now  timestamptz := clock_timestamp();
  v_cur  timestamptz := to_timestamp(floor(extract(epoch FROM v_now) / p_window_seconds) * p_window_seconds);
  v_prev timestamptz := v_cur - make_interval(secs => p_window_seconds);
  v_elapsed double precision := extract(epoch FROM v_now - v_cur);
  v_cur_hits int; v_prev_hits int; v_estimate double precision;
BEGIN
  INSERT INTO core.rate_limit_counters AS c (key_hash, window_start, hits) VALUES (p_key_hash, v_cur, 1)
  ON CONFLICT (key_hash, window_start) DO UPDATE SET hits = c.hits + 1 RETURNING c.hits INTO v_cur_hits;
  SELECT coalesce(max(hits), 0) INTO v_prev_hits FROM core.rate_limit_counters
   WHERE key_hash = p_key_hash AND window_start = v_prev;
  v_estimate := v_prev_hits * (1 - v_elapsed / p_window_seconds) + v_cur_hits;   -- sliding-window approximation (REQ-SEC-079)
  allowed := v_estimate <= p_limit;
  retry_after_seconds := CASE WHEN allowed THEN 0 ELSE greatest(1, ceil(p_window_seconds - v_elapsed)::int) END;
END $$;
GRANT EXECUTE ON FUNCTION app.ratelimit_hit(text, int, int) TO lims_api, lims_worker;

-- ===================================================================== retention purges (CV §5.11) — batched
-- Cross-tenant maintenance (08 A12.2, A15.3; §4.3 GUC rule): each purge that touches a FORCE-RLS table sets
-- set_config('app.maintenance', '<function name>', true) first and resets it to '' before returning; its owner policies are
-- gated on that value, so they admit nothing outside the function (a lims_app session setting the GUC gains nothing: TO lims_owner).
-- 08 A25 D-200: core.retention_purge calls each function in its own transaction with statement_timeout = 300000 (taskOptions,
-- 02-TRD §7.6); each loop stops after 4 minutes (under the 300 s ceiling) and reports capped = true, so the metric
-- lims_core_retention_purge_capped_total{table} counts it and the next daily run continues where this one stopped.
-- OUT (deleted, capped) [CONV: the capped flag is what the D-200 metric needs]. Batches of 10,000 rows [CONV].
CREATE FUNCTION app.purge_event_log(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  deleted := 0; capped := false;
  PERFORM set_config('app.maintenance', 'purge_event_log', true);   -- admits event_log__{select,delete}__owner_only (08 A15.3)
  LOOP
    DELETE FROM core.event_log e WHERE (e.tenant_id, e.event_id) IN (
      SELECT x.tenant_id, x.event_id FROM core.event_log x WHERE x.created_at < now() - interval '90 days' LIMIT 10000);
    GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
    EXIT WHEN v_n = 0;
    IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;   -- D-200
  END LOOP;
  PERFORM set_config('app.maintenance', '', true);
END $$;
CREATE FUNCTION app.purge_event_inboxes(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s text; v_n int;
BEGIN
  deleted := 0; capped := false;
  PERFORM set_config('app.maintenance', 'purge_event_inboxes', true);   -- admits event_inbox__{select,delete}__owner_only
  FOREACH v_s IN ARRAY ARRAY['identity','frontdesk','billing','lab','instruments','reporting','analytics','quality',
                             'micro','anatomic','inventory','partners','smartreport','payments','engagement','homecollection'] LOOP   -- §3.9 (08 A31.4)
    LOOP
      EXECUTE format('DELETE FROM %I.event_inbox e WHERE (e.tenant_id, e.event_id) IN ('
                  || 'SELECT x.tenant_id, x.event_id FROM %I.event_inbox x WHERE x.received_at < now() - interval ''90 days'' LIMIT 10000)',
                     v_s, v_s);                                      -- fixed list + %I (REQ-SEC-082)
      GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
      EXIT WHEN v_n = 0;
      IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;
    END LOOP;
    EXIT WHEN capped;
  END LOOP;
  PERFORM set_config('app.maintenance', '', true);
END $$;
-- core.idempotency_keys has NULL-tenant rows (D-213): a row-value IN over (tenant_id, …) never matches NULL, so the batch is
-- addressed by ctid within the same statement.
CREATE FUNCTION app.purge_idempotency_keys(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  deleted := 0; capped := false;
  PERFORM set_config('app.maintenance', 'purge_idempotency_keys', true);
  LOOP
    DELETE FROM core.idempotency_keys k WHERE k.ctid = ANY (ARRAY(
      SELECT x.ctid FROM core.idempotency_keys x WHERE x.expires_at < now() LIMIT 10000));
    GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
    EXIT WHEN v_n = 0;
    IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;
  END LOOP;
  PERFORM set_config('app.maintenance', '', true);
END $$;
CREATE FUNCTION app.purge_dead_letters(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  deleted := 0; capped := false;
  PERFORM set_config('app.maintenance', 'purge_dead_letters', true);
  LOOP
    DELETE FROM core.dead_letters d WHERE d.id IN (
      SELECT x.id FROM core.dead_letters x
       WHERE x.state <> 'open' AND x.resolved_at < now() - interval '90 days' LIMIT 10000);
    GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
    EXIT WHEN v_n = 0;
    IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;
  END LOOP;
  PERFORM set_config('app.maintenance', '', true);
END $$;
-- core.rate_limit_counters is RLS-exempt (§3.5): no owner policy, no app.maintenance.
CREATE FUNCTION app.purge_ratelimit_counters(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  deleted := 0; capped := false;
  LOOP
    DELETE FROM core.rate_limit_counters c WHERE (c.key_hash, c.window_start) IN (
      SELECT x.key_hash, x.window_start FROM core.rate_limit_counters x
       WHERE x.window_start < now() - interval '48 hours' LIMIT 10000);
    GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
    EXIT WHEN v_n = 0;
    IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.purge_event_log(), app.purge_event_inboxes(), app.purge_idempotency_keys(), app.purge_dead_letters(),
  app.purge_ratelimit_counters() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_event_log(), app.purge_event_inboxes(), app.purge_idempotency_keys(), app.purge_dead_letters(),
  app.purge_ratelimit_counters() TO lims_worker;
-- Owner policies the purges need under FORCE RLS (08 A10.5; §4.3 owner-policy rule): a DELETE … WHERE (and the batching
-- subquery) reads the row, so lims_owner needs a SELECT policy with the same expiry predicate as the DELETE policy (§6).
-- Both are gated on app.maintenance = the purge's name (08 A15.3): no static owner policy for maintenance remains.
CREATE POLICY event_log__select__owner_only ON core.event_log FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_log' AND created_at < now() - interval '90 days');
CREATE POLICY event_log__delete__owner_only ON core.event_log FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_log' AND created_at < now() - interval '90 days');
-- per schema of §3.9 (generated with the inbox, shown for lab):
CREATE POLICY event_inbox__select__owner_only ON lab.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON lab.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
-- core.idempotency_keys: idempotency_keys__{select,delete}__owner_only (gated on 'purge_idempotency_keys') are with the table's policies below.
-- (The other 16 inbox schemas of §3.9 get the same two policies, generated with their inbox.)
-- core.dead_letters: the purge predicate (gated on 'purge_dead_letters') is part of dead_letters__select__owner_only /
-- __delete__owner_only (platform dead letters block).

-- ===================================================================== platform dead letters (tenant_id IS NULL; IC §12; §4.3; 08 A9.4)
-- Owner lims_owner (file role). FORCE RLS applies to the owner, so these functions see only rows admitted by the
-- owner_only policies below (§6: tenant_id IS NULL). app.dl_list_platform never returns job_payload (08 A8.5, A9.4);
-- app.dl_resolve returns it for a replay to the C0 core service only, which strips it before building DeadLetterRow (08 A10.1).
-- The tenant-row path (ctx.core.deadLetters under platform claims, __platform policies) applies the same guard and transition.
-- (ENABLE + FORCE RLS on core.dead_letters comes from the RLS template below, as for every C0 table.)
-- SELECT owner_only also admits the purge predicate of app.purge_dead_letters(): its DELETE … WHERE reads the row, which
-- under FORCE RLS needs a SELECT policy for lims_owner (08 A10.5; §4.3 owner-policy rule). One SELECT owner_only policy per table.
CREATE POLICY dead_letters__select__owner_only ON core.dead_letters FOR SELECT TO lims_owner
  USING (tenant_id IS NULL                                                                  -- app.dl_* (platform rows)
      OR (current_setting('app.maintenance', true) = 'purge_dead_letters'                   -- app.purge_dead_letters() (08 A15.3)
          AND state <> 'open' AND resolved_at < now() - interval '90 days'));
CREATE POLICY dead_letters__delete__owner_only ON core.dead_letters FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_dead_letters'
         AND state <> 'open' AND resolved_at < now() - interval '90 days');                 -- app.purge_dead_letters() (§6; 08 A15.3)
CREATE POLICY dead_letters__insert__owner_only ON core.dead_letters FOR INSERT TO lims_owner WITH CHECK (tenant_id IS NULL);
CREATE POLICY dead_letters__update__owner_only ON core.dead_letters FOR UPDATE TO lims_owner
  USING (tenant_id IS NULL) WITH CHECK (tenant_id IS NULL);
-- __platform policies (C2 05-SCHEMA §5.3, §10.2; written here by C0, used by ctx.core.deadLetters under platform claims, 08 A8.6).
-- Tenant rows only: NULL-tenant rows are reachable only through the app.dl_* DEFINERs (08 A10.4).
CREATE POLICY dead_letters__select__platform ON core.dead_letters FOR SELECT TO lims_app
  USING (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY dead_letters__update__platform ON core.dead_letters FOR UPDATE TO lims_app
  USING (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()));

-- Worker dead-letter wrapper, tenantScope 'platform' tasks only (02-TRD §7.4). Id = UUIDv7 from app code (04 D9).
CREATE FUNCTION app.dl_insert_platform(p_id uuid, p_task_identifier text, p_job_payload jsonb,
                                       p_last_error_code text, p_last_error_message_redacted text,
                                       p_attempts integer, p_first_failed_at timestamptz,
                                       p_job_key text DEFAULT NULL)       -- 08 A23.2: helpers.job.key of the failed job
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_scope text;
BEGIN
  SELECT r.scope INTO v_scope FROM core.g_task_registry r WHERE r.identifier = p_task_identifier;   -- registry rows are never deleted (02-TRD §7.7)
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'unknown_task_identifier';
  END IF;
  IF v_scope <> 'platform' THEN                                  -- tenant_id is NULL only for platform tasks (IC §12)
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'job_tenant_mismatch';
  END IF;
  INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted,
                                 attempts, first_failed_at, dead_at, state, job_key, created_by)
  VALUES (p_id, NULL, p_task_identifier, p_job_payload, p_last_error_code, p_last_error_message_redacted,
          p_attempts, p_first_failed_at, now(), 'open', p_job_key, app.current_actor_id());   -- created_by = core system actor claims (NOT NULL)
END $$;

-- ctx.core.deadLetters.list({ platformRows: true, state?, taskIdentifier?, deadAtFrom?, deadAtTo?, cursor?, limit? }) (08 A9.2)
-- and ctx.core.deadLetters.get({ deadLetterId }) for a platform row (p_dead_letter_id; 0 rows → common.not_found, 08 A9.1).
-- Keyset: core decodes the cursor (02-CV §4.3) into (p_after_dead_at, p_after_id) and passes p_limit = limit + 1 to detect next_cursor.
-- Order dead_at DESC, id DESC [CONV]; served by dead_letters__state_dead_at__idx; task_identifier filtered in-page [CONV] (08 A9.2).
-- Confirmed by 08 A10.3: get via the optional p_dead_letter_id, sort dead_at DESC, id DESC [CONV].
CREATE FUNCTION app.dl_list_platform(p_state text DEFAULT NULL, p_task_identifier text DEFAULT NULL,
                                     p_dead_at_from timestamptz DEFAULT NULL, p_dead_at_to timestamptz DEFAULT NULL,
                                     p_after_dead_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL,
                                     p_limit integer DEFAULT 51, p_dead_letter_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, tenant_id uuid, task_identifier text, last_error_code text, last_error_message_redacted text,
               attempts integer, first_failed_at timestamptz, dead_at timestamptz, state text,
               resolved_by uuid, resolved_at timestamptz, resolution_note text, version integer)   -- = DeadLetterRow (02-TRD §6.8); no job_payload
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id, d.tenant_id, d.task_identifier, d.last_error_code, d.last_error_message_redacted,
         d.attempts, d.first_failed_at, d.dead_at, d.state,
         d.resolved_by, d.resolved_at, d.resolution_note, d.version
  FROM core.dead_letters d
  WHERE d.tenant_id IS NULL
    AND (SELECT app.is_platform_actor())                         -- platform context only (08 §4.7); fail-closed: no rows otherwise
    AND (p_dead_letter_id IS NULL OR d.id = p_dead_letter_id)
    AND (p_state IS NULL OR d.state = p_state)
    AND (p_task_identifier IS NULL OR d.task_identifier = p_task_identifier)
    AND (p_dead_at_from IS NULL OR d.dead_at >= p_dead_at_from)  -- inclusive (02-CV §4.4)
    AND (p_dead_at_to IS NULL OR d.dead_at < p_dead_at_to)       -- exclusive (02-CV §4.4)
    AND (p_after_dead_at IS NULL OR (d.dead_at, d.id) < (p_after_dead_at, p_after_id))
  ORDER BY d.dead_at DESC, d.id DESC
  LIMIT least(greatest(coalesce(p_limit, 51), 1), 201)           -- 02-CV §4.3: limit ≤ 200, + 1 look-ahead row
$$;

-- ctx.core.deadLetters.replay / discard for a platform row (08 A6.4, A8.4, A9.3, A9.4).
-- p_state 'replayed' (p_resolution_note optional) or 'discarded' (p_resolution_note required); length 1–500 by dead_letters__resolution_note__ck.
-- Version guard: the UPDATE matches only an open row with version = p_expected_version. 0 rows returned → C0 core throws
-- LimsError('common.version_conflict') (409, 08 A6.4) and enqueues nothing; 1 row → the updated DeadLetterRow (version + 1).
-- app.tg_dead_letter_transition() still enforces the allowed-change list and open → replayed | discarded.
-- Replay payload (08 A10.1): for p_state = 'replayed' the result also carries job_payload (NULL for 'discarded'). Only the C0
-- core service (services/api/src/core/core-repo, 02-TRD §6.8/§7.4) calls this function; it strips job_payload before building
-- DeadLetterRow and re-enqueues it through app.enqueue_job in the same transaction. No HTTP response or log contains it (08 A8.5).
-- Defensive message dl_resolve_invalid_input confirmed by 08 A10.3.
CREATE FUNCTION app.dl_resolve(p_dead_letter_id uuid, p_expected_version integer, p_state text,
                               p_resolution_note text DEFAULT NULL)
RETURNS TABLE (id uuid, tenant_id uuid, task_identifier text, last_error_code text, last_error_message_redacted text,
               attempts integer, first_failed_at timestamptz, dead_at timestamptz, state text,
               resolved_by uuid, resolved_at timestamptz, resolution_note text, version integer,   -- = DeadLetterRow
               job_payload jsonb,                                 -- core-only, replay only (08 A10.1); never in DeadLetterRow
               job_key text)                                      -- core-only: replay job_key source (08 A23.2); never in DeadLetterRow
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('replayed','discarded')
     OR (p_state = 'discarded' AND p_resolution_note IS NULL) THEN   -- discard requires a reason (08 A8.4)
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'dl_resolve_invalid_input';   -- 08 A10.3
  END IF;
  RETURN QUERY
  UPDATE core.dead_letters d
     SET state           = p_state,
         resolved_by     = app.current_actor_id(),               -- platform staff user (claims sub)
         resolved_at     = now(),
         resolution_note = p_resolution_note,
         version         = d.version + 1
   WHERE d.id = p_dead_letter_id
     AND d.tenant_id IS NULL
     AND d.state = 'open'
     AND d.version = p_expected_version
     AND (SELECT app.is_platform_actor())                        -- platform context only (08 §4.7)
  RETURNING d.id, d.tenant_id, d.task_identifier, d.last_error_code, d.last_error_message_redacted,
            d.attempts, d.first_failed_at, d.dead_at, d.state,
            d.resolved_by, d.resolved_at, d.resolution_note, d.version,
            CASE WHEN p_state = 'replayed' THEN d.job_payload END,   -- 08 A10.1
            d.job_key;                                              -- replay key = coalesce(job_key, task_identifier||':'||id)||':replay:'||version (08 A23.2)
END $$;

REVOKE ALL ON FUNCTION app.dl_insert_platform(uuid, text, jsonb, text, text, integer, timestamptz, text),
  app.dl_list_platform(text, text, timestamptz, timestamptz, timestamptz, uuid, integer, uuid),
  app.dl_resolve(uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dl_insert_platform(uuid, text, jsonb, text, text, integer, timestamptz, text) TO lims_worker;
GRANT EXECUTE ON FUNCTION app.dl_list_platform(text, text, timestamptz, timestamptz, timestamptz, uuid, integer, uuid),
  app.dl_resolve(uuid, integer, text, text) TO lims_api;

-- ===================================================================== platform tenant list (CR-C0-004; 08 A12.3)
-- C2 listTenants (GET /platform/tenants: filter status; sort code | -created_at; C2 02-TRD §5.10). Keyset as app.dl_list_platform:
-- the caller decodes the cursor (02-CV §4.3) into the last row's sort key (p_after_tenant_code for 'code'; p_after_created_at +
-- p_after_id for '-created_at') and passes p_limit = limit + 1 to detect next_cursor. Platform context only: no row unless
-- (SELECT app.is_platform_actor()). Reads core.tenants through tenants__select__owner_only (app.maintenance branch), which it sets
-- with set_config(…, true) and resets to '' before returning (§4.3 GUC rule). Output columns [CONV]: the tenant's identifying,
-- status and lifecycle columns; status_reason (free text typed by platform staff) and created_by / updated_by (staff user ids)
-- are not returned, so the list carries no free text and no person identifiers ("non-PHI tenant columns only", 08 A12.3).
-- p_sort outside ('code','-created_at') raises platform_list_tenants_invalid_input [CONV] (same pattern as dl_resolve_invalid_input;
-- the C2 handler validates sort first, so this is defensive).
CREATE FUNCTION app.platform_list_tenants(p_sort text, p_status text DEFAULT NULL, p_after_tenant_code text DEFAULT NULL,
                                          p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL,
                                          p_limit integer DEFAULT 51)
RETURNS TABLE (id uuid, tenant_code text, legal_name text, display_name text, status text, timezone text,
               activated_at timestamptz, suspended_at timestamptz, offboarded_at timestamptz, billing_live_on date,
               is_active boolean, version integer, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_sort IS NULL OR p_sort NOT IN ('code','-created_at') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'platform_list_tenants_invalid_input';
  END IF;
  IF NOT coalesce((SELECT app.is_platform_actor()), false) THEN
    RETURN;                                                       -- platform context only (08 §4.7, A12.3); fail-closed: no rows
  END IF;
  PERFORM set_config('app.maintenance', 'platform_list_tenants', true);
  IF p_sort = 'code' THEN
    RETURN QUERY
    SELECT t.id, t.tenant_code, t.legal_name, t.display_name, t.status, t.timezone,
           t.activated_at, t.suspended_at, t.offboarded_at, t.billing_live_on, t.is_active, t.version, t.created_at, t.updated_at
    FROM core.tenants t
    WHERE (p_status IS NULL OR t.status = p_status)
      AND (p_after_tenant_code IS NULL OR t.tenant_code > p_after_tenant_code)   -- tenants__tenant_code__uq (unique, global)
    ORDER BY t.tenant_code
    LIMIT least(greatest(coalesce(p_limit, 51), 1), 201);         -- 02-CV §4.3: limit ≤ 200, + 1 look-ahead row
  ELSE
    RETURN QUERY
    SELECT t.id, t.tenant_code, t.legal_name, t.display_name, t.status, t.timezone,
           t.activated_at, t.suspended_at, t.offboarded_at, t.billing_live_on, t.is_active, t.version, t.created_at, t.updated_at
    FROM core.tenants t
    WHERE (p_status IS NULL OR t.status = p_status)
      AND (p_after_created_at IS NULL OR (t.created_at, t.id) < (p_after_created_at, p_after_id))
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT least(greatest(coalesce(p_limit, 51), 1), 201);
  END IF;
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.platform_list_tenants(text, text, text, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_list_tenants(text, text, text, timestamptz, uuid, integer) TO lims_api;

-- ===================================================================== per-tenant cron fan-out (08 A13 P-6, A23.1)
-- The worker core calls this at each tick of a tenantScope 'per_tenant' crontab entry (claims of the core system actor, no tenant),
-- then, per returned id, opens withTenantScope(tenantId, <owning module's system actor>) and calls
-- app.enqueue_job(<identifier>, {tenant_id}, '<identifier>:<tenant_id>:<tick ISO minute>') (02-TRD §7.2). Reads core.tenants
-- through tenants__select__owner_only (app.maintenance = 'cron_tenant_ids' branch).
CREATE FUNCTION app.cron_tenant_ids() RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM set_config('app.maintenance', 'cron_tenant_ids', true);
  RETURN QUERY SELECT t.id FROM core.tenants t WHERE t.status IN ('active','suspended') ORDER BY t.id;   -- [CONV] P-6
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.cron_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cron_tenant_ids() TO lims_worker;

-- ===================================================================== tenant-code resolver (08 A19 D-121; replaces app.engagement_resolve_tenant_code)
-- Pre-tenant lookup (A12.1 naming): sets app.pre_tenant_code inside the body, reads core.tenants through tenants__select__owner_only
-- (tenant_code branch), resets the GUC to '' before returning. The caller (C16; C18 D-134 deferred) filters status = 'active'.
CREATE FUNCTION app.core_resolve_tenant_code(p_code text) RETURNS TABLE (tenant_id uuid, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.pre_tenant_code', coalesce(p_code, ''), true);
  RETURN QUERY SELECT t.id, t.status FROM core.tenants t WHERE t.tenant_code = p_code;
  PERFORM set_config('app.pre_tenant_code', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.core_resolve_tenant_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.core_resolve_tenant_code(text) TO lims_api;

-- ===================================================================== tenants targeted by a throttled IP (08 A25 D-217)
-- Requesting spec: C2 05-SCHEMA §10.3 (P-41). This text and C2's must be identical; a difference is a CR to C2 and C0 builds C2's.
-- Called only by the C2 worker task identity.notify_ip_throttle (platform scope). Reads core.users through users__select__owner_only
-- (app.maintenance = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL). No HTTP response can observe the result.
CREATE FUNCTION app.identity_tenants_for_email_hmacs(p_hmacs bytea[]) RETURNS SETOF uuid
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
REVOKE ALL ON FUNCTION app.identity_tenants_for_email_hmacs(bytea[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_tenants_for_email_hmacs(bytea[]) TO lims_worker;

-- ===================================================================== RLS (every C0 table; all policies shown — 08 A17 P-16, A23.3)
-- pred_t = tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())  — on EVERY __tenant policy,
-- in USING and in WITH CHECK (core.tenants: id instead of tenant_id). Non-staff actors reach core/audit tables only through the
-- actor-specific policies of the three shared_with tables (core.event_log, core.idempotency_keys, audit.access_log; §6).
ALTER TABLE core.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships__select__tenant ON core.memberships FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY memberships__insert__tenant ON core.memberships FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY memberships__update__tenant ON core.memberships FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY memberships__select__owner_only ON core.memberships FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())                                -- app.has_all_centres(), app.current_centre_ids()
      OR user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);      -- C2 pre-tenant lookups (08 A12.1; §4.3 GUC rule)
GRANT SELECT, INSERT, UPDATE ON core.memberships TO lims_app;

ALTER TABLE core.tenants ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants__select__tenant ON core.tenants FOR SELECT TO lims_app
  USING (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));                 -- guard added (08 A23.3)
CREATE POLICY tenants__insert__tenant ON core.tenants FOR INSERT TO lims_app
  WITH CHECK (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenants__update__tenant ON core.tenants FOR UPDATE TO lims_app
  USING (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
-- Owner policies on core tables for GUC-bound DEFINERs (§4.3 GUC rule; 08 A12.1, A12.3). TO lims_owner only: a lims_app session that
-- sets these GUCs gains nothing. The functions set them with set_config(…, true) and reset them to '' before returning.
-- One owner SELECT policy per table, so the branches are ORed.
CREATE POLICY tenants__select__owner_only ON core.tenants FOR SELECT TO lims_owner
  USING (id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid                -- C2 identity_resolve_session / identity_login_context (A12.1, A20.1)
      OR current_setting('app.maintenance', true) = 'platform_list_tenants'               -- app.platform_list_tenants (every tenant row)
      OR (current_setting('app.maintenance', true) = 'cron_tenant_ids'                    -- app.cron_tenant_ids (08 A23.1)
          AND status IN ('active','suspended'))
      OR tenant_code = nullif(current_setting('app.pre_tenant_code', true), ''));         -- app.core_resolve_tenant_code (08 A19 D-121)
GRANT SELECT, INSERT, UPDATE ON core.tenants TO lims_app;

-- core.branches, core.collection_centres, core.users, core.roles: class M, __tenant SELECT/INSERT/UPDATE
ALTER TABLE core.branches ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.branches FORCE ROW LEVEL SECURITY;
CREATE POLICY branches__select__tenant ON core.branches FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branches__insert__tenant ON core.branches FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branches__update__tenant ON core.branches FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON core.branches TO lims_app;
ALTER TABLE core.collection_centres ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.collection_centres FORCE ROW LEVEL SECURITY;
CREATE POLICY collection_centres__select__tenant ON core.collection_centres FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY collection_centres__insert__tenant ON core.collection_centres FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY collection_centres__update__tenant ON core.collection_centres FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON core.collection_centres TO lims_app;
ALTER TABLE core.users ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users__select__tenant ON core.users FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY users__insert__tenant ON core.users FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY users__update__tenant ON core.users FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY users__select__owner_only ON core.users FOR SELECT TO lims_owner
  USING (id = nullif(current_setting('app.pre_user_id', true), '')::uuid                   -- C2 identity_user_exists
      OR (current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs'    -- app.identity_tenants_for_email_hmacs
          AND email_hmac IS NOT NULL));                                                     -- (08 A25 D-217)
GRANT SELECT, INSERT, UPDATE ON core.users TO lims_app;
ALTER TABLE core.roles ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles__select__tenant ON core.roles FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY roles__insert__tenant ON core.roles FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY roles__update__tenant ON core.roles FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY roles__select__owner_only ON core.roles FOR SELECT TO lims_owner
  USING (tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid);        -- C2 identity_login_context
GRANT SELECT, INSERT, UPDATE ON core.roles TO lims_app;

-- association tables: __tenant SELECT/INSERT/DELETE
ALTER TABLE core.membership_centres ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.membership_centres FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_centres__select__tenant ON core.membership_centres FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_centres__insert__tenant ON core.membership_centres FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_centres__delete__tenant ON core.membership_centres FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_centres__select__owner_only ON core.membership_centres FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()));                                     -- app.current_centre_ids() (§4.1)
GRANT SELECT, INSERT, DELETE ON core.membership_centres TO lims_app;
ALTER TABLE core.membership_branches ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.membership_branches FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_branches__select__tenant ON core.membership_branches FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_branches__insert__tenant ON core.membership_branches FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_branches__delete__tenant ON core.membership_branches FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, DELETE ON core.membership_branches TO lims_app;
ALTER TABLE core.role_permissions ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions__select__tenant ON core.role_permissions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY role_permissions__insert__tenant ON core.role_permissions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY role_permissions__delete__tenant ON core.role_permissions FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, DELETE ON core.role_permissions TO lims_app;
ALTER TABLE core.membership_roles ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.membership_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_roles__select__tenant ON core.membership_roles FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__insert__tenant ON core.membership_roles FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__delete__tenant ON core.membership_roles FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__select__owner_only ON core.membership_roles FOR SELECT TO lims_owner
  USING (tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid          -- C2 identity_login_context: the chosen
         AND EXISTS (SELECT 1 FROM core.memberships m                                      -- tenant and a membership of the user
                     WHERE m.tenant_id = membership_roles.tenant_id AND m.id = membership_roles.membership_id
                       AND m.user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));
GRANT SELECT, INSERT, DELETE ON core.membership_roles TO lims_app;

-- core.event_log (class A; shared_with: [partner, portal, patient] — INSERT of own rows only, no non-staff SELECT; 08 A23.3).
-- The table has no actor_id column: created_by is the publishing actor and is what the actor policies bind [CONV].
ALTER TABLE core.event_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.event_log FORCE ROW LEVEL SECURITY;
CREATE POLICY event_log__select__tenant ON core.event_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_log__insert__tenant ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_log__insert__partner ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND created_by = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY event_log__insert__portal ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND created_by = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY event_log__insert__patient ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND created_by = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'patient');
GRANT SELECT, INSERT ON core.event_log TO lims_app;
-- (event_log__{select,delete}__owner_only: with the purges above)

-- <m>.event_inbox (class A; generated per schema of §3.9, shown for lab; consumers run as the module's system actor)
ALTER TABLE lab.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON lab.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON lab.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.event_inbox TO lims_app;

-- core.dead_letters tenant rows (written by the worker wrapper under the job's tenant claims, system actor). The owner_only and
-- __platform policies are with the app.dl_* functions above.
ALTER TABLE core.dead_letters ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY dead_letters__select__tenant ON core.dead_letters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dead_letters__insert__tenant ON core.dead_letters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dead_letters__update__tenant ON core.dead_letters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON core.dead_letters TO lims_app;

-- core.idempotency_keys (class E; shared_with: [partner, portal, patient] — own actor_id rows only, 08 A23.3; NULL-tenant
-- platform rows through __platform, 08 A25 D-213). DELETE (release of the actor's own in_progress key, 02-TRD §6.6 step 5 / D-202)
-- exists for every path that may INSERT [CONV].
ALTER TABLE core.idempotency_keys ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys__select__tenant ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__insert__tenant ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__update__tenant ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__delete__tenant ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system())
         AND state = 'in_progress');
-- actor-specific (08 A23.3): four statements per actor type partner, portal, patient
CREATE POLICY idempotency_keys__select__partner ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY idempotency_keys__insert__partner ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY idempotency_keys__update__partner ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY idempotency_keys__delete__partner ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND state = 'in_progress');
CREATE POLICY idempotency_keys__select__portal ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY idempotency_keys__insert__portal ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY idempotency_keys__update__portal ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY idempotency_keys__delete__portal ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND state = 'in_progress');
CREATE POLICY idempotency_keys__select__patient ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY idempotency_keys__insert__patient ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY idempotency_keys__update__patient ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY idempotency_keys__delete__patient ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND state = 'in_progress');
-- platform-context operations (provisionTenant, openSupportSession, invitePlatformStaff; 08 A25 D-213)
CREATE POLICY idempotency_keys__select__platform ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()));
CREATE POLICY idempotency_keys__insert__platform ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()));
CREATE POLICY idempotency_keys__update__platform ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()));
CREATE POLICY idempotency_keys__delete__platform ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()) AND state = 'in_progress');
CREATE POLICY idempotency_keys__delete__owner_only ON core.idempotency_keys FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_idempotency_keys' AND expires_at < now());   -- 08 A15.3
CREATE POLICY idempotency_keys__select__owner_only ON core.idempotency_keys FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_idempotency_keys' AND expires_at < now());   -- app.purge_idempotency_keys() DELETE … WHERE (08 A10.5, A15.3)
GRANT SELECT, INSERT, UPDATE, DELETE ON core.idempotency_keys TO lims_app;

ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log__select__tenant ON audit.audit_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())            -- guard added (08 A23.3)
         AND (centre_id IS NULL OR (SELECT app.has_all_centres())                                     -- CR-C2-010 centre clause,
              OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));                        -- cast form (08 A28.6, A16.1)
CREATE POLICY audit_log__insert__owner_only ON audit.audit_log FOR INSERT TO lims_owner
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
           OR ((SELECT app.current_tenant_id()) IS NULL                                   -- 08 A12.5: a core.tenants change in
               AND schema_name = 'core' AND table_name = 'tenants' AND row_id = tenant_id  -- platform context, audited under the
               AND (SELECT app.is_platform_actor()))                                      -- tenant row's own id
           OR ((SELECT app.current_actor_id()) IS NULL                                    -- 08 A28.5: a row changed inside a
               AND actor_id IS NULL AND actor_type = 'system'                             -- maintenance DEFINER (no claims),
               AND nullif(current_setting('app.maintenance', true), '') IS NOT NULL       -- audited under the row's tenant_id
               AND detail ->> 'maintenance' = current_setting('app.maintenance', true)));
GRANT SELECT ON audit.audit_log TO lims_app;

-- audit.access_log (class A; shared_with: [partner, portal, patient] — INSERT of own rows only, no non-staff SELECT; 08 A23.3)
ALTER TABLE audit.access_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit.access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY access_log__select__tenant ON audit.access_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (centre_id IS NULL OR (SELECT app.has_all_centres())                                     -- CR-C2-010 centre clause
              OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));                        -- (08 A28.6, A16.1)
CREATE POLICY access_log__insert__tenant ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY access_log__insert__partner ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY access_log__insert__portal ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY access_log__insert__patient ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'patient');
GRANT SELECT, INSERT ON audit.access_log TO lims_app;

-- The policies above are the canonical set (generated into db/policies/core.sql, db/policies/audit.sql and, per inbox schema,
-- db/policies/<m>.sql; CI diffs pg_policies against them). check-registry fails any __tenant / __tenant_centre policy without
-- app.is_staff_or_system() unless its table is shared_with and has the matching actor policy (08 A17 P-16; 02-TRD §4.1).

-- ===================================================================== app helper grants
GRANT EXECUTE ON FUNCTION app.current_claims(), app.current_tenant_id(), app.current_actor_id(), app.current_actor_type(),
  app.current_membership_id(), app.has_all_centres(), app.current_centre_ids(), app.is_staff_or_system() TO lims_app, lims_queue;
GRANT EXECUTE ON FUNCTION app.current_lims_session_id() TO lims_app, lims_api, lims_worker;   -- 08 A20.2 (as listed there)
GRANT SELECT ON core.g_task_registry TO lims_queue;
GRANT SELECT ON core.g_permissions, core.g_system_actors, core.g_task_registry, audit.g_cs_access_actions TO lims_app;
```

`db/tests/rls_exempt.txt` initial content:

```
core.g_permissions          global permission registry; no tenant data (CV §5.8)
core.g_system_actors        global system-actor ids; no tenant data
core.g_task_registry        global task identifiers; no tenant data
audit.g_cs_access_actions   global coded set; no tenant data
core.rate_limit_counters    UNLOGGED hashed counters; no grants to any app role; accessed only via app.ratelimit_hit (04 S11)
```

**Schema tests for the 08 Addendum A3.4 columns** (`db/tests`; part of T0B-03; test 2 extended by 08 A6.3; test 7 extended and test 9 added by 08 A8.4; tests 10–12 added by 08 A9.4; test 11 changed and tests 13–15 added by 08 A10.1, A10.4, A10.5; tests 16–19 added by 08 A12; tests 13 and 15 extended and tests 20–21 added by 08 A15; tests 7 and 12 extended and tests 22–33 added by the review fix pass of 2026-11-06 — 08 A20, A23, A25, A28):

1. `core.memberships.is_active` is generated: an INSERT or UPDATE as `lims_api` (tenant claims) that sets `is_active` to a non-DEFAULT value fails (SQLSTATE `428C9`); `UPDATE … SET status = 'deactivated'` makes `is_active = false`, `status = 'active'` makes it `true`, `status = 'invited'` gives `false`.
2. `memberships__status__ck`: `status = 'locked'` (or any value outside `invited`/`active`/`deactivated`) → `23514`. `memberships__lock_reason__ck`: `lock_reason_code = 'foo'` → `23514`; NULL and each of the four codes accepted. `memberships__deactivation_reason__ck` (08 A6.3): `deactivation_reason_code = 'foo'` → `23514`; NULL and each of the same four codes accepted; an UPDATE setting `status = 'active'` and `deactivated_at`/`deactivated_by`/`deactivation_reason_code` to NULL (reactivate) succeeds. `lock_reason_text` of 501 chars → `23514`.
3. Duplicate pending invite rejected: with an `invited` membership for (tenant A, user U, `user`), a second `invited` or `active` row for the same triple → `23505` (`memberships__tenant_id_user_id_actor_type__p_uq`); after the first is set to `deactivated`, a new row is accepted.
4. R27 with invites: an `invited` staff membership of user U in tenant A blocks an `invited` or `active` staff membership of U in tenant B → `23505` (`memberships__user_id__p_uq`); a `deactivated` one does not; `patient`/`partner` memberships of U in two tenants are accepted.
5. `core.users`: two rows in the same tenant with the same non-NULL `email_normalized` → `23505`; the same value in two tenants accepted; many NULLs accepted; 255-char value → `23514`. `phone_e164`: `+9779841000000` accepted, `9779841000000`, `+0123456789` and `+1234567` (7 digits) → `23514`; NULL accepted.
6. `core.tenants.status_reason` of 501 chars → `23514`.
7. `core.dead_letters`: `job_key` of 1–400 chars or NULL accepted, `''` → `23514` (08 A23.2); an update that changes `state` `open → replayed` together with `version = version + 1` passes `app.tg_dead_letter_transition()`; so does `open → discarded` with `resolution_note`, `resolved_by`, `resolved_at` and `version = version + 1` (08 A8.4); an update changing any other column (e.g. `job_payload`, `task_identifier`) still raises `immutable_row`.
8. Index presence: `role_permissions__tenant_id_permission_code__idx`, `membership_roles__tenant_id_role_id__idx`, `users__tenant_id_email_normalized__uq` exist and lead with `tenant_id`.
9. `core.dead_letters.resolution_note` (08 A8.4): an `open → discarded` update with `resolution_note` of 1 and of 500 chars succeeds and the stored value equals the input; `''` (0 chars) and 501 chars → `23514` (`dead_letters__resolution_note__ck`); NULL accepted (open rows, replay without a note).
10. `app.dl_list_platform` (08 A9.1, A9.2, A9.4): as `lims_api` with platform claims (`app.is_platform_actor()` true), it returns only `tenant_id IS NULL` rows; each filter narrows the result (`p_state`; `p_task_identifier`; `p_dead_at_from` inclusive, `p_dead_at_to` exclusive; `p_dead_letter_id` returns exactly that row, an unknown id or a tenant row's id returns 0 rows → `get` throws `common.not_found`); rows come in `dead_at DESC, id DESC` order and the `(p_after_dead_at, p_after_id)` keyset returns the next page without overlap; the result has no `job_payload` column. With tenant claims or with platform claims where `aal = 'aal1'`, it returns 0 rows.
11. `app.dl_resolve` (08 A6.4, A8.4, A9.3, A9.4): on an open platform row with `version = n`, `('replayed', expected n, NULL)` and `('replayed', expected n, '<1–500 chars>')` set `state = 'replayed'`, `resolved_by = sub`, `resolved_at`, `resolution_note` = the input (NULL or the note), `version = n + 1`, and return that row; `('discarded', expected n, '<note>')` does the same with `state = 'discarded'`; expected `≠ n`, a row not `open`, a tenant row, or a call without platform claims return 0 rows and leave the row unchanged; `('discarded', n, NULL)` and an unknown `p_state` raise `dl_resolve_invalid_input`; a 501-char note → `23514`. The result's `job_payload` column equals the row's stored `job_payload` for `'replayed'` and is NULL for `'discarded'` (08 A10.1); the C0 core contract test (T0D-08) asserts that the `DeadLetterRow` built from it has no `job_payload` field.
12. `app.dl_insert_platform`: as `lims_worker` with core system-actor claims, a `platform`-scope task identifier inserts one `open` row with `tenant_id IS NULL`, `dead_at = now()`, `version = 1` and `job_key` = `p_job_key` (08 A23.2; `app.dl_resolve(..., 'replayed', ...)` then returns that `job_key`); a `per_tenant` identifier → `job_tenant_mismatch`; an unknown identifier → `unknown_task_identifier`. `lims_api` has no EXECUTE on it; `lims_worker` has no EXECUTE on `app.dl_list_platform` / `app.dl_resolve`; PUBLIC has none on all three.
13. DEFINER contract tests under FORCE RLS (08 A10.5; AC-0B-2.4): for every function in `db/meta/definer-inventory.yaml` that touches a FORCE-RLS table, its contract test runs with `relforcerowsecurity = true` on every touched table (asserted from `pg_class` at the start of the test) and checks non-empty results where the fixture expects them: `app.has_all_centres()` / `app.current_centre_ids()` for a centre-scoped user (existing helpers-positive test); `app.is_platform_actor()` = true for platform claims (`scope = 'platform'`, `aal = 'aal2'`) of an active `identity.platform_staff` row and false for an inactive one; each purge deletes exactly its seeded expired rows (`app.purge_event_log`, `app.purge_event_inboxes`, `app.purge_idempotency_keys`, `app.purge_dead_letters`, including tenant rows of `core.dead_letters`) and keeps the unexpired ones, and `current_setting('app.maintenance', true) = ''` after it returns (08 A15.3); `app.dl_list_platform` returns its seeded platform rows. A static check fails CI if any file under `db/tests/**` contains `DISABLE ROW LEVEL SECURITY` or `NO FORCE ROW LEVEL SECURITY`, or creates a stand-in table without ENABLE + FORCE RLS (stand-ins carry the real policies).
14. `core.dead_letters` `__platform` policies (08 A10.4): as `lims_api` with platform claims, a direct `SELECT` / `UPDATE` (the tenant-row path of `ctx.core.deadLetters`) sees and changes tenant rows only; a NULL-tenant row is invisible to it and changes only through `app.dl_resolve`; `pg_policies.qual` of `dead_letters__select__platform` and `dead_letters__update__platform` contains `tenant_id IS NOT NULL`.
15. Owner SELECT predicates (08 A10.5, A15.3; checked with `SET ROLE lims_owner` and tenant-less claims): with `app.maintenance` unset (or `''`, or another function's name) `dead_letters__select__owner_only` admits the NULL-tenant rows only, and `event_log__select__owner_only`, `event_inbox__select__owner_only` and `idempotency_keys__select__owner_only` admit no row; with `app.maintenance` = the purge's name (`purge_dead_letters`, `purge_event_log`, `purge_event_inboxes`, `purge_idempotency_keys`) each admits exactly the rows matching its expiry predicate (`dead_letters`: plus the NULL-tenant rows). As `lims_worker` with `app.maintenance` set to each of those names, a direct `SELECT` of the four tables returns no expired row of another tenant (the policies are `TO lims_owner` only; test 17 rule). `pg_policies` has no `TO lims_owner` policy on these tables whose expiry predicate is not ANDed with `current_setting('app.maintenance', true)`.
16. `app.platform_list_tenants` under FORCE RLS (08 A12.3, A12.7): with `relforcerowsecurity = true` on `core.tenants` and `identity.platform_staff`, as `lims_api` with platform claims (`app.is_platform_actor()` true) it (a) returns every seeded tenant once (`p_status` narrows; `'code'` order ascending by `tenant_code` and `'-created_at'` order `created_at DESC, id DESC`; the keyset arguments return the next page without overlap; `p_limit` above 200 returns at most 201 rows); the result has no `status_reason`, `created_by` or `updated_by` column. With tenant claims, or platform claims where `aal = 'aal1'`, it returns 0 rows; `p_sort = 'name'` raises `platform_list_tenants_invalid_input`. (b) A `lims_api` session that runs `set_config('app.maintenance', 'platform_list_tenants', true)` itself and selects `core.tenants` with no claims sees 0 rows. (c) After it returns, `current_setting('app.maintenance', true) = ''` in the same transaction.
17. GUC-bound `core` owner policies (08 A12.1, A12.7; the C2 function contract tests are C2 05-SCHEMA §11 tests 22 and 24): `pg_policies` has `memberships__select__owner_only`, `users__select__owner_only`, `tenants__select__owner_only`, `roles__select__owner_only` and `membership_roles__select__owner_only` with `roles = {lims_owner}`; every policy whose `qual` or `with_check` contains `app.pre_` or `app.maintenance` has `roles = {lims_owner}`. A `lims_api` / `lims_worker` session with no claims that sets `app.pre_user_id`, `app.pre_tenant_id` to seeded values sees 0 rows in each of those five tables. `app.has_all_centres()` / `app.current_centre_ids()` still return the tenant-bound results (helpers-positive test) with `app.pre_user_id` unset.
18. `app.tg_row_audit` for `core.tenants` (08 A12.5): as `lims_api` with platform claims (no `tenant_id`), an INSERT and an UPDATE of `core.tenants` through the `__platform` policies each write one `audit.audit_log` row with `tenant_id` = `row_id` = the tenant's `id`, `schema_name = 'core'`, `table_name = 'tenants'`; with tenant claims an UPDATE of the own tenant writes `tenant_id` = that id; a direct INSERT into `audit.audit_log` as `lims_api` fails (no grant). With the pre-A12 `audit_log__insert__owner_only` text (`tenant_id = app.current_tenant_id()` only) the same platform-context UPDATE fails with an RLS violation on `audit.audit_log` (regression guard).
19. Platform-only tables are not audited (08 A12.5): `pg_trigger` has no trigger calling `app.tg_row_audit()` on `identity.platform_staff`, `identity.platform_events` or any table that `db/meta/tables.yaml` marks platform-only; the bootstrap CLI path (`app.identity_bootstrap_platform_admin` with no claims, FORCE RLS on) succeeds without `audit_context_missing` and writes no `audit.audit_log` row (C2 05-SCHEMA §11 test 25).
20. `app.tg_row_audit` with no trigger arguments (08 A15.5): on an audited table whose trigger is created with no arguments (e.g. `core.branches`), as `lims_api` with tenant claims, an UPDATE of one non-bookkeeping column writes one `audit.audit_log` row with `action = 'UPDATE'`, `changed_columns` = that column, and `old_values` / `new_values` holding only that column; an UPDATE that changes only `updated_at` / `version` writes none; an INSERT writes `new_values` = the full new row and a DELETE (on a table with a DELETE grant, e.g. `core.membership_centres`) writes `old_values` = the full old row (neither NULL). With an excluded-column argument (fixture trigger on a stand-in with ENABLE + FORCE RLS), the excluded column is absent from `changed_columns`, `old_values` and `new_values`.
21. `app.is_platform_actor()` in C0 (08 A15.6): the function is created by the C0 context-helpers migration (T0B-02), which precedes every migration that creates a policy or function referencing it (`check-migrations.ts` asserts the order); `prosecdef = true`, `proconfig` contains `search_path=`, owner `lims_owner`; `has_function_privilege('lims_app', 'app.is_platform_actor()', 'EXECUTE')`, and so for `lims_api` and `lims_worker`, is true; PUBLIC has no EXECUTE. Its behaviour under FORCE RLS is C2 05-SCHEMA §11 test 21.
22. `app.cron_tenant_ids()` fan-out (08 A13 P-6, A23.1; A12.7): with FORCE RLS on `core.tenants` and tenants in each status, as `lims_worker` with core system-actor claims (no tenant) it returns exactly the `active` and `suspended` ids and `current_setting('app.maintenance', true) = ''` afterwards. Then, per id, under `withTenantScope(id, catalog system actor)` claims, `app.enqueue_job('<per_tenant identifier>', {tenant_id: id}, '<identifier>:<id>:<tick minute>')` enqueues one job; a second call with the same key enqueues nothing; the same enqueue without tenant claims, or with another tenant's id in the payload, raises `job_tenant_mismatch`. A `lims_worker` session that sets `app.maintenance = 'cron_tenant_ids'` itself sees 0 `core.tenants` rows; `lims_api` and PUBLIC have no EXECUTE.
23. Tenant dead-letter replay (08 A23.2): as `lims_api` with platform claims, the version-guarded `__platform` UPDATE `open → replayed` (version n → n + 1) succeeds, a stale version changes 0 rows; `app.enqueue_job(task_identifier, job_payload, coalesce(job_key, task_identifier || ':' || id) || ':replay:' || (n + 1))` with platform claims only raises `job_tenant_mismatch`; inside `withTenantScope(row.tenant_id, <system actor of g_task_registry.module>)` it enqueues exactly one job with that key; the claims are the platform claims again afterwards; both commit together.
24. Non-staff writes (08 A23.3, P-16): as `lims_api` with `patient`, `partner` and `portal` claims of tenant A, an INSERT into `core.event_log` (own `created_by`), `audit.access_log` (own `actor_id`) and `core.idempotency_keys` (own `actor_id`) succeeds; SELECT/UPDATE/DELETE (`in_progress`) of the own idempotency row affect 1 row; SELECT of `core.event_log`, `audit.access_log`, `core.tenants`, `core.branches`, `core.memberships`, `audit.audit_log` returns 0 rows; an INSERT with another actor id, another tenant, or into a non-shared table (`core.branches`) fails `42501`. Staff claims of tenant A see the inserted event and access rows; `device` claims still pass the guard (08 A19.1). `pg_policies`: every `__tenant` / `__tenant_centre` policy has `is_staff_or_system` in USING and WITH CHECK, and `__partner`/`__portal`/`__patient` policies exist only on the three `shared_with` tables (the check-registry rule, 02-TRD §4.1).
25. `app.enforce_mutable_columns()` with no trigger arguments (08 A20.3): on a stand-in class-C table (ENABLE + FORCE RLS) whose trigger has no arguments, an UPDATE that changes any column raises `immutable_row`; an UPDATE that changes nothing passes; with the argument `'status'` only `status` may change.
26. Centre predicate (08 A16.1): `CREATE POLICY … USING (centre_id = ANY ((SELECT app.current_centre_ids())))` fails on PostgreSQL 16 with `operator does not exist: uuid = uuid[]`; the cast form `= ANY ((SELECT app.current_centre_ids())::uuid[])` is accepted and a centre-scoped user sees exactly its own centre's rows; no row of `pg_policies` whose `qual`/`with_check` mentions `current_centre_ids()` lacks `::uuid[]`; the spec-SQL grep for the uncast form returns 0 hits.
27. Platform idempotency keys (08 A25 D-213): with platform claims, `INSERT … ON CONFLICT (tenant_id, actor_id, key) DO NOTHING RETURNING key` of a NULL-tenant key returns the key once and nothing on the second call (replay path); a second platform actor with the same key gets its own row; platform claims with `aal1` and tenant claims see no NULL-tenant row; `app.purge_idempotency_keys()` deletes expired NULL-tenant rows.
28. NULL-tenant audit (08 A25 D-215): on a stand-in mixed table (nullable `tenant_id`, `tg_row_audit` attached, FORCE RLS), a NULL-tenant INSERT and UPDATE under platform claims write 0 `audit.audit_log` rows and raise nothing; a tenant-row INSERT writes 1.
29. `app.core_resolve_tenant_code` (08 A19 D-121; A12.7) and `app.identity_tenants_for_email_hmacs` (08 A25 D-217): the first, as `lims_api` with no claims, returns `(tenant_id, status)` for a known code (any status; the caller filters `active`), 0 rows for an unknown or NULL code, leaves `app.pre_tenant_code = ''`, and a `lims_api` session that sets `app.pre_tenant_code` itself sees 0 `core.tenants` rows. The second, as `lims_worker`, returns the distinct tenants of users with a matching `email_hmac`, raises `identity_tenants_for_email_hmacs_invalid_input` for > 100 values, leaves `app.maintenance = ''`, and a `lims_worker` session setting the GUC sees 0 `core.users` rows; `lims_api` has no EXECUTE.
30. No standing CREATE (08 A25 D-201): after all migrations, `has_database_privilege(r, current_database(), 'CREATE')` and `has_schema_privilege(r, 'app', 'CREATE')` are false for `lims_worker`, `lims_api`, `lims_queue`, `lims_reporting_lookup`; `CREATE SCHEMA` and `CREATE FUNCTION app.x()` as `lims_worker` fail `42501`; the functions created in the window are owned by `lims_queue`.
31. Retention purges (08 A25 D-200): each `app.purge_*()` called by `lims_worker` in its own transaction with `statement_timeout = 300000` deletes a 10,000+ row expired seed per table completely (`capped = false`) and keeps unexpired rows; the GUC is `''` afterwards. Capped resume (the 4-minute exit sets `capped = true`, the next call continues) is asserted by T0D-09 with a fault-injected clock in the worker test, not in the SQL harness [CONV]. The owner-policy suite of tests 13–17 and 22–29 is re-run on the pinned `supabase/postgres:17.6.1.136` image in T0B-08 (review C0 m#33).

32. Maintenance audit (08 A28.5): a maintenance DEFINER (stand-in of the C2 `identity_expire_*` shape, FORCE RLS, owner policies gated on `app.maintenance`) called by `lims_worker` with no claims updates an audited tenant row and writes one `audit.audit_log` row with the row's `tenant_id`, `actor_type = 'system'`, `actor_id` and `created_by` NULL, `detail = {"maintenance": "<function name>"}`; a write with neither claims nor `app.maintenance` raises `audit_context_missing`; `audit_log__actor__ck` refuses a NULL `actor_id` without `detail.maintenance`.
33. Partner role and audit-viewer scope (08 A28.3, A28.6): `core.memberships` refuses a `partner` row without `partner_role`, a non-partner row with one, and an unknown value; accepts `partner_member` / `partner_admin`. With claims of a centre-scoped staff membership, `audit.audit_log` / `audit.access_log` return rows with `centre_id` NULL or in the membership's centres only; the `(tenant_id, request_id)` and partial `(tenant_id, support_session_id, occurred_at DESC)` indexes exist on both tables.

Scratch-cluster evidence (2026-11-06, PostgreSQL 16, FORCE RLS on every table, SQL of §1, §2 and §10 loaded verbatim as `lims_migrator`, with test stubs only for C2's `identity.platform_staff` and for `graphile_worker`): tests 22–30, 31's full-seed part, 32 and the CHECK/centre parts of 33 passed; test 20 and the `app.dl_insert_platform` / `app.dl_resolve` `job_key` path passed as regressions. The same run found that `ALTER DEFAULT PRIVILEGES FOR ROLE lims_queue|lims_reporting_lookup` cannot be run by `lims_owner` (not a member); §2 now runs it as each role.

## 11. Seeds and coded sets

| Seed | Rows | Environments |
|---|---|---|
| `core.g_permissions` | every code of IC §11 with `privileged`, `phase` (default `1` when absent), module = first segment | all |
| `core.g_system_actors` | one row per module of CM §3 that has worker tasks or consumers, plus `core`; fixed UUIDv7s from `db/meta/system-actors.yaml` (generated once, then never changed) | all |
| `audit.g_cs_access_actions` | generated from the 03-IC §13.1 block + the §3.7 base list (equality-tested) | all |
| `core.g_task_registry` | written by `registry-sync` at deploy (`02-TRD.md` §7.7), not a static seed | all |
| synthetic tenants | `tenant_a`/`tenant_b` (ids from IC §1 family), 2 branches + 3 centres each (centre kinds own, franchise, home_collection), the default roles of `contracts/permissions.yaml` (currently 10, incl. `radiologist` — 03-IC §11) with IC §11 grants, users + memberships for every fixture actor of `02-TRD.md` §3.5 (incl. per tenant one `partner_member`, one `partner_admin`, one `patient` with membership; the portal-link actor, `bridge_agent` and `queue_display` device actors have no membership — their claims come from their resolvers) | dev, ci, staging only (REQ-SEC-041, REQ-SEC-136) |
