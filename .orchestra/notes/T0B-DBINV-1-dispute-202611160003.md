# T0B-DBINV-1 dispute (writer) — test conflict, needs tester edit
- Conflict: tests/db/T0B-10.C6.reporting.test.mjs:458 asserts `deepEqual([...e.execute], ['lims_api'])` for the four app.reporting_* definers.
  tests/db/T0B-DBINV-1.inventory.test.mjs:67 (this task, LD-230 item 10) asserts execute = ['lims_api','lims_reporting_lookup']. Both cannot pass.
- Why C6:458 is the stale one: LD-230 (10) states lims_reporting_lookup owns these functions and so holds EXECUTE (proacl owner entry), which makes
  pgTAP T0B-08_inventory tests 307-310 fail while the inventory says false. The C6 line encodes the pre-LD-230 model.
- Proposed tester fix (not weaker): C6:458 -> `assert.deepEqual([...e.execute].sort(), ['lims_api','lims_reporting_lookup'], ...)`.
- Writer state: yaml done (2 rows + owner in reporting execute), _registry.sql regenerated; T0B-DBINV-1.inventory.test.mjs 15/15 pass.
- Other tests/db failures (check-migrations partners.manifest_lines GRANT DELETE, migration-order, roles, policy-set) do not read the inventory
  execute field and are outside this task; not caused by this diff (check-registry: ok). Static only, no SQL run (no Docker).
