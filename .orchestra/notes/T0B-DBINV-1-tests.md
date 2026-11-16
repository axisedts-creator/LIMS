# T0B-DBINV-1 tests (tester)
- File: tests/db/T0B-DBINV-1.inventory.test.mjs (static node:test); run .orchestra/notes/T0B-DBINV-1-verify.cmd or `node --test tests/db/T0B-DBINV-1.inventory.test.mjs`. No SQL run: the lane has no Docker.
- Covers: 2 new rows (owner lims_owner, execute [lims_api], sessions/invitations touches + owner policies, reviewer null); 4 reporting rows execute = lims_api + lims_reporting_lookup (the app.enqueue_job owner-held model); owner listed only for functions it owns; all other rows unchanged (sha256 baseline, 60 rows); T0B-08_inventory.test.sql EXECUTE assertion unchanged, no special-casing.
- Also: DEFINER set of db/migrations == inventory in both directions; gen-isolation-probes --check passes and _registry.sql carries the 2 new rows (writer must regenerate db/tests/isolation/_registry.sql).
- Tester edit: db/tests/identity/T9-A38_platform_set_password.test.sql gets one added relforcerowsecurity assertion (T0B-08.suites requires it for inventory rows with touches).
- Fails now: 2 rows missing, reporting execute = [lims_api], DEFINER-set check, _registry.sql stale rows. Writer needs only the yaml + regenerate probes (no migration/policy/grant change).
- Not provable here: pgTAP tests 1 and 307-310 of T0B-08_inventory.test.sql; founder reruns LIMS_SKIP_GEN=1 bash db/tests/run-suites.sh definers/T0B-08_inventory identity/T9-A38_platform_set_password.
