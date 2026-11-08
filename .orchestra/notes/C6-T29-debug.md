# C6-T29 debugger
Cause: the 2 red node tests (`lookup DEFINERs`, `LD-49 (b)`) read db/migrations/20261105001900_reporting__create_reporting_schema.sql, whose app.reporting_ingest_provider_callback is still the §6.2 version (RETURNS integer, RETURN -1, PERFORM app.enqueue_job, GRANT enqueue_job to lims_reporting_lookup). Not a C6-T29 code bug: handler/service/worker are green (606 + 108).
Fix: needs the in-place migration edit in .orchestra/cr/C6-T29.nonblocking.md (RETURNS uuid, RETURN NULL, drop enqueue_job + its lims_queue grant). db/ is C0-0B ONLY (01-CHUNK-MAP §3), so NOT applied here; tests untouched, no dispute (tests match LD-49 (b)).
Status: blocked until lead routes that CR to C0-0B (T0B-10.C6 follow-up).
