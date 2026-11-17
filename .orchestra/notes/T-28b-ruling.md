TESTS_WRONG — `contract/CatalogPort.price.test.ts:32` passes context key `credit_party_id`; the contract key is `creditPartyId`. Change line 32 to `pf(env, O1, { creditPartyId: P1.id }, 'urgent')`. No other change.
Reasons:
1. spec/program/03-INTERFACE-CATALOG.md:1216 — `PriceQuery.context` = `{ priceListId?, creditPartyId?, referrerId?, centreId? }`, camelCase only; mirrored verbatim in contracts/ports/CatalogPort.ts:50.
2. No spec line defines a snake_case alias for PriceQuery.context; the impl must not invent API surface (CLAUDE.md: names verbatim from spec).
3. With an unknown key ignored, precedence (02-TRD §7.4) correctly falls to `tenant_default` / 90_000, so lines 36-37 (`credit_party`, 60_000, surcharge 30_000) cannot hold; line 34's `/tenant/` also matches the value "tenant_default". Both pass once the key is fixed (source becomes `credit_party`).
4. The test's own intent (line 30: output has no snake_case keys) concerns the OUTPUT shape (03-IC:1220 PriceQuote) — unaffected by the fix.
5. Helper `pf` (helpers/t28b.ts:79-80) forwards context unchanged, so the defect is solely in the test call.
