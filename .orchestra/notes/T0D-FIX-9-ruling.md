TESTS_WRONG — t23.transfers.test.tsx:167 pins `GET /coded-sets/transfer_discrepancy`, a path the contract does not define.
Reasons (dispute 2; ruling 1 below still stands):
- contracts/openapi/inventory.yaml:2381-2390: path `set_name` enum is `uom | reasons | tax_codes` only; `/coded-sets/transfer_discrepancy` is a 400 common.validation_failed.
- contracts/openapi/inventory.yaml:2391-2408: `transfer_discrepancy` is a value of query `reason_group`; spec/chunks/C12-inventory/02-TRD.md:265 agrees (set_name ∈ {uom, reasons, tax_codes}; q: reason_group).
- The test title ("coded set transfer_discrepancy") keeps its intent: the reason list for group transfer_discrepancy is fetched. Only the request shape changes. LD-455 rule (1): contract is the truth.
Required test change (tester, apps/web/src/features/inventory/__tests__/t23.transfers.test.tsx:167):
- Replace with: `expect(hit('GET', /coded-sets\/reasons$/).some((h) => new URLSearchParams(h.search).get('reason_group') === 'transfer_discrepancy')).toBe(true);`
Not ruled here: t23.stock.test.tsx:72 "In transit" and t20.alerts are outside this dispute and outside FIX-9 scope; writer must confirm pre-existing on the pre-impl tree and record in notes/T0D-FIX-9-left.md, not change them.

--- Ruling 1 (prior, unchanged) ---
TESTS_WRONG — the t23 harness mocks coded-set paths the contract does not define (set_name = wastage | adjustment | transfer_discrepancy | calibration).
- contracts/openapi/inventory.yaml:2381-2390, 2391-2408, 2453. Harness t23.harness.tsx:130: add `/coded-sets/reasons` route keyed by `reason_group` before the generic route; keep `/coded-sets/:set` for uom and tax_codes only.
