TESTS_WRONG — the t23 harness mocks coded-set paths the contract does not define (set_name = wastage | adjustment | transfer_discrepancy | calibration).
Reasons:
- contracts/openapi/inventory.yaml:2381-2390: path param `set_name` of listInventoryCodedSet is enum `uom | reasons | tax_codes` only; `/coded-sets/wastage` etc. fail validation with 400 common.validation_failed (matches the live evidence: 400 before auth, db_count 0).
- contracts/openapi/inventory.yaml:2391-2408: the reason lists are chosen by query `reason_group` (enum includes wastage, adjustment, transfer_discrepancy, calibration), i.e. `GET /v1/inventory/coded-sets/reasons?reason_group=<group>`.
- contracts/openapi/inventory.yaml:2453: "reasons: reason_group required" confirms reasons are one set keyed by reason_group.
- LD-455 rule (1): contract is the truth; the web side was wrong, and the writer's fix to the web call builder is correct. The harness encodes the old wrong request, so it must follow.
Required test change (tester, apps/web/src/features/inventory/__tests__/t23.harness.tsx:130):
- Add before the generic route: `http.get(`${ORIGIN}/v1/inventory/coded-sets/reasons`, ({ request }) => page(codedSets[new URL(request.url).searchParams.get('reason_group') ?? ''] ?? []))`.
- Keep `/coded-sets/:set` for uom and tax_codes only. Do not weaken any t23 assertion; the 9 affected tests must pass unchanged otherwise.
