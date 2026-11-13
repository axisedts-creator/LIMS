HC-T12 dispute (writer, post-ruling re-run): 113/114 pass; 1 failure is a test-side defect of the same class as ruling item 2.
- `guards.test.ts:278` asserts `(await mutRows(w)).map((m) => m.device_seq)` toEqual `[1..7]` (numbers). `mutRows` reads `homecollection.mutations` directly via the owner pool; 05-SCHEMA.md:416 declares `device_seq bigint NOT NULL`, and pg returns bigint as string, so received `['1',..,'7']`.
- Spec requires the values 1..7, not JS type number; the implementation cannot change how the test harness's pg client decodes bigint.
- Change: `expect((await mutRows(w)).map((m) => Number(m.device_seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);`
- Evidence: `.orchestra/notes/HC-T12-run.log` lines 37-64 (real PG17 run, 1 failed / 113 passed).
