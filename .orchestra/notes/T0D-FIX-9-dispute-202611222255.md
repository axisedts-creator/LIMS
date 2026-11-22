# T0D-FIX-9 dispute (writer): existing t23 harness is wrong against the contract
- `apps/web/src/features/inventory/__tests__/t23.harness.tsx:130` mocks `GET /v1/inventory/coded-sets/:set` with set = wastage | adjustment | transfer_discrepancy | calibration. contracts/openapi/inventory.yaml `set_name` enum is `uom | reasons | tax_codes`; the reason lists are `/coded-sets/reasons?reason_group=<group>` (the fix9 test pins this, and it is the live 400 cause).
- After the contract fix, 9 t23 tests (bench calibration/discard, stock wastage/adjustment, transfers receive) find empty reason pickers. Not edited (tester-owned).
- Tester fix: in t23.harness, route `/coded-sets/reasons` to `codedSets[url.searchParams.get('reason_group')]` (keep `/coded-sets/:set` for uom/tax_codes).
- Implementation is complete; this is the only item blocking "existing inventory web tests stay green".
