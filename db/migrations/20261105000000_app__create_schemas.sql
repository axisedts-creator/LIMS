-- T0B-02: schemas, USAGE matrix, default privileges (05-SCHEMA §2, verbatim; 08 A25 D-201, R10).
-- Stage 2 of 05-SCHEMA §4.5. Runs inside the migration runner's transaction as lims_migrator (SET LOCAL needs a transaction).
-- graphile_worker (owner lims_queue) and migrations_meta (owner lims_migrator) are NOT created here.
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
-- owned by one of them runs: grant CREATE to the role, SET LOCAL ROLE to it, create, RESET ROLE, SET LOCAL ROLE lims_owner,
-- revoke CREATE, all in that one file (05-SCHEMA §10 "queue wrapper"; C6's lookup migration does the same).
GRANT USAGE ON SCHEMA identity, catalog, frontdesk, billing, lab, instruments, reporting, analytics, quality,
  micro, anatomic, inventory, partners, smartreport, payments, engagement, homecollection TO lims_analytics;

ALTER DEFAULT PRIVILEGES FOR ROLE lims_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE lims_owner REVOKE ALL ON TABLES FROM PUBLIC;
-- Default privileges of lims_queue / lims_reporting_lookup: ALTER DEFAULT PRIVILEGES FOR ROLE r is allowed only to members of r,
-- and lims_owner is not one, so each role sets its own, reached through lims_migrator's SET membership (05-SCHEMA §2):
RESET ROLE;  SET LOCAL ROLE lims_queue;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET ROLE;  SET LOCAL ROLE lims_reporting_lookup;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET ROLE;  SET LOCAL ROLE lims_owner;
