TESTS_WRONG — quote.test.ts:73-75 "none -> tenant_default 500.00" uses world(all), which seeds a centre list for the draft's own centre; the spec requires that list to win.
Reasons:
- spec/program/03-INTERFACE-CATALOG.md:1306: precedence is explicit > credit party > referrer > centre > tenant default. A centre list matching the context centre beats tenant_default.
- helpers.ts:49: centreList seeds PRICE_LIST.a.centre with scopeRefId CENTRE.a (48000). The default draft uses centre_id CENTRE.a, cash, no referrer, so only the centre and tenant_default lists apply. Centre wins (480.00).
- quote.test.ts:54-66 requires priceFor context.centreId === CENTRE.a. quote.test.ts:76-78 expects centre/48000 for the same draft with world({centreList:true}). No implementation can satisfy :73 alongside both of those.
- The referrer and credit lists in `all` don't apply here (no referrer_id, cash mode), so the test's intent ("no applicable list") is only met when no centre list is seeded.
Change in test (line 74 only): call `cbc({}, world())` (no lists) instead of `world(all)`, keeping the expectation tenant_default / money(50000) / PRICE_LIST.a.td.
Alternative fix (equally valid): keep world(all) but use a draft whose centre_id is not CENTRE.a and has no centre list. The first option is simpler.
No implementation change is required for this test.
