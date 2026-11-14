-- T0B-05: D-201 window step 1 of 3 (db/meta/decisions/SP-2.md; .orchestra/cr/SP-2.nonblocking.md). Commits CREATE on the database and
-- on schema app to lims_queue so the runner can install graphile_worker on its own direct connection (step 2:
-- PGOPTIONS='-c role=lims_queue' graphile-worker --schema-only ...). Step 3 (20261105001200) creates the wrappers and revokes both.
-- The runner re-runs step 3's revokes if step 2 or 3 fails, so no CREATE stays standing.
SET LOCAL ROLE lims_owner;
DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO lims_queue', current_database()); END $$;
GRANT CREATE ON SCHEMA app TO lims_queue;
