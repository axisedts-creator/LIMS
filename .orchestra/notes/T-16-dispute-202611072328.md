TESTS_WRONG — 2 of 202 cases in `services/api/src/modules/catalog/__tests__/integration/creditParties.service.test.ts` cannot be satisfied by a spec-conformant service. The other 200 pass.

1. Line 408 (`REQ-SEC-082 … % and _ in q are literals`) contradicts line 415 (`q of exactly 20 characters is accepted; 21 -> 400`).
   - Line 408 loops `q` over `"'; DROP TABLE catalog.credit_parties; --"` (40 chars) and expects `codes(await list(...))` to equal `[]`, i.e. NOT rejected.
   - Line 415 expects a 21-char `q` to be rejected with 400. The spec says the same: contracts/openapi/catalog.yaml:5248 (`q` maxLength 20) and 02-TRD.md:291 (`q` code prefix only, ≤20).
   - No rule gives 400 for 21 chars and `[]` for 40 chars. Implementation keeps the 20-char limit (spec).
   - Fix: drop the injection string from the loop at 408 or shorten it to ≤20 chars (e.g. `"';DROP TABLE x;--"`, 17 chars). Nothing else changes.

2. Line 606 (`expect(probed.length).toBeGreaterThan(4)`).
   - `probed` = SELECT/UPDATE statements on credit_parties/code_counters across create+get+list+update. The spec flow yields exactly 4: get 1 SELECT, list 1 SELECT, update 1 lock SELECT + 1 UPDATE. create has only INSERTs (counter upsert, party insert), which the filter does not count.
   - `> 4` would force an extra read in create that no spec text requires (the only candidate, "skip taken auto codes", is the unruled CR in .orchestra/cr/T-15.md; adding a query just for the count would be gaming the test).
   - Fix: `toBeGreaterThanOrEqual(4)`. The per-statement tenant_id assertions on lines 607–608 stay and pass.
