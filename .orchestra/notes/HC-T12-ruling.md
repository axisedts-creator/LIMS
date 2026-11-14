TESTS_WRONG — the test asserts the JS type `number` for a bigint column read raw from the DB; the spec requires only the values 1..7.
1. `guards.test.ts:278` reads `homecollection.mutations` directly via `mutRows` (owner pool, `__tests__/sync/helpers.ts:221`). 05-SCHEMA.md:416 declares `device_seq bigint NOT NULL`; node-pg returns bigint as a string, so the received value is `['1',..,'7']`. Run log `.orchestra/notes/HC-T12-run.log:37-63` confirms this is the only failure (113/114).
2. The DB value is correct: the spec (05-SCHEMA.md:436 `device_seq >= 1`, ordered per device) requires the sequence 1..7. It does not require a JS type, and the implementation does not control how the test harness's pg client decodes bigint. This is the same class of issue as item 2 of the previous ruling (05-SCHEMA.md:374).
3. Siblings already normalise: `effects.test.ts:206` and `repository/__tests__/repositories.test.ts:347` both wrap the value in `Number(...)`.
Change: `expect((await mutRows(w)).map((m) => Number(m.device_seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);`
Do not touch `guards.test.ts:20`: it asserts the API response body (`results[].device_seq`), not a raw DB row.
No implementation change required. The writer re-runs the tests after the tester applies the fix.
