-- infra/auditstore/schema.sql (05-SCHEMA s3.4; AC-18.2, AC-18.3). Run ONCE as the instance superuser, connected to the
-- audit-store database, with psql -v ON_ERROR_STOP=1 and the *_pw variables set (role auditstore, stdin \set lines).
-- LD-45: database-agnostic. `full` = database "auditstore" on its own instance (port 5433); `lean`/dev = database
-- "lims_audit" in the SAME cluster as the application database, owned by a role the app cannot use.
-- Later changes only through gen-schema.sh --apply (additive). Source of truth for column lists: the primary's catalog.
-- Subscription owner / RLS outcome of the T-15 spike: DECISION.md.

CREATE ROLE auditstore_owner NOLOGIN;
CREATE ROLE audit_writer     LOGIN PASSWORD :'audit_writer_pw';
CREATE ROLE audit_digest     LOGIN PASSWORD :'audit_digest_pw';
CREATE ROLE audit_reader     LOGIN PASSWORD :'audit_reader_pw';
-- LD-45 lean: roles are cluster-wide and lims_monitor already exists there (CR-C1-002 bootstrap, with pg_monitor).
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lims_monitor') AS auditstore_create_monitor \gset
\if :auditstore_create_monitor
CREATE ROLE lims_monitor     LOGIN PASSWORD :'lims_monitor_pw';
\endif
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

-- [CONV] T-15 additions (DECISION.md):
-- LD-45 lean: the database lives next to the app database, so app roles must not even connect (PUBLIC has CONNECT and
-- TEMP on a new database by default). :"DBNAME" is psql's current-database variable (database-agnostic).
REVOKE CONNECT, TEMPORARY ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO audit_writer, audit_reader, lims_monitor;
GRANT CONNECT, TEMPORARY ON DATABASE :"DBNAME" TO audit_digest;     -- digest.sql uses temp tables
-- Subscription owner = audit_writer (PG 17: CREATE SUBSCRIPTION by a non-superuser needs pg_create_subscription and
-- CREATE on the database; with run_as_owner = true the apply worker inserts as audit_writer, so no table ownership and no
-- membership in auditstore_owner is needed). CREATE on the database gives no privilege on the replicated tables.
GRANT pg_create_subscription TO audit_writer;
GRANT CREATE ON DATABASE :"DBNAME" TO audit_writer;
-- Lag metric (02-TRD s10.3): lims_monitor reads only the two key columns it needs for max(occurred_at).
GRANT USAGE ON SCHEMA audit TO lims_monitor;
GRANT SELECT (tenant_id, occurred_at) ON audit.audit_log TO lims_monitor;
