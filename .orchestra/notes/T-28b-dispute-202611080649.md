# T-28b dispute (writer)
Test: `contract/CatalogPort.price.test.ts:30-39` "no snake_case keys, no null, no internal columns leak" — the only failing test (84 of 85 pass).
Defect: line 32 calls `pf(env, O1, { credit_party_id: P1.id }, 'urgent')`. `PriceQuery.context` (contracts/ports/CatalogPort.ts:50) and every other test use camelCase `creditPartyId`; the file's own SEAM header says the same. With the snake key the credit-party list is not selected, so the answer is `source: 'tenant_default'`, price 90_000 — not the expected `credit_party` / 60_000 / 30_000 at lines 36-37. Line 34's `/tenant/` regex also matches the value `"tenant_default"`, so it cannot pass in that situation either.
Fix wanted (tester): use `{ creditPartyId: P1.id }` at line 32. Then line 34 passes too (source is `credit_party`).
Not done by writer: accepting snake_case context aliases in `priceFor` would invent API surface beyond the contract (and the REQ-SEC-046 "closed input" stance).
