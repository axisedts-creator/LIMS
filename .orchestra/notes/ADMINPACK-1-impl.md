# ADMINPACK-1 impl (writer)
Changed: services/api/src/modules/identity/role-packs/role-packs.data.yaml only (copied from spec/program/11-ROLE-MATRIX.data.yaml, bc657dab0; diff = +40 lines, all inside corp_admin +23 and std_admin +17; every other role untouched). LD-254, LD-189: data only.
Tests: api role-packs 475/476 green (data, loader, matrix-replay, escalation, admin-authority); web nav-complete.admin-pack 9/9 green.
The 1 failure is route-guard.test.ts (AppShell regex), not in the gate, unrelated to data (tester note).
[CONV] Whole-file copy of spec data, because role-packs.data.test.ts also asserts the file equals the spec unchanged.
Open: tester's deviation (corp_admin/std_admin hold payments.merchant_config.*, payments.reconciliation.read, inventory.bench.record before R5a) needs lead ruling; apply-role-pack script missing from package.json (founder-steps note).
