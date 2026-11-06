# T0B-02 impl (writer)
- Files: `db/migrations/20261105000000_app__create_schemas.sql` (05-SCHEMA §2 verbatim: 22 schemas, PUBLIC revoke, USAGE matrix, default privileges incl. lims_queue/lims_reporting_lookup via own SET LOCAL ROLE); `db/migrations/20261105000100_app__create_context_helpers.sql` (05-SCHEMA §10 helpers block verbatim: CV §5.8 helpers, is_staff_or_system, current_lims_session_id + GRANT lims_app/api/worker, is_platform_actor DEFINER + REVOKE PUBLIC/GRANT lims_app, 5 module policy helpers, uuidv7).
- [CONV] helpers file timestamp `20261105000100` (spec names only the schemas file); sorts right after it.
- [CONV] current_lims_session_id GRANT moved from §10 "app helper grants" block into this file (test + A20.2 place it in helpers stage); T0B-03 must not repeat it (harmless if it does).
- EXECUTE on current_claims/current_tenant_id/…/is_staff_or_system for lims_app, lims_queue stays in the §10 "app helper grants" block (T0B-03, with has_all_centres/current_centre_ids). Until then lims_app cannot call them (default privileges revoke PUBLIC).
- Run: `node --test tests/db/T0B-02.schemas-helpers.test.mjs tests/db/T0B-01.bootstrap.test.mjs` → 23/23 pass (after review fix round; review item 1 was test-only, no impl change needed).
- NOT run: pgTAP `db/tests/app/T0B-02_helpers.test.sql` and "applies from empty" — no psql/DB reachable in this lane.
- Open: SET LOCAL needs the runner's transaction wrapper (psql -1 / runner BEGIN).
