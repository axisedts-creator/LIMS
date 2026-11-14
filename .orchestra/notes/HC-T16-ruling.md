TESTS_WRONG — the test asserts something the spec does not require (harness defects in anonymise_definer.live.test.ts; the asserted DB contract stays exactly as is)
Change in services/worker/src/jobs/homecollection/__tests__/anonymise_definer.live.test.ts, nothing else:
1. Line 6-7: `superTx` is not exported by hc16.helpers.ts (its exports: hc16.helpers.ts:5,16,31,33,38,65,73); it is exported by hc16.fixtures.ts:5. Import `superTx` from './hc16.fixtures.js' and drop it from the helpers import. The three cases at :36/:44/:145 then really query the catalogue; keep their assertions unchanged.
2. T4 (:115-122): the five `workerTx(...)` promises start eagerly, and later rejections are unhandled until awaited. Make the array hold thunks (`Array<[string, () => Promise<unknown>]>`, `() => workerTx(...)`) and call `await rejects(p())`. Keep all five cases and the `homecollection_anonymise_invalid_input` / unchanged-rows assertions.
Reasons:
- Spec requires T1-T5 as DB-contract cases (spec/chunks/C17-home-collection/05-SCHEMA.md:776-781; 06-IMPLEMENTATION-PLAN.md:39; 07-SECURITY.md:100). Nothing in the spec requires the test to import a missing export or to leave rejections unhandled. Both failures come from the test file, not from HC-T16 code.
- The test fails before the DEFINER/policy DDL is queried, so there is no evidence against the implementation (LD-167: no implementation change without a real HC-T16 failure).
- T4's extra cases (NULL p_before, empty actor id) go beyond 05-SCHEMA.md:780 but agree with its guard (05-SCHEMA.md:739). They are not disputed and stay.
- After the fix, rerun `bash tests/homecollection/HC-T16.pg.sh`. If a catalogue assertion then fails, that is a new and real failure. Rule on it separately.
