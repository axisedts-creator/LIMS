-- db/bootstrap/00_roles.sql — C0 05-SCHEMA §1 (CV §5.9; CR-C0-007, CR-C1-002, CR-C6-002; 08 §4.7). AC-0B-1.1, AC-0B-1.2.
-- Run once per cluster by the provisioning superuser (dev: pnpm dev:up; staging/prod: C1 runbook step). Never an app path.
-- psql -v ON_ERROR_STOP=1 -v lims_migrator_pw=... -v lims_api_pw=... -v lims_worker_pw=... -v lims_monitor_pw=...
--      -v lims_replicator_pw=... -v lims_audit_ship_pw=... -v dbname=... -f db/bootstrap/00_roles.sql
-- Passwords come from the secret store (REQ-SEC-128) as psql variables; never literals in this file.
-- lims_migration (C18 loader, CR-C18-001; LD-226): created NOLOGIN with no password and NO lims_app membership (C18 05-SCHEMA s2 PROPOSED EXCEPTION D-136 stays
-- undecided; nothing needs it until the loader runs); the C1 migration-window playbook adds LOGIN and a password later (CR-C18-006). No GoTrue-hook role (08 R10).

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
CREATE ROLE lims_migration  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;   -- C18 loader (LD-226)
GRANT pg_monitor TO lims_monitor;                                        -- CR-C1-002

-- PG16+ membership options: migrator reaches owner/queue/lookup only by explicit SET ROLE; logins inherit lims_app but cannot become it.
GRANT lims_owner     TO lims_migrator WITH INHERIT FALSE, SET TRUE;
GRANT lims_queue     TO lims_migrator WITH INHERIT FALSE, SET TRUE;
GRANT lims_reporting_lookup TO lims_migrator WITH INHERIT FALSE, SET TRUE;
GRANT lims_app       TO lims_migrator WITH INHERIT FALSE, SET TRUE;   -- LD-30 (CR-C0-T0B-09): tenant seeds 010+ SET LOCAL ROLE lims_app
GRANT lims_app   TO lims_api    WITH INHERIT TRUE,  SET FALSE;
GRANT lims_app   TO lims_worker WITH INHERIT TRUE,  SET FALSE;
GRANT lims_queue TO lims_worker WITH INHERIT TRUE,  SET FALSE;

-- per-role session guards (not request context; safe with transaction pooling because they are role defaults)
ALTER ROLE lims_api    SET idle_in_transaction_session_timeout = '30s';   -- [CONV]
ALTER ROLE lims_worker SET idle_in_transaction_session_timeout = '120s';  -- [CONV]
ALTER ROLE lims_api    SET search_path = '';                              -- every query schema-qualified (REQ-SEC-019 spirit)
ALTER ROLE lims_worker SET search_path = '';

-- C18 loader role (LD-226; C18 05-SCHEMA s2 bootstrap part without the password and without the lims_app membership)
ALTER ROLE lims_migration SET search_path = '';
ALTER ROLE lims_migration SET idle_in_transaction_session_timeout = '300s';   -- [CONV] dry-run transactions hold work between port calls
ALTER ROLE lims_migration SET statement_timeout = '30min';                    -- [CONV] set-based validation on 10 M rows
GRANT CONNECT ON DATABASE :"dbname" TO lims_migration;
