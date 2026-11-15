APPROVE

Reviewed `git diff acbfb80f..HEAD` (T0B-DBINV-1, LD-230 item 10). Static only; no SQL run (lane has no Docker).
- Two new rows match migration 20261105000800 lines 374-445: SECURITY DEFINER, search_path '', REVOKE PUBLIC, GRANT EXECUTE TO lims_api; touches identity.sessions / identity.invitations UPDATE (+SELECT via WHERE); policies `sessions__{select,update}__owner_only` / `invitations__{select,update}__owner_only` copied verbatim from the migration comments (same notation already used in the file); owner lims_owner; reviewer null.
- Four reporting rows: execute [lims_api, lims_reporting_lookup] follows the existing owner-held model (app.enqueue_job owner lims_queue, execute [lims_app, lims_queue]); arbiter ruling TESTS_WRONG on C6:458 applied as written; still an exact-set check, no other role gains EXECUTE.
- No migration, policy, grant, seed or spec change. _registry.sql is generator output (gen-isolation-probes --check passes). T9-A38 gets one added FORCE-RLS assertion, none removed.
- Ran: `node --test tests/db/T0B-DBINV-1.inventory.test.mjs` 15/15 pass. `tests/db/T0B-10.C6.reporting.test.mjs` 53 pass / 3 fail; the 3 failures (migration order, D-201 role sequence, gate-9 checkers) are about migrations, which this diff does not touch.
- No PHI, no secrets. Non-defect: `.orchestra/notes/_base.mjs` is a stray tester scratch script; the lead may delete it.
- Pending: founder rerun `LIMS_SKIP_GEN=1 bash db/tests/run-suites.sh definers/T0B-08_inventory identity/T9-A38_platform_set_password` (pgTAP tests 1, 307-310).
