# T0B-TESTIMPORT-1 dispute (writer, 2026-11-18) — 1 stale test outside the import folder
Run 1 of `tests/catalog/T0B-TESTIMPORT-1.pg.sh` (PG17, after the ruling fixes): 110 of 111 files pass, 6074 tests pass, ALL import tests pass. One failure, so runs 2 and 3 never started (`|| return`).

- `services/api/src/modules/catalog/__tests__/testmgmt/boot.test.ts:28-29` (T0B-TESTMGMT-1 test): `expect(operationIds(spec)).toHaveLength(110 + PRICETOOLS.length)` -> `expected [...] to have a length of 117 but got 123`.
- Why the test is wrong, not the code: the 6 extra ids are the T0C-TESTIMPORT-1 contract operations in contracts/openapi/catalog.yaml (merged from main per LD-368). This task must add handlers for them (done_when 1), it cannot remove them. The pin was written before that contract existed, same as the earlier PRICETOOLS merge note on line 20 of that file.
- Line 30 (handlers + pending == spec ids) and line 26 (checkHandlers == []) already pass, so the boot check itself is green.
- Proposed fix (tester): `110 + PRICETOOLS.length + 6` with a comment "T0C-TESTIMPORT-1 added the six import operations (handlers by T0B-TESTIMPORT-1)", or list the 6 import ids as a constant like PRICETOOLS. No assertion dropped.
- After the fix: writer re-runs the full verify (3 runs).
