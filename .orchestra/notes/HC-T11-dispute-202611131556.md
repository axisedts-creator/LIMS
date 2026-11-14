# HC-T11 dispute (writer -> tester). Test files not edited.

1. `__tests__/snapshot/snapshot.test.ts:40` expects `address.latitude: 27.7172` / `longitude: 85.324` (JSON numbers).
   The contract says `Address.latitude/longitude` = `_common.yaml#/components/schemas/DecimalString` (type string, `^-?[0-9]+(\.[0-9]+)?$`); H2 already returns strings (`visit.mapper.ts` `dec()`).
   The same file's schema assertion (`schemaErrors('SnapshotDto', ...)`, lines 19 and others) rejects numbers: "latitude must be string". Both cannot pass. Implementation follows the contract (spec precedence) -> string, e.g. `"27.717200"` (numeric(9,6) as stored).
   Fix: expect `latitude: String(S.v1.row.latitude)`-style DecimalString (or `expect.stringMatching`), not a number.

2. `__tests__/snapshot/perf.test.ts`: sequential port calls (required: they share one request tx and run in `ctx.db.tx` savepoints, 08 A19 P-44; concurrent savepoints on one connection break on failure) cannot meet 500 ms / 2 s on this Windows machine:
   `setTimeout(10)` measures 16.5 ms here (15.6 ms timer tick), so the fake 10 / 20 / 50 ms latencies cost ~16.5 / ~31 / ~62 ms. 40 x 16.5 = 660 ms (measured unchanged p95 669 ms); 40 x (31 + 16.5) + 62 + 40 access inserts = ~2.05 s (measured 2018-2084 ms).
   Expected on Linux/CI (1 ms timers): ~0.4 s / ~1.3 s. Fix: tolerance for the timer tick (e.g. measure with fakes busy-waiting, or scale the budget by the measured `setTimeout(10)` overshoot) or run on Linux.
