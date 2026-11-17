# T0A-04 tests (tester)
- TS: `packages/shared-ts/test/uuidv7.test.mjs` — run `node --test "packages/shared-ts/test/*.test.mjs"` (Node strips TS types; impl `packages/shared-ts/src/uuidv7/index.ts` must be a single self-contained file or use `.ts`-suffixed relative imports).
- Dart: `packages/shared-dart/test/uuidv7_test.dart` — run `cd packages/shared-dart && dart test` (impl must add `test` dev_dependency). NOT run here (dart needs approval); expected to fail: no `lib/src/uuidv7.dart`.
- Covers AC-0A-2.1 (10k same-ms order, overflow, shape, isUuidv7 negatives), 2.2 (seed repeat, no wall clock, stepMs), 2.3 (fixture vectors), REQ-SEC-028 (no Math.random).
- ASSUMED unnamed API (spec lists only uuidv7/createSeededUuidv7/uuidv7Timestamp/isUuidv7): `buildUuidv7(unixMs, rand: 10 bytes)` TS+Dart. Layout: b6=0x70|(r0&0x0f), b7=r1, b8=0x80|(r2&0x3f), b9..15=r3..r9.
- ASSUMED fixture `packages/test-fixtures/uuidv7/vectors.json`: `{"vectors":[{name,unixMs,randHex(20 hex),expected}]}`, ≥5 rows incl. RFC 9562 A.6 (`017f22e2-79b0-7cc3-98c4-dc0c0c07398f`), unixMs 0 and 2^48-1. Writer creates it; test cross-checks rows with an independent oracle.
- Not tested: TS/Dart seeded sequences are not compared (seed→xoshiro state expansion unspecified); CSPRNG source is only checked via the Math.random ban.
