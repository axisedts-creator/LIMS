# CR T0B-GREEN-3 definer-inventory-login-context-worker (nonblocking)
- Raised by: tester, T0B-GREEN-3 (chunk C0-foundation-contracts). Owner of the file: C0 (db/meta/definer-inventory.yaml).
- Finding: db/meta/definer-inventory.yaml row `app.identity_login_context` has `"execute": ["lims_api"]`. Migration 20261116040000_identity__grant_login_context_to_worker.sql (T0B-ASYNC-1, LD-189, LD-277) granted EXECUTE to lims_worker. The inventory was not updated (inventory-vs-grant drift, no new exposure: the grant is the approved one).
- Evidence: db/tests/definers/T0B-08_inventory.test.sql baseline assertion 163 `app.identity_login_context(uuid): EXECUTE for lims_worker is false per the inventory` (have true, want false).
- Test handling: the suite now expects true for exactly that (function, role) pair (cites the migration); all other pairs still equal the inventory.
- Request: lead/writer adds "lims_worker" to the `execute` list of that row (reason: send_recovery job, LD-277); then the one UPDATE line in the test can be removed.
- Blocking: no.
