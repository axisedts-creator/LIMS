# FD-T05 dispute (writer)
Test: quote.test.ts > "price precedence" > "none -> tenant_default 500.00" (line 73-75). 63/64 DB tests pass; this is the only failure.
- It calls `cbc({}, world(all))` with `all = {centreList, referrerList, creditList}` and the default draft (centre_id = CENTRE.a, cash, no referrer) and expects price_source tenant_default / 500.00.
- `world(all)` adds a centre price list for scopeRefId CENTRE.a (480.00). The draft's centre IS CENTRE.a, so by C3 precedence (credit_party > referrer > centre > tenant_default, 03-IC §4.2) the result is `centre` 480.00. The very next test ("centre list -> centre 480.00 (draft centre)") uses the same centre and expects exactly that.
- The handler passes `context.centreId = draft.centre_id` (required by the test at line 54-66 `c.context.centreId === CENTRE.a`), and the real CatalogPort fake returns `centre` / 48000. Both tests cannot pass against any implementation that passes centreId.
Fix in the test: use `world()` (no lists) for the "none" case, or a draft whose centre has no centre list.
