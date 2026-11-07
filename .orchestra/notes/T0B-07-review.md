APPROVE
# T0B-07 re-review (reviewer)
Checked: `node --test tests/db/T0B-07.registry-checks.test.mjs` 62/62 pass; check-migrations, check-registry, check-fk-dag all `ok` (exit 0) on the lane's real db/.

Prior defects resolved:
1. `db/tools/sql-lib.ts:118` UNCAST_CENTRE now matches the pg_policies-deparsed form (`AS current_centre_ids`, extra parens). Checked with node: deparsed uncast is rejected; deparsed cast `((…))::uuid[]` and hand-written cast are accepted. Fixtures added for both.
2. `db/tools/check-migrations.ts:75` now resolves `ON ALL TABLES IN SCHEMA` and `ALTER DEFAULT PRIVILEGES [IN SCHEMA] … ON TABLES` (no IN SCHEMA = every schema) against C/B/A tables in tables.yaml. Both rejected fixtures added.

Not blocking (still open, as before): the AC-0B-2.3 live pg_policies diff and CI wiring of gate 9 need a DB/workflow (deferred to T0A/T0B-08). The committed db/policies files are hand-copied, so they will differ textually from policy-dump output until regenerated.
