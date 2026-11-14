APPROVE

Re-review of 0c7ca1d..HEAD (review fixes):
- Finding 1 fixed: masters.service.ts:232-239 `listUnits` accepts `is_active` enum true|false|all per contracts/openapi/catalog.yaml, default 'true' (active only); shadowing applied before the filter.
- Finding 2 fixed: masterSets.service.test.ts / masterSets.handlers.test.ts now cover default, 'true', 'false' (incl. shadowing case), 'all', and 400 for 'TRUE'/'yes'/boolean.
- No other callers of listUnits outside T-05 files.
Ran: `vitest run src/modules/catalog` -> 11 files, 1481/1481 pass.

Prior checks (names, global read-only, in-use rule, tenant binding, no PHI/secrets, owned paths) still hold; diff touched only the is_active filter.
Not blocking (carried): T-07 publish must lock cs_value_sets row (FOR UPDATE) to close sort_order-edit race; starter unit `none` display "" vs `Unit.display` minLength 1 (CR candidate).
