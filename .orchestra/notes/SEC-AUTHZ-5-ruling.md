TESTS_WRONG — round-2 ruling item 2 was wrong to keep the "no sensitive field" assertion for a MANAGE caller; fix that one test. Item 1 (imports.commit PRICE_ALL) stands.
1. spec/chunks/C3-catalog-pricing/07-SECURITY.md:132 (S-11): credit-party `pan`/contacts/address are absent only "without `catalog.price_list.manage`". A manage holder is meant to receive them.
2. spec/chunks/C3-catalog-pricing/01-PRD.md:182 (AC-12.4) and 07-SECURITY.md:105 (AB-22) cover the read-only holder (`catalog.price_list.read` without manage). That case is already tested at creditParties.handlers.test.ts:143-158 and in the authz5 matrix.
3. The sibling test at creditParties.handlers.test.ts:173-176 (READ+MANAGE PATCH, `billing_address: 'New Street 5'` returned) agrees with S-11. Test :180-183 contradicts it.
4. contracts/openapi/catalog.yaml:5703-5709: the updateCreditParty x-permission is `catalog.price_list.manage`, so the `[MANAGE]` grant at :181 stays.
Change in `services/api/src/modules/catalog/__tests__/integration/creditParties.handlers.test.ts:180-183`: rename the test to "PATCH by a manage caller -> 200 and the sensitive fields are present (S-11)". Keep the `[MANAGE]` grant. Assert status 200 and `name: 'Renamed'`. Assert that `contact_phone_e164`, `contact_email` and `billing_address` are present, and that `pan` is masked (`'*****6789'`, consistent with :140). Replace `not.toMatch(SECRETS)` with `not.toMatch(/123456789/)`, which checks that the full PAN never leaves.
Implementation stays as is. No widening, no exception row, no CR.


----
LEAD ITEM, LD-420 (2026-11-19):
The only remaining red is tests/security/authz-classification.json being stale against a fresh
run of its own generator, tests/security/classify-authz.mjs. Verified directly: ran the generator
myself and diffed every one of the 87 changed operations against the committed snapshot. Zero
moved to a weaker class; all 87 moved from unguarded (46), guarded-other (29) or stub (12) into
guarded-exact. This is SEC-AUTHZ-4/5's own guard work correctly reducing the unguarded count; the
snapshot is only catching up to already-landed, correct work.

RULING: TESTS_WRONG, snapshot regeneration only, no implementation change, no assertion loosened.
Run node tests/security/classify-authz.mjs from the repo root and write its stdout over
tests/security/authz-classification.json, replacing the file exactly, then commit it. Writer and
debugger may not hand edit this file. Before committing, confirm the diff only moves operations
toward guarded-exact, never toward unguarded, guarded-other, stub or inconclusive; if any
operation instead moved to a weaker class, stop and write a dispute instead of committing.

Reset applied: changes.
