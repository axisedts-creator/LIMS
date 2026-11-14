# C1 — Infrastructure & Operations — 05 SCHEMA

Status: DRAFT for build, 2026-11-06.

**C1 owns no table in the application database** and adds no module schema (CM §3 module table has no C1 row). This document specifies:
1. the infrastructure data stores C1 runs (backup repositories, log/metric stores, the audit store) with retention and data classification;
2. the DDL of the separate **audit store** database (C1-owned, lives in `infra/auditstore/`, not in `db/`);
3. the application-DB objects C1 needs and requests from C0 (CR-C1-002) — C0 writes them;
4. the DB-level settings C1 owns (PostgreSQL parameters, PgBouncer, pgBackRest) — values are in `02-TRD.md` §7.6, §7.7, §9.2 and are not repeated except where a store's behaviour depends on them.

PHI classes below use the CV §9.2 categories (direct identifiers, health data, credentials) and REQ-SEC-004 classes (sensitive-health / personal / non-personal).

---

## 1. Ownership boundaries

| Object | Lives in | DDL owner | Spec |
|---|---|---|---|
| `audit.audit_log`, `audit.access_log` (source) | application DB | C0 | C0 05-SCHEMA §3.6–3.7 |
| `billing.activity_log` (source) | application DB | C0 (spec C4) | C4 05-SCHEMA |
| Roles `lims_monitor`, `lims_replicator`, `lims_audit_ship`; publication `lims_audit_ship` | application DB | C0 (requested by CR-C1-002) | §4 |
| Audit store database `auditstore` | dr-1:5433 (separate instance) | **C1** | §3 |
| pgBackRest repos, WAL spool | filesystem (data-1, dr-1) | C1 | §2 |
| Prometheus TSDB, VictoriaLogs data, Grafana DB, registry, secrets repo | ops-1 filesystem | C1 | §2 |
| Object replica | dr-1 filesystem | C1 | §2 |

## 2. Infrastructure data stores — inventory, retention, classification

Retention values are config (`group_vars/all.yml` → `retention:`; 02-TRD §14). Floors are validated; a play fails if a value is below its floor.

| Store | Location | Contents | Class | Encryption | Retention (default) | Floor / source |
|---|---|---|---|---|---|---|
| pgBackRest repo1 | data-1 `vg_repo` | full/incr backups + WAL of the app DB | sensitive-health (full DB copy) | pgBackRest `aes-256-cbc` (cipher pass 1, present on data-1 only on tmpfs) + LUKS | `repo1-retention-full=2` (count; weekly fulls ≈ 14 days PITR) [CONV] | ≥ 1 full |
| pgBackRest repo2 | dr-1 `vg_dr` (site B) | same | sensitive-health | `aes-256-cbc` (cipher pass 2, not on dr-1) + LUKS | 35 days (time) [CONV] | ≥ 35 days (covers monthly drill — 04 I3) |
| Interim pgBackRest repo after DR promotion (08 A25 D-210) | ops-1 `vg_ops` (site B) | WAL + a new full backup of the promoted primary | sensitive-health | `aes-256-cbc` (its own cipher pass, not on ops-1's disks) + LUKS | until switch-back or a repo on another site exists; then removed after its retention | created ≤ 4 h after promotion |
| WAL spool | data-1 `/srv/lims/pgbackrest/spool` | WAL awaiting push | sensitive-health | LUKS | until pushed; cap 20 GiB (`archive-push-queue-max`) | — |
| Standby PGDATA | dr-1 | physical replica | sensitive-health | LUKS | live mirror | — |
| Object replica | dr-1 `/replica/storage` | report PDFs, TRFs, outsourced PDFs, exports (Storage file backend) | sensitive-health | LUKS; SSH in transit | mirrors primary; **no deletion** until C6 publishes a purge list (reports ≥ 5 years online — 04 I8) | 04 I8 |
| Audit store `auditstore` | dr-1:5433 | copies of `audit_log`, `access_log`, `billing.activity_log` + daily digests | sensitive-health (old/new JSONB values) | LUKS | `audit_retention_years = 5`; per-tenant longer per C2 setting; **purge job disabled until B15 answers** | ≥ 5 years (04 D11, I8; B15) |
| VictoriaLogs | ops-1 `vg_ops` | app/infra JSON logs (no PHI by CV §9.2 rule + scrub filter), nginx access logs (IP addresses = personal data) | personal (IPs), otherwise non-personal | LUKS | 90 days [CONV] | — |
| `ops_audit` stream | VictoriaLogs + nightly copy to audit store table `auditstore_meta.ops_audit` | operator actions (who/what/when) | personal (operator names) | LUKS | logs 90 days; audit-store copy 5 years [CONV] | — |
| Prometheus TSDB | ops-1 | metrics (UUID labels for tenants/centres/agents only) | non-personal | LUKS | 90 days [CONV] | — |
| Alertmanager state | ops-1 | silences, notification log | personal (operator names in comments) | LUKS | default Alertmanager retention (C1 sets `--data.retention=720h` [CONV]) | — |
| Grafana DB (SQLite) | ops-1 | users, dashboards (provisioned), preferences | personal (operators) | LUKS; nightly rsync to dr-1 | live | — |
| Registry storage | ops-1 | container images | non-personal | LUKS; nightly rsync to dr-1 | last 20 releases per image [CONV] | — |
| `lims-secrets` repo | ops-1 | SOPS-encrypted secrets, incl. `tenant_ops_contacts` / `alert_contacts` (e-mail addresses) | credentials; personal (contact e-mails) | SOPS/age + LUKS; nightly rsync to dr-1 | git history kept (encrypted) | — |
| nginx access log files | app-1 `/var/log/nginx` | JSON access lines (route templates, no query) | personal (IP) | LUKS (root VG) | 14 daily files [CONV] (shipped to VictoriaLogs) | — |
| Drill scratch volume | ops-1 transient LV | restored DB copy | sensitive-health | LUKS; `blkdiscard` + `lvremove` at end | duration of drill only | — |
| Drill reports | `infra/runbooks/drill-log/` (git) | counts, timings, checks | non-personal | — | permanent | 04 I3 evidence |
| Valkey | app-1 memory | rate-limit counters | non-personal (HMAC'd keys — C0) | none needed | ephemeral, no persistence (04 S11) | **not backed up** |
| Agent release store | app-1 `/srv/lims/agent-releases` (vg_storage), read-only into api-a/b | signed bridge-agent zips (CR-C7-012) | non-personal | LUKS | last 5 releases per channel [CONV] (rows in `instruments.g_agent_releases` that are still active must keep their file) | — |
| ClamAV signature copy | app-1 `/srv/lims/clamav-db` | signature databases from ops-1 | non-personal | — | current only | — |

## 3. Audit store database (`auditstore` on dr-1:5433) — C1 DDL

### 3.1 Design rules
- Separate PostgreSQL 17 instance and database; no FK, no RLS (access is by role; there are no tenant-facing clients).
- Subscriber tables must have the **same schema-qualified names and compatible columns** as the published tables because logical replication matches by name. They are generated by `infra/auditstore/gen-schema.sh` from a freshly migrated staging DB (`pg_dump --schema-only --table=audit.audit_log --table=audit.access_log --table=billing.activity_log`) and then stripped of FKs and CHECK constraints (a CHECK that a future additive migration relaxes on the primary must never block apply). The DDL in §3.4 is the current expected output, transcribed from C0 05-SCHEMA §3.6–3.7 and C4 05-SCHEMA (`billing.activity_log`); if it ever differs from the generated output, the generated output wins and this document is updated.
- Primary keys are kept (they reject duplicate application of the same row — 03-APP-FLOW §6).
- Indexes: only those needed for investigations (§3.3).
- Append-only: no role used by people or jobs has UPDATE/DELETE/TRUNCATE on replicated tables.

### 3.2 Roles in the audit store
| Role | Attributes | Privileges |
|---|---|---|
| `auditstore_owner` | NOLOGIN | owns schemas/tables |
| `audit_writer` | LOGIN | owner of subscription `audit_ship`; `INSERT` on the three replicated tables; plus whatever the apply worker requires on PG 17 (verified in spike T-15; if apply requires table ownership, `auditstore_owner` becomes the subscription owner with `LOGIN` disabled except for the apply connection — recorded in T-15) |
| `audit_digest` | LOGIN | `SELECT` on replicated tables; `INSERT` on `auditstore_meta.daily_digests`, `auditstore_meta.ops_audit` |
| `audit_reader` | LOGIN, password split founder/ops lead | `SELECT` on views in schema `auditstore` only; used only through `audit.md#investigation` |
| `lims_monitor` | LOGIN | `pg_monitor` |
| instance superuser | — | break-glass only (backfill, schema sync by `gen-schema.sh --apply` runs as `auditstore_owner` via `SET ROLE`) |

### 3.3 Queries the store must serve (investigation runbook) and their indexes
| Query | Index |
|---|---|
| all events for one tenant in a time window | PK `(tenant_id, occurred_at, id)` (audit/access); `activity_log__tenant_id_occurred__idx` |
| who accessed entity X (tenant, entity_type, entity_id) | `access_log__tenant_id_entity__idx` |
| what actor Y did | `audit_log__tenant_id_actor__idx`, `access_log__tenant_id_actor__idx`, `activity_log__tenant_id_actor_occurred__idx` |
| history of row Z | `audit_log__tenant_id_table_row__idx` |
| daily digest | PK scan by `(tenant_id, occurred_at)` range |

### 3.4 DDL (`infra/auditstore/schema.sql`)

```sql
-- infra/auditstore/schema.sql — run on dr-1:5433 database "auditstore" as instance superuser at creation;
-- later changes only through gen-schema.sh --apply (additive). Source of truth for column lists: the primary's catalog.

CREATE ROLE auditstore_owner NOLOGIN;
CREATE ROLE audit_writer     LOGIN PASSWORD :'audit_writer_pw';
CREATE ROLE audit_digest     LOGIN PASSWORD :'audit_digest_pw';
CREATE ROLE audit_reader     LOGIN PASSWORD :'audit_reader_pw';
CREATE ROLE lims_monitor     LOGIN PASSWORD :'lims_monitor_pw';
GRANT pg_monitor TO lims_monitor;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA audit           AUTHORIZATION auditstore_owner;   -- same names as publisher (logical replication matches schema.table)
CREATE SCHEMA billing         AUTHORIZATION auditstore_owner;
CREATE SCHEMA auditstore      AUTHORIZATION auditstore_owner;   -- reader views
CREATE SCHEMA auditstore_meta AUTHORIZATION auditstore_owner;   -- digests, ops audit, drift log

SET ROLE auditstore_owner;

CREATE TABLE audit.audit_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  schema_name text NOT NULL, table_name text NOT NULL, row_id uuid, action text NOT NULL,
  changed_columns text[] NOT NULL DEFAULT '{}', old_values jsonb, new_values jsonb,
  actor_id uuid, actor_type text NOT NULL, membership_id uuid, support_session_id uuid,   -- actor_id NULL only for maintenance rows (08 A28.5)
  request_id uuid, client_ip inet, user_agent text,
  detail jsonb,                                                      -- 08 A28.5 / A29.2: {"maintenance": "<function name>"}
  occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL, created_by uuid,   -- created_by NULL with actor_id (A28.5)
  CONSTRAINT audit_log__pk PRIMARY KEY (tenant_id, occurred_at, id)
);
CREATE INDEX audit_log__tenant_id_table_row__idx ON audit.audit_log (tenant_id, schema_name, table_name, row_id, occurred_at DESC);
CREATE INDEX audit_log__tenant_id_actor__idx     ON audit.audit_log (tenant_id, actor_id, occurred_at DESC);

CREATE TABLE audit.access_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  actor_id uuid NOT NULL, actor_type text NOT NULL, membership_id uuid, support_session_id uuid,
  action text NOT NULL, entity_type text NOT NULL, entity_id uuid, purpose_code text,
  outcome text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
  request_id uuid, client_ip inet, user_agent text,
  occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL, created_by uuid NOT NULL,
  CONSTRAINT access_log__pk PRIMARY KEY (tenant_id, occurred_at, id)
);
CREATE INDEX access_log__tenant_id_entity__idx ON audit.access_log (tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX access_log__tenant_id_actor__idx  ON audit.access_log (tenant_id, actor_id, occurred_at DESC);

CREATE TABLE billing.activity_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  action text NOT NULL, document_kind text, document_id uuid, document_no text,
  actor_id uuid NOT NULL, actor_membership_id uuid, actor_type text NOT NULL,
  occurred_at timestamptz NOT NULL, request_id uuid, details jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL, created_by uuid NOT NULL,
  CONSTRAINT activity_log__pk PRIMARY KEY (id)
);
CREATE INDEX activity_log__tenant_id_occurred__idx       ON billing.activity_log (tenant_id, occurred_at DESC);
CREATE INDEX activity_log__tenant_id_actor_occurred__idx ON billing.activity_log (tenant_id, actor_membership_id, occurred_at DESC);

-- daily per-tenant hash chain (REQ-SEC-097 tamper evidence)
CREATE TABLE auditstore_meta.daily_digests (
  tenant_id     uuid        NOT NULL,
  source_table  text        NOT NULL CHECK (source_table IN ('audit.audit_log','audit.access_log','billing.activity_log')),
  business_date date        NOT NULL,                     -- Asia/Kathmandu calendar date of occurred_at
  row_count     bigint      NOT NULL CHECK (row_count >= 0),
  rows_sha256   bytea       NOT NULL CHECK (octet_length(rows_sha256) = 32),
  prev_digest   bytea       CHECK (prev_digest IS NULL OR octet_length(prev_digest) = 32),
  chain_digest  bytea       NOT NULL CHECK (octet_length(chain_digest) = 32),   -- sha256(coalesce(prev_digest, '\x'::bytea) || rows_sha256 || convert_to(row_count::text, 'UTF8'))
  computed_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_digests__pk PRIMARY KEY (tenant_id, source_table, business_date)
);

CREATE TABLE auditstore_meta.ops_audit (                -- nightly copy of VictoriaLogs ops_audit stream
  id          uuid        NOT NULL,
  occurred_at timestamptz NOT NULL,
  operator    text        NOT NULL CHECK (char_length(operator) <= 64),
  env         text        NOT NULL CHECK (env IN ('dev','staging','prod')),
  action      text        NOT NULL CHECK (char_length(action) <= 64),     -- e.g. deploy, secret_decrypt, studio_enable, drill
  detail      jsonb       NOT NULL DEFAULT '{}' CHECK (octet_length(detail::text) <= 4096),   -- no secret values, no PHI
  CONSTRAINT ops_audit__pk PRIMARY KEY (occurred_at, id)
);

CREATE TABLE auditstore_meta.schema_sync_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  release text NOT NULL, ddl_sha256 bytea NOT NULL, statements text NOT NULL
);

-- reader views (no rows filtered; access is controlled by role and runbook)
CREATE VIEW auditstore.audit_log            AS SELECT * FROM audit.audit_log;
CREATE VIEW auditstore.access_log           AS SELECT * FROM audit.access_log;
CREATE VIEW auditstore.billing_activity_log AS SELECT * FROM billing.activity_log;
CREATE VIEW auditstore.daily_digests        AS SELECT * FROM auditstore_meta.daily_digests;

RESET ROLE;

-- privileges: append-only
REVOKE ALL ON ALL TABLES IN SCHEMA audit, billing, auditstore_meta FROM PUBLIC;
GRANT USAGE ON SCHEMA audit, billing TO audit_writer, audit_digest;
GRANT INSERT ON audit.audit_log, audit.access_log, billing.activity_log TO audit_writer;
GRANT SELECT ON audit.audit_log, audit.access_log, billing.activity_log TO audit_digest;
GRANT USAGE ON SCHEMA auditstore_meta TO audit_digest;
GRANT SELECT, INSERT ON auditstore_meta.daily_digests, auditstore_meta.ops_audit TO audit_digest;
GRANT USAGE ON SCHEMA auditstore TO audit_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA auditstore TO audit_reader;      -- views only

-- subscription (password from secret store; dr-1 → data-1 over wg0)
-- CREATE SUBSCRIPTION audit_ship
--   CONNECTION 'host=<data-1 wg IP> port=5432 dbname={{ app_db_name }} user=lims_audit_ship password=… '   -- app_db_name: 02-TRD §15 (default postgres)
--   PUBLICATION lims_audit_ship
--   WITH (copy_data = false, streaming = on, create_slot = true, slot_name = 'audit_ship');
-- Executed by infra/ansible/roles/auditstore after CR-C1-002 is merged; owner per T-15 outcome.
```

`digest.sql` (nightly 02:30 NPT [CONV]) for each (tenant_id, source_table, business_date = yesterday NPT): `rows_sha256 = sha256(convert_to(string_agg(<row as canonical JSON text>, E'\n' ORDER BY occurred_at, id), 'UTF8'))`, `chain_digest = sha256(coalesce(prev_digest, '\x'::bytea) || rows_sha256 || convert_to(row_count::text, 'UTF8'))` (the first day of a chain has `prev_digest` NULL, which `coalesce` turns into the empty `bytea`; `convert_to` keeps the whole expression `bytea`, since `bytea || text` would not resolve to `bytea`); re-verifies the last 7 days and increments `lims_ops_audit_digest_mismatch_total` on difference. Late-arriving rows for a closed day (replication lag across midnight) are covered by computing day D at D+1 02:30 and re-verifying through D+7; a re-verification difference caused by a backfill is recorded in `ops_audit` with the backfill reference before the digest is recomputed (never silently).

### 3.5 Assertions (tests `infra/tests/internal/auditstore_roles.sql`)
- `has_table_privilege('audit_writer', 'audit.audit_log', 'UPDATE')` = false; same for DELETE, TRUNCATE on all three tables for `audit_writer`, `audit_digest`, `audit_reader`.
- `audit_reader` has no privilege on schemas `audit`, `billing`, `auditstore_meta`.
- Column list of each replicated table equals the primary's — name, data type and `is_nullable` (`information_schema.columns` comparison, job `auditstore-drift`). Fixture case (08 A29.2 / A28.5): `audit.audit_log.detail` present, `actor_id` and `created_by` nullable on both sides; a replicated maintenance row (actor_id NULL, `detail.maintenance` set) is applied by the subscription and included in that day's digest.

### 3.6 RLS and 08 A16.1
The audit store has no RLS and no policy (§3.1: access is by role, there are no tenant-facing clients), and §4 below defines no policy either, so the A16.1 centre-scope cast (`centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])`) has no occurrence to correct in C1 DDL. C1 creates no table in the application database, so 02-CONVENTIONS ENABLE + FORCE RLS rules apply to C0's DDL, not here.

## 4. Application-DB objects requested from C0 (CR-C1-002)

```sql
-- db/bootstrap/00_roles.sql additions (C0 writes; C1 supplies passwords via the secret store)
CREATE ROLE lims_monitor    LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'lims_monitor_pw';
GRANT pg_monitor TO lims_monitor;
CREATE ROLE lims_replicator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION   NOBYPASSRLS PASSWORD :'lims_replicator_pw';
CREATE ROLE lims_audit_ship LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION   NOBYPASSRLS PASSWORD :'lims_audit_ship_pw';

-- migration <ts>_audit__create_publication_lims_audit_ship.sql (after audit and billing tables exist)
SET LOCAL ROLE lims_owner;
GRANT USAGE ON SCHEMA audit, billing TO lims_audit_ship;
GRANT SELECT ON audit.audit_log, audit.access_log, billing.activity_log TO lims_audit_ship;
CREATE PUBLICATION lims_audit_ship FOR TABLE audit.audit_log, audit.access_log, billing.activity_log
  WITH (publish = 'insert');
```
- RLS: no policy names `lims_audit_ship`; with FORCE RLS a plain `SELECT` by it returns zero rows; it only consumes WAL through the publication (spike T-15 confirms behaviour).
- C0 CI assertion change: `rolreplication` allowed only for `lims_replicator`, `lims_audit_ship`; `rolbypassrls`/`rolsuper` remain forbidden for every `lims_%` role (04 D5).
- `pg_hba.conf` entries for these roles: 02-TRD §7.7.

## 5. DB-level settings C1 owns (summary; values in 02-TRD)
| Area | File | Section |
|---|---|---|
| PostgreSQL parameters (memory, WAL, archiving, slots, logging — incl. `log_parameter_max_length = 0`) | `infra/database/postgresql/zz-lims.conf.j2` → `/etc/postgresql-custom/conf.d/` | 02-TRD §7.7 |
| Client authentication | `infra/database/postgresql/pg_hba.conf.j2` | 02-TRD §7.7 |
| PgBouncer (transaction mode, pool sizes, prepared statements) | `infra/database/pgbouncer/pgbouncer.ini.j2` | 02-TRD §7.6 |
| pgBackRest (repos, encryption, retention, async archive) | `infra/database/pgbackrest/pgbackrest.conf.j2` | 02-TRD §9.2 |
| Standby (`primary_conninfo`, slot, `restore_command`) | `infra/database/standby/standby.conf.j2` | 02-TRD §9.5 |
| Audit store instance | `postgresql.conf` defaults + `max_connections = 50`, `shared_buffers = 4GB`, `log_parameter_max_length = 0` [CONV] | §3 |

## 6. Seed data
None. No synthetic or real data is seeded by C1. Non-prod audit stores receive synthetic rows only through replication from non-prod primaries (CV §11.2).
