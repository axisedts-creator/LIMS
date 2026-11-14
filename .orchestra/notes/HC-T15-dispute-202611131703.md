# HC-T15 dispute (1 test)
- Test: `devadmin/list.test.ts` > "the order is stable: two walks of the same data return the same id sequence" (line 144).
- Result: 66/67 pass (static 6/6, wipe all, list all but this one); fails the same on 3 runs: walk 1 = 96 ids, walk 2 = 103 ids.
- Why the test is wrong, not H16: vitest runs `list.test.ts` and `wipe.test.ts` in parallel on the SAME tenant/DB. `wipe.test.ts` commits new devices (seedDevice) between the two walks, so the second walk sees 7 more rows. The file header itself says rows are shared ("never on totals"), yet line 144 compares whole-tenant id sequences.
- Order is newest-first keyset (registered_at DESC, id DESC); any total order would differ under concurrent inserts. Line 145 (limit 2 vs 200) has the same exposure.
- Fix suggestion (tester): compare only the ids seeded by this file (filter walks to `seedMix().all` ids), or run the devadmin files with `--no-file-parallelism`.
- NOT RUN alone: single-file run needs shell approval (HC_SUITE=...list.test.ts) which was denied here.
