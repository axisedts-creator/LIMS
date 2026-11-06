# T0A-04 dispute (writer)

Test: `tests/uuidv7/T0A-04.uuidv7.test.mjs` › "counter overflow (>4096 in one ms) advances the timestamp instead of wrapping", line 47 `assert.equal(ts[0], 1_700_000_000_000)`.

Why wrong: the preceding test freezes `Date` at the SAME ms (1_700_000_000_000) and draws 10,000 ids from the module-level `uuidv7()`. Per TRD §3.4 the 12-bit counter overflows and the timestamp is advanced (≥2 ms for 10k ids). The module is imported once per process, so generator state (`lastMs` ≈ now+3..7) carries into the overflow test. Any monotonic implementation must then emit ts[0] > now (emitting `now` again would sort before ids already issued, violating AC-0A-2.1 monotonicity). Observed: `actual 1700000000007, expected 1700000000000`.

Evidence: run alone (`node --test --test-name-pattern=overflow "tests/uuidv7/*.test.mjs"`) it passes; full file 12/13 pass.

Suggested fix (tester): use a fresh frozen ms not used by earlier tests (e.g. `now: 1_800_000_000_000`), or assert `ts[0] >= now` plus `ts[4999] >= ts[0] + 1`.

State: TS impl `packages/shared-ts/src/uuidv7/index.ts` + fixture `packages/test-fixtures/uuidv7/vectors.json` written. Dart `lib/src/uuidv7.dart` NOT written (stopped per brief).
