TESTS_WRONG — tools/codegen/__tests__/misreports1-openapi.test.ts:62 PINS.consultant.cols still requires net_billed_paisa, which the binding ruling removed.
Reasons:
1. LD-346 (1) (lead decision, binding over spec text for this task, .orchestra/inbox/T0C-MISREPORTS-1-arbiter.md:40): consultant "loses the column net_billed_paisa and sorts by tests_count descending (volume only)"; brief RULING 2 (line 21): "the tester updates the contract test that pins the column".
2. spec/program/08-CR-REGISTER.md:3147 Addendum A39-3: per-referrer money/commission wording only inside two_level_commission and tds; consultant is outside the gate, so a money column there contradicts A39-3 as LD-346 reads it.
3. Implementation already conforms: contracts/openapi/analytics.yaml:3985-3997 has no net_billed_paisa, has tests_count integer, default_sort tests_count desc.
Change to the test (tester only): line 62 -> consultant: { perm: DASH, params: ["referrer_id", "department_id"], cols: { orders_registered: "integer", tests_count: "integer" } }.
Optionally add a negative assertion that consultant has no column named net_billed_paisa and default_sort is { column: tests_count, direction: desc }. Do not delete or skip any case; no yaml change.
